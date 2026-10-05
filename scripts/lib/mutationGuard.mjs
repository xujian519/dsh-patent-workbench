/**
 * 变异探针的**还原护栏**：把"探针改写了工作区"从"靠 `finally` 自觉"变成"有账、可查、可恢复"。
 *
 * ## 它挡的是什么
 *
 * 本仓的 4 个 `scripts/repro/probe-*-mutations.mjs` 会把变异体 `writeFileSync` **进工作区**
 * （3 个改 `src/`，1 个只改 `lib/`），跑完在 `finally` 里还原。这条路径有四个漏口：
 *
 * 1. **`SIGINT` / `SIGTERM`**（Ctrl-C、门禁超时杀进程）—— `finally` **不会执行**，变异体留在盘上；
 * 2. **`SIGKILL` / 断电 / 内核 panic** —— 谁都没机会执行（这档只能"下次启动时恢复"，见下）；
 * 3. **构建失败 / 断言失败发生在 `finally` 之前的分支** —— 2026-10-05 本轮**真发生过一次**；
 * 4. **`lib/` 才是随包产物** —— `probe-knowledge-recall-mutations.mjs` **只改 `lib/`**，
 *    残留根本不用再构建一次就会被 `make-archive` 打进去。
 *
 * 后果不是"工作区脏了"，而是：残留的 `src/` 变异体会被下一次 `pnpm build` **烘焙进 `lib/`**，
 * 残留的 `lib/` 变异体**直接就是**要发布的字节。这是唯一一条"门禁自己污染发布产物"的路径。
 *
 * ## 四道防线（按生效时机）
 *
 * | 时机 | 机制 | 覆盖 |
 * |---|---|---|
 * | 写之前 | 原文备份落盘到 `_local-build/mutation-backup/` + `state:open` 的账本 | 所有情况（含 SIGKILL） |
 * | 信号到达 | `SIGINT`/`SIGTERM`/`SIGHUP` 处理器 → 还原 → `exit 128+n` | 可捕获信号 |
 * | 异常/正常退出 | `uncaughtException`/`unhandledRejection`/`exit` → 还原 | JS 层所有退出路径 |
 * | **下次启动** | `recoverCrashedSessions()` 读 `state:open` 的账本 → 恢复 → 留证据 | **SIGKILL / 断电** |
 *
 * 加上 `scripts/release-preflight.mjs` 在整批探针**前后拍工作区指纹**（`workspaceFingerprint.mjs`），
 * "残留"这件事从"希望它别发生"变成"**发生了也一定会被拦下**"。
 *
 * ## 三条不肯让步的细节
 *
 * 1. **恢复不是无脑覆盖**。账本同时记下"原文哈希"与"我们最后写进去的哈希"：
 *    - 当前哈希 == 原文 → 其实已经还回去了，只把账本关掉；
 *    - 当前哈希 == 我们写的 → 是残留，**还原**；
 *    - **两个都不是** → 崩溃之后有人（或另一个工具）动过这个文件 → **不覆盖**，
 *      列为 `damaged` 交给人看。宁可不自动恢复，也不静默回退别人的改动。
 * 2. **写入是"临时文件 + rename"**，不是就地截断。`SIGKILL` 落在写一半的位置时，
 *    盘上要么是完整旧文、要么是完整变异体，**没有第三种**（半截源码最容易骗过人眼）。
 * 3. **账本先落盘、再改文件**。顺序反过来的话，SIGKILL 落在中间就出现"文件已变、账本不知道"。
 *    反过来只会在账本里多一条"其实还没写"—— 那种情况正好命中上面第 1 条的"其实已经还回去了"。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
export const BACKUP_DIR_RELATIVE = '_local-build/mutation-backup'

/** 信号 → 约定的退出码（`128 + n`）：130 = Ctrl-C，143 = SIGTERM。 */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const CAUGHT_SIGNALS = Object.keys(SIGNAL_EXIT_CODES)

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const toPosix = (value) => String(value).split('\\').join('/')

/** 残留（或"该还原却没还原"）时抛的错 —— 单独一个类型，方便调用方分辨"探针失败"与"护栏失败"。 */
export class MutationResidueError extends Error {
  constructor(message, drift) {
    super(message)
    this.name = 'MutationResidueError'
    this.drift = drift
  }
}

