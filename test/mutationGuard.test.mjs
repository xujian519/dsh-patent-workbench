/**
 * 变异护栏（`scripts/lib/mutationGuard.mjs`）单测 —— 审计 §4.3 的核心防线。
 *
 * ## 为什么这里必须起**真子进程**
 *
 * 要证明的是"探针被信号打断时，工作区不会留下变异体"。这件事**只能**在真进程里观测：
 * 在同一个进程里手动调用还原函数，等于在测自己写的那几行，测不到
 * "信号到底有没有被送到、处理器到底有没有机会跑、退出码对不对"。
 * 所以 `SIGTERM` / `SIGINT` / `SIGKILL` / 未捕获异常 / 未处理拒绝 / `exit` 六条路径
 * 都用 `spawn()` 起真进程 + 真信号。
 *
 * ## 一条诚实记录
 *
 * `SIGKILL` **拦不住**（内核直接收走进程，没有任何处理器有机会运行）—— 这条用例
 * 断言的正是"残留确实发生了"，然后用 `recoverCrashedSessions()` 证明**下次启动能恢复**。
 * 把 SIGKILL 也写成"已保护"才是真正的危险。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BACKUP_DIR_RELATIVE, MutationResidueError, backupNameOf, createMutationGuard, defaultIsAlive,
  recoverCrashedSessions,
} from '../scripts/lib/mutationGuard.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/mutationGuardChild.mjs', import.meta.url))
const ORIGINAL = 'original content\n'
const MUTATED = 'MUTATED\n'
const SILENT = { log: () => {}, error: () => {} }

/** 造一个临时工作区（含 `src/a.ts`），返回根目录。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wb-guard-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), ORIGINAL, 'utf8')
  return root
}

const backupDirOf = (root) => join(root, BACKUP_DIR_RELATIVE)
const contentOf = (root) => readFileSync(join(root, 'src', 'a.ts'), 'utf8')
const manifestsOf = (root) => (existsSync(backupDirOf(root)) ? readdirSync(backupDirOf(root)).sort() : [])

/**
 * 起一个真子进程：走完 `--mode`，可选地在"变异体已落盘"之后发一个信号。
 * 返回值包含退出码、信号、输出与**退出后的文件内容**（这才是判据）。
 */
function runChild(root, { mode = 'block', signal = null, label = 'child' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, '--root', root, '--file', 'src/a.ts', '--label', label, '--mode', mode, '--text', MUTATED], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let sent = false
    const send = () => { if (!sent) { sent = true; if (signal !== null) child.kill(signal) } }
    // 等子进程自报"变异体已落盘"，否则可能在写入之前就把信号发出去（测了个空气）。
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes('READY')) setTimeout(send, 30)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    if (signal === null) setTimeout(send, 1000)
    // 兜底：子进程若挂住，10 秒后强杀，绝不让一个用例拖死整份测试。
    const bail = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.on('exit', (code, killedBy) => {
      clearTimeout(bail)
      resolve({ code, signal: killedBy, stdout: stdout.trim(), stderr: stderr.trim(), content: contentOf(root) })
    })
  })
}

function withRoot(fn) {
  const root = makeRoot()
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }))
}

// ── 进程内：stage / write / restore / assertClean / close ───────────────────

test('护栏：stage → write → restore 后逐字节还原，账本从 open 变 closed', () => {
  withRoot((root) => {
    const guard = createMutationGuard({ root, label: 'inproc' })
    const entry = guard.stage(join(root, 'src', 'a.ts'))
    assert.equal(entry.original, ORIGINAL)
    guard.write(join(root, 'src', 'a.ts'), MUTATED)
    assert.equal(contentOf(root), MUTATED)
    assert.equal(guard.inspect().length, 1)
    assert.equal(guard.restore(join(root, 'src', 'a.ts')).ok, true)
    assert.equal(contentOf(root), ORIGINAL)
    assert.deepEqual(guard.inspect(), [])
    guard.close()
    const manifest = JSON.parse(readFileSync(guard.manifestPath, 'utf8'))
    assert.equal(manifest.state, 'closed')
    assert.deepEqual(manifest.entries, [])
  })
})

test('护栏：写入未 stage 的文件直接抛错（不许绕过备份去改工作区）', () => {
  withRoot((root) => {
    const guard = createMutationGuard({ root, label: 'inproc' })
    assert.throws(() => guard.write(join(root, 'src', 'a.ts'), MUTATED), /未 stage/)
  })
})

test('护栏：close() 会把还没还原的改写收回去，并硬断言盘上干净', () => {
  withRoot((root) => {
    const guard = createMutationGuard({ root, label: 'inproc' })
    guard.stage(join(root, 'src', 'a.ts'))
    guard.write(join(root, 'src', 'a.ts'), MUTATED)
    guard.close()
    assert.equal(contentOf(root), ORIGINAL)
  })
})

