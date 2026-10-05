/**
 * 工作区指纹：**变异探针跑前 / 跑后必须逐字节相同**，否则门禁自己污染了发布产物。
 *
 * ## 为什么不能直接用 `git diff --quiet -- src/`
 *
 * 审计（§4.3）建议的判据是 `git diff --quiet -- src/`。它有**两个**在本仓必然误判的问题：
 *
 * 1. **工作区本来就是脏的**：v1.17.0 这一批改动尚未提交，`git diff --quiet -- src/`
 *    在**任何**时刻都会失败 —— 一条永远红的判据等于没有判据（下一个人会把它注释掉）。
 * 2. **`lib/` 才是发布产物**：`package.json` 的 `files` 里是 `lib`，探针里
 *    `probe-knowledge-recall-mutations.mjs` 更**只改 `lib/`**（`src/` 一个字不动）。
 *    只盯 `src/` 会漏掉"改 `lib/` 后直接打包"这条更短的路径 —— 它连再构建一次都不需要。
 *
 * 所以判据改成**跑前拍快照、跑后逐字节比对**（覆盖 `src/` **与** `lib/`）：
 * 与 git 无关，脏工作区同样成立；且它比"工作区没变"更强 —— 它认的是**内容**。
 *
 * ## 唯一的例外，以及为什么它不算"用忽略名单盖住问题"
 *
 * 实测：连续两次 `pnpm build` 产出的 `lib/` 里**只有** `lib/build-info.json` 不同，
 * 差异只有 `generatedAt` 一个字段（墙钟时间）；`buildId` **是内容哈希、两次完全一致**。
 * 所以对这一个文件按"去掉 `generatedAt` 再哈希"处理，并在报告里把它标为
 * `normalized[]`（**显式列出来**，不是静默跳过）。
 *
 * ⚠️ 这条豁免被 `test/workspaceFingerprint.test.mjs` 双向钉住：
 * 只改 `generatedAt` → **不算漂移**；改 `buildId` / `inputs` / 任何别的字段 → **必须算漂移**。
 * 也就是说：被豁免的只有"设计上就是墙钟"的那一个字段，判据本身没有被削弱。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/lib/workspaceFingerprint.mjs --snapshot _local-build/fp-before.json
 * node scripts/lib/workspaceFingerprint.mjs --verify   _local-build/fp-before.json   # 漂移 → exit 1
 * ```
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 默认纳入指纹的目录：`src`（源头）+ `lib`（**随包发布的产物**）。 */
export const FINGERPRINT_DIRS = ['src', 'lib']

/** 需要"归一化后再哈希"的文件（见文件头：只豁免墙钟字段，不豁免判据）。 */
export const NORMALIZED_FILES = ['lib/build-info.json']
export const VOLATILE_JSON_KEYS = ['generatedAt']

const toPosix = (value) => String(value).split(sep).join('/')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * 单个文件的指纹。对 `NORMALIZED_FILES` 里的 JSON，逐个删掉 `VOLATILE_JSON_KEYS`
 * 字段（**只删这些**）再哈希；JSON 解析失败时退回原文哈希（保守：宁可算漂移）。
 */
export function hashFileContent(relPath, content) {
  const posix = toPosix(relPath)
  if (!NORMALIZED_FILES.includes(posix)) return { hash: sha256(content), normalized: false }
  try {
    const parsed = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { hash: sha256(content), normalized: false }
    }
    const kept = {}
    for (const key of Object.keys(parsed).sort()) {
      if (VOLATILE_JSON_KEYS.includes(key)) continue
      kept[key] = parsed[key]
    }
    return { hash: sha256(JSON.stringify(kept)), normalized: true }
  } catch {
    return { hash: sha256(content), normalized: false }
  }
}