/** 备份文件名：把相对路径里的分隔符压成 `__`。同目录同名冲突不存在（相对路径唯一）。 */
export const backupNameOf = (relPath) => toPosix(relPath).replace(/[\\/]/g, '__')

/** 默认的"进程还活着吗"判据：`kill(pid, 0)` 不抛即活着；`EPERM` 也算活着（别人的进程）。 */
export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function atomicWrite(absPath, text) {
  const tmp = `${absPath}.tmp-mutation-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, absPath)
}

const defaultLogger = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
}

/**
 * 创建一个护栏。**lazy 注册信号处理器**（第一次 `stage()` 时）：
 * 只是 `import` 这个模块不得改变进程行为（本仓 `check-lint-directives.mjs` 同规）。
 */
export function createMutationGuard({ root = REPO_ROOT, label = 'probe', backupDir = null, logger = defaultLogger, now = () => new Date() } = {}) {
  const dir = backupDir ?? join(root, BACKUP_DIR_RELATIVE)
  const manifestPath = join(dir, `${label.replace(/[^\w.-]/g, '_')}.json`)
  const entries = new Map()
  const installedHandlers = []
  let handlersInstalled = false
  let closed = false

  const persist = () => {
    mkdirSync(dir, { recursive: true })
    const manifest = {
      label,
      pid: process.pid,
      state: closed ? 'closed' : 'open',
      updatedAt: now().toISOString(),
      entries: [...entries.values()].map((entry) => ({
        file: entry.rel,
        backup: entry.backupName,
        sha256: entry.sha256,
        bytes: entry.bytes,
        writtenSha256: entry.writtenSha256,
      })),
    }
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2))
  }

  const restoreOne = (entry, { forSignal = false } = {}) => {
    try {
      if (!existsSync(entry.abs)) return { file: entry.rel, ok: false, reason: '文件不存在（无法还原）' }
      atomicWrite(entry.abs, entry.original)
      const back = readFileSync(entry.abs, 'utf8')
      if (sha256(back) !== entry.sha256) {
        return { file: entry.rel, ok: false, reason: '还原后哈希不符（还原写入本身可能失败）' }
      }
      entries.delete(entry.abs)
      if (!forSignal) persist()
      return { file: entry.rel, ok: true, reason: '已还原' }
    } catch (error) {
      return { file: entry.rel, ok: false, reason: `还原抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const restoreAll = ({ forSignal = false } = {}) => [...entries.values()].map((entry) => restoreOne(entry, { forSignal }))

  const onSignal = (signal) => {
    const results = restoreAll({ forSignal: true })
    const bad = results.filter((r) => !r.ok)
    logger.error(`\n⚠️ 收到 ${signal}：护栏还原了 ${results.length - bad.length} 个被改写的文件`)
    for (const r of bad) logger.error(`   ❌ ${r.file}：${r.reason}`)
    if (bad.length === 0) logger.error('   工作区已回到变异前的内容（账本保持 open，便于下次复核）')
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1)
  }

  const installHandlers = () => {
    if (handlersInstalled) return
    handlersInstalled = true
    // 逐个**记名**注册，`close()` 时逐个摘 —— 不用 `removeAllListeners`：
    // 那会把探针自己（或测试框架）注册的同名处理器一起摘掉，属于"为了干净而破坏别人"。
    for (const signal of CAUGHT_SIGNALS) {
      const handler = () => onSignal(signal)
      installedHandlers.push(['signal', signal, handler])
      process.on(signal, handler)
    }
    const onUncaught = (error) => {
      const results = restoreAll({ forSignal: true })
      logger.error(`\n⚠️ 未捕获异常：已还原 ${results.length} 个文件`)
      logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
      process.exit(1)
    }
    const onRejection = (reason) => {
      const results = restoreAll({ forSignal: true })
      logger.error(`\n⚠️ 未处理的 Promise 拒绝：已还原 ${results.length} 个文件`)
      logger.error(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
      process.exit(1)
    }
    const onExit = () => { restoreAll({ forSignal: true }) }
    installedHandlers.push(['uncaughtException', 'uncaughtException', onUncaught])
    installedHandlers.push(['unhandledRejection', 'unhandledRejection', onRejection])
    installedHandlers.push(['exit', 'exit', onExit])
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onRejection)
    // 最后一道 JS 层网：正常退出路径也扫一遍（幂等 —— 没 stage 就是空操作）。
    process.on('exit', onExit)
  }

  const removeHandlers = () => {
    for (const [, event, handler] of installedHandlers) process.removeListener(event, handler)
    installedHandlers.length = 0
    handlersInstalled = false
  }

  return {
    label,
    manifestPath,
    backupDir: dir,

    /** 登记一个即将被改写的文件：读原文、落备份、开账本。重复 stage 同一文件是幂等的。 */
    stage(file) {
      installHandlers()
      const abs = resolve(file)
      const cached = entries.get(abs)
      if (cached !== undefined) return cached
      const rel = toPosix(relative(root, abs))
      const original = readFileSync(abs, 'utf8')
      const backupName = backupNameOf(rel)
      mkdirSync(dir, { recursive: true })
      atomicWrite(join(dir, backupName), original)
      const entry = { abs, rel, backupName, original, sha256: sha256(original), bytes: Buffer.byteLength(original), writtenSha256: null }
      entries.set(abs, entry)
      persist()
      return entry
    },

    /** 写入变异体。**必须**先 `stage()`（否则抛错 —— 那会绕过备份，正是要防的事）。 */
    write(file, text) {
      const abs = resolve(file)
      const entry = entries.get(abs)
      if (entry === undefined) throw new Error(`护栏拒绝写入未 stage 的文件：${toPosix(relative(root, abs))}（先调 stage()）`)
      entry.writtenSha256 = sha256(text)
      persist() // 账本先落盘，再改文件（见文件头第 3 条）
      atomicWrite(abs, text)
    },

    /** 还原单个文件（探针的 `finally` 用这个，不要自己 `writeFileSync`）。 */
    restore(file) {
      const abs = resolve(file)
      const entry = entries.get(abs)
      if (entry === undefined) return { file: toPosix(relative(root, abs)), ok: true, reason: '未 stage（无需还原）' }
      return restoreOne(entry)
    },

    restoreAll,

    /** 当前仍有未还原的改写吗？返回漂移列表（空 = 干净）。 */
    inspect() {
      const drift = []
      for (const entry of entries.values()) {
        let current = null
        try { current = readFileSync(entry.abs, 'utf8') } catch { current = null }
        const hash = current === null ? null : sha256(current)
        if (hash !== entry.sha256) drift.push({ file: entry.rel, expected: entry.sha256, actual: hash })
      }
      return drift
    },

    /** 硬断言：只要有未还原的改写就抛 `MutationResidueError`。 */
    assertClean() {
      const drift = this.inspect()
      if (drift.length > 0) {
        throw new MutationResidueError(`${label}：${drift.length} 个文件仍是被改写后的内容`, drift)
      }
      return true
    },

    /** 收尾：还原 → 断言干净 → 关账本 → 摘掉信号处理器。**必须**在探针最后调用。 */
    close() {
      const results = restoreAll()
      const bad = results.filter((r) => !r.ok)
      if (bad.length > 0) {
        throw new MutationResidueError(`${label}：${bad.length} 个文件还原失败`, bad)
      }
      this.assertClean()
      closed = true
      persist()
      removeHandlers()
      return true
    },

    staged() { return [...entries.values()].map((entry) => entry.rel) },
  }
}