test('护栏：assertClean() 在仍有改写时抛 MutationResidueError（带漂移明细）', () => {
  withRoot((root) => {
    const guard = createMutationGuard({ root, label: 'inproc' })
    guard.stage(join(root, 'src', 'a.ts'))
    guard.write(join(root, 'src', 'a.ts'), MUTATED)
    assert.throws(() => guard.assertClean(), (error) => {
      assert.ok(error instanceof MutationResidueError)
      assert.deepEqual(error.drift.map((d) => d.file), ['src/a.ts'])
      return true
    })
    guard.restore(join(root, 'src', 'a.ts'))
    assert.equal(guard.assertClean(), true)
  })
})

test('护栏：备份文件名不含分隔符、不会逃出备份目录（SIGKILL 后靠它恢复）', () => {
  assert.equal(backupNameOf('src/client/index.tsx'), 'src__client__index.tsx')
  assert.equal(backupNameOf('lib\\client\\x.js'), 'lib__client__x.js')
  for (const rel of ['a/b', '../evil', 'a\\b', './x']) {
    const name = backupNameOf(rel)
    assert.doesNotMatch(name, /[/\\]/)
    assert.notEqual(name, '..')
  }
})

test('护栏：写入用"临时文件 + rename"，不留下半截源码或临时文件', () => {
  withRoot((root) => {
    const guard = createMutationGuard({ root, label: 'inproc' })
    guard.stage(join(root, 'src', 'a.ts'))
    guard.write(join(root, 'src', 'a.ts'), MUTATED)
    guard.restore(join(root, 'src', 'a.ts'))
    const leftovers = readdirSync(join(root, 'src')).filter((n) => n.includes('.tmp-mutation-'))
    assert.deepEqual(leftovers, [])
  })
})

// ── 真子进程 + 真信号 ───────────────────────────────────────────────────────

test('SIGTERM（门禁超时/Ctrl-C 的常见形态）：退出码 143，工作区已还原', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'block', signal: 'SIGTERM', label: 'term' })
    assert.equal(r.stdout.includes('READY mutated'), true)
    assert.equal(r.code, 143)
    assert.equal(r.content, ORIGINAL)
    assert.match(r.stderr, /收到 SIGTERM/)
  })
})

test('SIGINT（Ctrl-C）：退出码 130，工作区已还原', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'block', signal: 'SIGINT', label: 'int' })
    assert.equal(r.code, 130)
    assert.equal(r.content, ORIGINAL)
    assert.match(r.stderr, /收到 SIGINT/)
  })
})

test('SIGKILL：**拦不住** —— 残留真的会发生（所以才有"下次启动恢复"这条腿）', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'block', signal: 'SIGKILL', label: 'kill' })
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(r.content, MUTATED, 'SIGKILL 之后竟然没残留？那这条判据就不成立了，必须查清楚')
    const manifests = manifestsOf(root)
    assert.ok(manifests.includes('kill.json'), `账本没留下：${manifests.join(', ')}`)
    assert.ok(manifests.includes('src__a.ts'), '原文备份没落盘（那 SIGKILL 就真的救不回来了）')
    assert.equal(readFileSync(join(backupDirOf(root), 'src__a.ts'), 'utf8'), ORIGINAL)
    assert.equal(JSON.parse(readFileSync(join(backupDirOf(root), 'kill.json'), 'utf8')).state, 'open')
  })
})

test('崩溃恢复：SIGKILL 的残留被下一个进程恢复，账本归档留证据且幂等', async () => {
  await withRoot(async (root) => {
    await runChild(root, { mode: 'block', signal: 'SIGKILL', label: 'kill' })
    assert.equal(contentOf(root), MUTATED)
    const first = recoverCrashedSessions({ root, logger: SILENT })
    assert.deepEqual(first.restored.map((r) => r.file), ['src/a.ts'])
    assert.deepEqual(first.damaged, [])
    assert.equal(contentOf(root), ORIGINAL)
    // 证据留档：原账本改名成 .recovered-*，不再有 open 账本
    const names = manifestsOf(root)
    assert.ok(names.some((n) => /^kill\.recovered-.*\.json$/.test(n)), names.join(', '))
    assert.ok(!names.includes('kill.json'))
    // 幂等：再跑一次什么都不做
    const second = recoverCrashedSessions({ root, logger: SILENT })
    assert.deepEqual([second.restored, second.damaged, second.recovered], [[], [], []])
  })
})

test('崩溃恢复：文件已经等于原文 → 只关账本，不当作"需要恢复"', async () => {
  await withRoot(async (root) => {
    // 真子进程：stage → write → restore → 退出（账本仍 open）——
    // 这正是"还原动作做完了、但进程在 close() 之前就没了"的形态。
    await runChild(root, { mode: 'restored', label: 'clean' })
    const manifest = JSON.parse(readFileSync(join(root, BACKUP_DIR_RELATIVE, 'clean.json'), 'utf8'))
    assert.equal(manifest.state, 'open')
    assert.deepEqual(manifest.entries, [])
    const result = recoverCrashedSessions({ root, logger: SILENT })
    assert.deepEqual(result.restored, [])
    assert.deepEqual(result.damaged, [])
    assert.equal(result.recovered.length, 1)
    assert.equal(contentOf(root), ORIGINAL)
    assert.ok(!manifestsOf(root).includes('clean.json'), manifestsOf(root).join(', '))
  })
})