/** 递归收集目录下的文件（相对 `root` 的 posix 路径）。目录不存在 → 空（不算错误）。 */
export function collectFiles(root, dir, deps = {}) {
  const read = deps.readdirSync ?? readdirSync
  const stat = deps.statSync ?? statSync
  const out = []
  const walk = (absolute) => {
    let entries
    try { entries = read(absolute, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(absolute, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      out.push(toPosix(relative(root, full)))
    }
    // statSync 只在"目录项类型不可用"的实现里需要；保留注入点便于测试裁剪。
    void stat
  }
  walk(join(root, dir))
  return out.sort()
}

/**
 * 拍一份工作区指纹。
 *
 * @returns `{ dirs, count, digest, files: {relpath: hash}, normalized: [relpath] }`
 */
export function fingerprintWorkspace({ root = REPO_ROOT, dirs = FINGERPRINT_DIRS, deps = {} } = {}) {
  const read = deps.readFileSync ?? readFileSync
  const files = {}
  const normalized = []
  for (const dir of dirs) {
    for (const relPath of collectFiles(root, dir, deps)) {
      const { hash, normalized: isNorm } = hashFileContent(relPath, read(join(root, relPath), 'utf8'))
      files[relPath] = hash
      if (isNorm) normalized.push(relPath)
    }
  }
  const digest = sha256(Object.keys(files).sort().map((key) => `${key}\0${files[key]}`).join('\0'))
  return { dirs: [...dirs], count: Object.keys(files).length, digest, files, normalized: normalized.sort() }
}

/**
 * 比对两份指纹。返回漂移列表（空 = 逐字节相同）。
 * `kind`: `changed`（内容变了）/ `added`（多出文件）/ `removed`（文件没了）。
 */
export function diffFingerprints(before, after) {
  const keys = [...new Set([...Object.keys(before.files ?? {}), ...Object.keys(after.files ?? {})])].sort()
  const drift = []
  for (const key of keys) {
    const a = before.files?.[key]
    const b = after.files?.[key]
    if (a === undefined) drift.push({ kind: 'added', path: key, before: null, after: b })
    else if (b === undefined) drift.push({ kind: 'removed', path: key, before: a, after: null })
    else if (a !== b) drift.push({ kind: 'changed', path: key, before: a, after: b })
  }
  return drift
}

/** 人读的漂移报告（前 `limit` 条，其余折叠成一行计数 —— 别把整棵树的差异刷进日志）。 */
export function formatDrift(drift, limit = 12) {
  const head = drift.slice(0, limit).map((d) => {
    const label = d.kind === 'changed' ? '内容变了' : d.kind === 'added' ? '多出文件' : '文件没了'
    return `   ❌ ${label}：${d.path}`
  })
  if (drift.length > limit) head.push(`   … 另有 ${drift.length - limit} 处`)
  return head.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// CLI（`--snapshot` / `--verify`）：供 release-preflight 与人工复核共用
// ───────────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2)
  const valueOf = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null
  }
  const snapshotPath = valueOf('--snapshot')
  const verifyPath = valueOf('--verify')
  if (snapshotPath === null && verifyPath === null) {
    console.error('用法：node scripts/lib/workspaceFingerprint.mjs --snapshot <file.json> | --verify <file.json>')
    return 2
  }
  if (snapshotPath !== null) {
    const fp = fingerprintWorkspace()
    mkdirSync(dirname(resolve(snapshotPath)), { recursive: true })
    writeFileSync(resolve(snapshotPath), JSON.stringify(fp, null, 2), 'utf8')
    console.log(`已拍快照：${snapshotPath}（${fp.count} 个文件，digest ${fp.digest.slice(0, 16)}）`)
    console.log(`   归一化豁免（只去 ${VOLATILE_JSON_KEYS.join('/')}）：${fp.normalized.join(', ') || '（无）'}`)
    return 0
  }
  let before
  try { before = JSON.parse(readFileSync(resolve(verifyPath), 'utf8')) } catch (error) {
    console.error(`❌ 读不了快照 ${verifyPath}：${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const after = fingerprintWorkspace()
  const drift = diffFingerprints(before, after)
  if (drift.length === 0) {
    console.log(`✅ 工作区与快照逐字节相同（${after.count} 个文件，digest ${after.digest.slice(0, 16)}）`)
    return 0
  }
  console.error(`❌ 工作区相对快照有 ${drift.length} 处漂移（变异探针没还原干净？）`)
  console.error(formatDrift(drift))
  return 1
}

// 只在被直接执行时走 CLI（被 import 时不得有副作用 —— 本仓 `check-lint-directives.mjs` 同规）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv))
}