/**
 * **崩溃恢复**：读备份目录里 `state:open` 的账本 —— 有它就说明上一次是"没机会执行还原"地死掉的
 * （SIGKILL / 断电 / 内核 panic；能被捕获的信号已经由护栏处理掉了）。
 *
 * 三条判据见文件头"三条不肯让步的细节"第 1 条：原文 / 残留 / **别动**。
 * 恢复过的账本改名成 `<label>.recovered-<时间戳>.json` 留作证据（不删，便于事后复核）。
 */
export function recoverCrashedSessions({ root = REPO_ROOT, backupDir = null, logger = defaultLogger, isAlive = defaultIsAlive, now = () => new Date() } = {}) {
  const dir = backupDir ?? join(root, BACKUP_DIR_RELATIVE)
  const out = { recovered: [], restored: [], skipped: [], damaged: [], closedStale: [] }
  if (!existsSync(dir)) return out

  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const manifestPath = join(dir, name)
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {
      out.damaged.push({ manifest: name, reason: '账本不是合法 JSON' })
      continue
    }
    if (manifest?.state !== 'open') continue
    if (isAlive(manifest.pid)) {
      out.skipped.push({ manifest: name, pid: manifest.pid, reason: '该进程仍在运行，不抢它的文件' })
      continue
    }
    const files = []
    let dirty = false
    for (const entry of manifest.entries ?? []) {
      const abs = join(root, entry.file)
      const backupAbs = join(dir, entry.backup)
      let backupText = null
      try { backupText = readFileSync(backupAbs, 'utf8') } catch { backupText = null }
      if (backupText === null || sha256(backupText) !== entry.sha256) {
        out.damaged.push({ manifest: name, file: entry.file, reason: '备份文件缺失或哈希不符（备份本身坏了）' })
        dirty = true
        continue
      }
      let current = null
      try { current = readFileSync(abs, 'utf8') } catch { current = null }
      const hash = current === null ? null : sha256(current)
      if (hash === entry.sha256) { files.push({ file: entry.file, action: 'already-clean' }); continue }
      if (entry.writtenSha256 !== null && hash === entry.writtenSha256) {
        atomicWrite(abs, backupText)
        const back = sha256(readFileSync(abs, 'utf8'))
        if (back !== entry.sha256) {
          out.damaged.push({ manifest: name, file: entry.file, reason: '还原后哈希不符' })
          dirty = true
          continue
        }
        files.push({ file: entry.file, action: 'restored' })
        out.restored.push({ manifest: name, file: entry.file })
        continue
      }
      // 两个哈希都不是 → 崩溃之后有人动过它。**不覆盖**，交给人看。
      out.damaged.push({
        manifest: name,
        file: entry.file,
        reason: `当前内容既不等于原文、也不等于我们写进去的变异体（崩溃后被别的改动覆盖过）—— 未自动恢复`,
      })
      dirty = true
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const archive = join(dir, `${name.replace(/\.json$/, '')}.recovered-${stamp}.json`)
    try {
      if (dirty) {
        // 有需要人看的项：账本留着（改成 closed，避免每次启动重复报同一件事），证据另行留档。
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, state: 'needs-manual-review', reviewedAt: stamp }, null, 2), 'utf8')
        out.recovered.push({ manifest: name, files })
      } else {
        writeFileSync(archive, JSON.stringify({ ...manifest, state: 'recovered', recoveredAt: stamp }, null, 2), 'utf8')
        rmSync(manifestPath, { force: true })
        out.recovered.push({ manifest: name, files })
      }
    } catch (error) {
      out.damaged.push({ manifest: name, reason: `写恢复证据失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }
  if (out.recovered.length > 0 || out.damaged.length > 0) {
    logger.error(`⚠️ 发现上一次**未能执行还原**的变异探针账本（SIGKILL / 断电）：`)
    for (const r of out.recovered) logger.error(`   🔧 ${r.manifest}：${r.files.map((f) => `${f.file}(${f.action === 'restored' ? '已还原' : '本就干净'})`).join('、') || '无条目'}`)
    for (const d of out.damaged) logger.error(`   ❌ ${d.manifest}${d.file ? ` / ${d.file}` : ''}：${d.reason}`)
  }
  return out
}

/** 供 preflight 打印：把恢复结果压成一行结论。 */
export function describeRecovery(result) {
  const restored = result.restored.length
  const parts = []
  if (restored > 0) parts.push(`已从备份还原 ${restored} 个文件`)
  if (result.damaged.length > 0) parts.push(`❌ ${result.damaged.length} 项需人工确认`)
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} 份账本属于仍在运行的进程（跳过）`)
  return parts.length === 0 ? '没有未收尾的探针账本' : parts.join('；')
}