test('崩溃恢复：崩溃之后文件被别人改过 → **不覆盖**，报 damaged 交给人看', async () => {
  await withRoot(async (root) => {
    await runChild(root, { mode: 'block', signal: 'SIGKILL', label: 'kill' })
    writeFileSync(join(root, 'src', 'a.ts'), 'someone else edited this\n', 'utf8')
    const result = recoverCrashedSessions({ root, logger: SILENT })
    assert.deepEqual(result.restored, [])
    assert.equal(result.damaged.length, 1)
    assert.match(result.damaged[0].reason, /未自动恢复/)
    assert.equal(contentOf(root), 'someone else edited this\n', '别人的改动被静默回退了')
    // 账本改成 needs-manual-review，不再反复报同一件事
    const manifest = JSON.parse(readFileSync(join(root, BACKUP_DIR_RELATIVE, 'kill.json'), 'utf8'))
    assert.equal(manifest.state, 'needs-manual-review')
  })
})

test('崩溃恢复：备份文件本身坏了 → 报 damaged，不动目标文件', async () => {
  await withRoot(async (root) => {
    await runChild(root, { mode: 'block', signal: 'SIGKILL', label: 'kill' })
    rmSync(join(root, BACKUP_DIR_RELATIVE, 'src__a.ts'))
    const result = recoverCrashedSessions({ root, logger: SILENT })
    assert.equal(result.restored.length, 0)
    assert.equal(result.damaged.length, 1)
    assert.match(result.damaged[0].reason, /备份文件缺失或哈希不符/)
    assert.equal(contentOf(root), MUTATED)
  })
})

test('崩溃恢复：账本属于**仍在运行**的进程 → 跳过（不抢别人的文件）', () => {
  withRoot((root) => {
    mkdirSync(join(root, BACKUP_DIR_RELATIVE), { recursive: true })
    writeFileSync(join(root, BACKUP_DIR_RELATIVE, 'alive.json'), JSON.stringify({
      label: 'alive', pid: process.pid, state: 'open', entries: [{ file: 'src/a.ts', backup: 'src__a.ts', sha256: 'x', writtenSha256: 'y' }],
    }), 'utf8')
    const result = recoverCrashedSessions({ root, logger: SILENT })
    assert.equal(result.skipped.length, 1)
    assert.deepEqual([result.restored, result.damaged], [[], []])
    assert.equal(defaultIsAlive(process.pid), true)
    assert.equal(defaultIsAlive(999999999), false)
    assert.equal(defaultIsAlive(0), false)
    assert.equal(defaultIsAlive(null), false)
  })
})

test('崩溃恢复：备份目录不存在 → 空结果（干净机器上不能报错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-guard-none-'))
  try {
    const result = recoverCrashedSessions({ root, logger: SILENT })
    assert.deepEqual(result, { recovered: [], restored: [], skipped: [], damaged: [], closedStale: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 其余退出路径（也是真子进程）────────────────────────────────────────────

test('正常 exit 不走 close()：`exit` 兜底照样把工作区还原', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'exit' })
    assert.equal(r.code, 0)
    assert.equal(r.content, ORIGINAL)
  })
})

test('未捕获异常：退出码非 0，工作区已还原', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'uncaught' })
    assert.equal(r.code, 1)
    assert.equal(r.content, ORIGINAL)
    assert.match(r.stderr, /未捕获异常/)
  })
})

test('未处理的 Promise 拒绝：退出码非 0，工作区已还原', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'reject' })
    assert.equal(r.code, 1)
    assert.equal(r.content, ORIGINAL)
    assert.match(r.stderr, /未处理的 Promise 拒绝/)
  })
})

test('探针正常收尾（close）：退出码 0，账本 closed', async () => {
  await withRoot(async (root) => {
    const r = await runChild(root, { mode: 'close', label: 'closer' })
    assert.equal(r.code, 0)
    assert.equal(r.content, ORIGINAL)
    const manifest = JSON.parse(readFileSync(join(root, BACKUP_DIR_RELATIVE, 'closer.json'), 'utf8'))
    assert.equal(manifest.state, 'closed')
  })
})

test('护栏只在 stage() 时才注册信号处理器（import 本身不得改变进程行为）', async () => {
  const moduleUrl = new URL('../scripts/lib/mutationGuard.mjs', import.meta.url).href
  const probe = spawn(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(moduleUrl)});`
    + "process.stdout.write(['SIGTERM','SIGINT','uncaughtException','exit'].map((e) => process.listenerCount(e)).join(''))",
  ], { encoding: 'utf8' })
  let out = ''
  probe.stdout.on('data', (chunk) => { out += chunk.toString() })
  const code = await new Promise((resolve) => probe.on('exit', resolve))
  assert.equal(code, 0, out)
  assert.equal(out.trim(), '0000', `import 期就注册了处理器：${out.trim()}`)
})
