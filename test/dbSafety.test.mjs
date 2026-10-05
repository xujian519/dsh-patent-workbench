/**
 * 批次 2（2026-10-05 深度审计 §3.1 / §3.3 / §3.4）的三条安全网。
 *
 * 这个文件的存在理由：这三条改动的共同点是"平时不可感，出事的那天代价不对称"。
 * 所以每个用例都要能**在实现退化时变红**，而不是断言"代码看起来对"：
 *
 * - §3.1 备份：反向验证"朴素 copy 在这个状态下确实不可信"，否则正向断言是空跑；
 * - §3.1 拒开：构造"业务表在而版本行丢失"的真实坏库，断言拒绝而不是重放迁移；
 * - §3.1 断言：真去篡改 MIGRATIONS 表，断言重复/乱序/与 SCHEMA_VERSION 不一致都会抛；
 * - §3.3 原子性：**故障注入**（代理 db 在最后一步 UPDATE 上抛），断言任务没变成 done、
 *   共享记忆没写、草稿仍是 pending —— 这是"四步拆成四个事务"那个 bug 的直接反例；
 * - §3.4 busy_timeout：起一个**子进程**真的持锁，父进程写入必须**等到**子进程提交后成功；
 *   对照组（没设 busy_timeout 的连接）必须立刻 SQLITE_BUSY —— 对照组证明锁是真的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assertMigrationTable, BUSY_TIMEOUT_MS, freeSnapshotPath, migrate, openWorkbenchDb, snapshotDatabase,
} from '../lib/db/database.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createTask, getTask, submitCompletionDraft, withTransaction } from '../lib/db/repo.js'
import { makeRoutes } from '../lib/api/routes.js'

const AT = '2026-10-05T00:00:00.000Z'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 读一份库文件的 schema_version（拿不到就抛，避免"读不到也算通过"）。 */
function versionOf(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row?.value ?? null
  } finally {
    db.close()
  }
}

function countTasks(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n
  } finally {
    db.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 备份：一致快照
// ─────────────────────────────────────────────────────────────────────────────

test('§3.1 破坏性迁移的备份是**一致快照**：WAL 未截断（另有读快照）时仍含最新事务', () => {
  const dir = tempDir('dsh-b2-snapshot-')
  try {
    const dbPath = join(dir, 'workbench.db')
    // 建库 + 真实数据，然后把版本按回 21（22 与 23 都标了 destructive → 会触发备份）
    const seed = openWorkbenchDb({ dbPath })
    seedDictionaries(seed)
    const before = createTask(seed, { title: '备份前就有的任务', typeCode: 'code_impl', priorityCode: 'p1' })
    assert.ok(before.id)
    seed.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run()
    const liveCountBefore = seed.prepare('SELECT COUNT(*) AS n FROM tasks').get().n
    seed.close()

    /**
     * 制造"WAL 未截断"的真实条件：另一个连接持有读快照，
     * 期间主连接再提交一条事务（这条事务只落在 -wal 里）。
     */
    const writer = new DatabaseSync(dbPath)
    const reader = new DatabaseSync(dbPath, { readOnly: true })
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM tasks').all()
    writer.exec('BEGIN')
    const newest = createTaskIn(writer)
    writer.exec('COMMIT')
    const busyResult = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    /**
     * 这条断言是这个用例的**反空跑保护**：若 checkpoint 不再 busy，
     * 说明"WAL 里留着未截断事务"这个前提不成立，下面的反向验证也就没有意义了。
     */
    assert.equal(busyResult.busy, 1, `另一个连接持读快照时 checkpoint 必须 busy=1（实测 ${JSON.stringify(busyResult)}）`)
    assert.ok(statSync(`${dbPath}-wal`).size > 0, 'WAL 文件里必须还有东西（这就是朴素 copy 会丢的部分）')
    reader.exec('COMMIT')
    reader.close()

    const liveCount = writer.prepare('SELECT COUNT(*) AS n FROM tasks').get().n
    assert.equal(liveCount, liveCountBefore + 1)

    // 反向验证：朴素 copy（旧实现：checkpoint + copyFileSync）在这个状态下**不可信**
    const naive = `${dbPath}.naive-copy`
    copyFileSync(dbPath, naive)
    let naiveFaithful = false
    try {
      naiveFaithful = countTasks(naive) === liveCount
    } catch {
      // 打开就报 "database disk image is malformed" 也算不可信（实测确实会这样）
      naiveFaithful = false
    }
    assert.equal(
      naiveFaithful, false,
      '朴素 copy 在 WAL 未截断时必须不是一份可信快照 —— 若这条断言开始失败，说明 SQLite 行为变了，'
      + '请复核 snapshotDatabase（VACUUM INTO）是否还有必要',
    )

    // 正向：走真实路径（openWorkbenchDb → migrate → 备份）拿到的备份必须**完整**
    const reopened = openWorkbenchDb({ dbPath })
    assert.equal(reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '23', '迁移照常跑完')
    reopened.close()
    writer.close()

    const backups = readdirSync(join(dir, 'backups'))
    assert.equal(backups.length, 1, `该且只该备份一次（实测 ${JSON.stringify(backups)}）`)
    const snapshot = join(dir, 'backups', backups[0])
    assert.equal(versionOf(snapshot), '21', '备份必须停在迁移前')
    assert.equal(countTasks(snapshot), liveCount, '备份里必须有**最新**那条事务（朴素 copy 就是丢在这里）')
    assert.ok(
      existsSync(snapshot) && !existsSync(`${snapshot}-wal`),
      '备份必须是自包含单文件：不依赖随行的 -wal（否则回滚时要连它一起搬，极易漏）',
    )
    const restored = new DatabaseSync(snapshot, { readOnly: true })
    try {
      assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', '快照是自包含的 delete 模式，不挂在 WAL 上')
      assert.ok(restored.prepare('SELECT COUNT(*) AS n FROM dictionaries').get().n > 0)
    } finally {
      restored.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 在已开启的事务里插一条任务（测试内联，避免把 createTask 的 actor/at 语义搬进来）。 */
function createTaskIn(db) {
  return createTask(db, { title: 'WAL 里最新那条任务', typeCode: 'code_impl', priorityCode: 'p1' })
}

test('§3.1 freeSnapshotPath 不覆盖已有文件（同一秒内两次备份会撞名）', () => {
  const dir = tempDir('dsh-b2-freename-')
  try {
    const base = join(dir, 'x-pre-schema21-to-23.db')
    assert.equal(freeSnapshotPath(base), base, '文件不存在时用原名')
    const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
    try {
      snapshotDatabase(db, base)
      assert.equal(freeSnapshotPath(base), `${base}-2`, '已存在时要让位，而不是让 VACUUM INTO 报 output file already exists')
      snapshotDatabase(db, `${base}-2`)
      assert.equal(freeSnapshotPath(base), `${base}-3`)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 坏库：业务表在而版本读不到 → 拒绝打开（不许重放迁移）
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, damage] of [
  ['schema_version 行被删（meta 表还在）', (db) => db.exec("DELETE FROM meta WHERE key = 'schema_version'")],
  ['meta 表整个没了（业务表还在）', (db) => db.exec('DROP TABLE meta')],
]) {
  test(`§3.1 ${name} → 拒绝按"版本 0"重放迁移，且不动用户数据`, () => {
    const dir = tempDir('dsh-b2-badmeta-')
    try {
      const dbPath = join(dir, 'workbench.db')
      const db = openWorkbenchDb({ dbPath })
      seedDictionaries(db)
      const task = createTask(db, { title: '不能被当赌注的任务', typeCode: 'code_impl', priorityCode: 'p1' })
      const knowledge = db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get().n
      // 造坏
      damage(db)
      db.close()

      assert.throws(
        () => openWorkbenchDb({ dbPath }),
        (error) => {
          assert.match(error.message, /不是空库|业务表/, '报错要说清"不是空库"这件事')
          assert.match(error.message, /schema_version/, '报错要指名坏在哪里')
          assert.match(error.message, /backups/, '报错要给出可执行的修复方向')
          return true
        },
      )

      // 数据必须还在（拒绝打开 ≠ 破坏），而且**不许**留下"没有回滚点的迁移尝试"
      const after = new DatabaseSync(dbPath, { readOnly: true })
      try {
        assert.equal(after.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(task.id).n, 1, '任务必须原样还在')
        assert.equal(after.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get().n, knowledge)
      } finally {
        after.close()
      }
      assert.equal(existsSync(join(dir, 'backups')), false, '拒绝打开时不该产生备份目录（没有迁移，也就没有回滚点需求）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('§3.1 真·空库不被误拒（新建库照常建到最新版，且不产生备份）', () => {
  const dir = tempDir('dsh-b2-fresh-')
  try {
    const dbPath = join(dir, 'workbench.db')
    const db = openWorkbenchDb({ dbPath })
    try {
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION))
    } finally {
      db.close()
    }
    assert.equal(existsSync(join(dir, 'backups')), false, '全新库没有可丢的东西，不该备份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 迁移表自身的断言（真有牙：篡改 MIGRATIONS 必须抛）
// ─────────────────────────────────────────────────────────────────────────────

test('§3.1 迁移表断言：重复 / 乱序 / 与 SCHEMA_VERSION 不一致都必须抛', () => {
  assert.doesNotThrow(() => assertMigrationTable(), '真实的迁移表必须自洽')

  const original = [...MIGRATIONS]
  const db = new DatabaseSync(':memory:')
  try {
    // 1) 重复版本号：复制最后一条、只改 up
    MIGRATIONS.push({ version: MIGRATIONS[MIGRATIONS.length - 1].version, name: 'dup', up: () => {} })
    assert.throws(() => assertMigrationTable(), /重复版本号/, '重复版本会被 migrate 的 <= 静默跳过，必须当场拒绝')
    assert.throws(() => migrate(db), /重复版本号/, 'migrate 必须真的调用这条断言（不是只导出一个函数）')
    MIGRATIONS.length = 0
    MIGRATIONS.push(...original)

    // 2) 乱序：把最后两条对调（23 在 22 前面）。**不能**直接 push 一条小版本 ——
    //    那会先撞上"重复版本号"（1..23 全都在），测不到升序这条分支。
    const tail = [MIGRATIONS[MIGRATIONS.length - 2], MIGRATIONS[MIGRATIONS.length - 1]]
    MIGRATIONS[MIGRATIONS.length - 2] = tail[1]
    MIGRATIONS[MIGRATIONS.length - 1] = tail[0]
    assert.throws(() => assertMigrationTable(), /严格升序/, `对调后必须报乱序：${JSON.stringify(MIGRATIONS.slice(-3).map((m) => m.version))}`)
    MIGRATIONS.length = 0
    MIGRATIONS.push(...original)

    // 3) 与 SCHEMA_VERSION 不一致（加了迁移忘了抬版本）
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    MIGRATIONS[MIGRATIONS.length - 1] = { ...last, version: last.version + 1 }
    assert.throws(() => assertMigrationTable(), /SCHEMA_VERSION/)
  } finally {
    MIGRATIONS.length = 0
    MIGRATIONS.push(...original)
    db.close()
  }
  assert.doesNotThrow(() => assertMigrationTable(), '用例结束后迁移表必须恢复原样（否则污染同进程其他测试）')
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 busy_timeout
// ─────────────────────────────────────────────────────────────────────────────

test(`§3.4 openWorkbenchDb 设置 busy_timeout=${BUSY_TIMEOUT_MS}（此前全仓一处都没有，默认 0 = 立刻 SQLITE_BUSY）`, () => {
  const dir = tempDir('dsh-b2-busy-')
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
    try {
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, BUSY_TIMEOUT_MS)
    } finally {
      db.close()
    }
    const memory = openWorkbenchDb({ dbPath: ':memory:' })
    try {
      assert.equal(memory.prepare('PRAGMA busy_timeout').get().timeout, BUSY_TIMEOUT_MS, '内存库同样要设（测试/脚本也会撞并发）')
    } finally {
      memory.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('§3.4 busy_timeout 真的让人**排队等**：持锁方释放后写入成功（对照组立刻失败）', async () => {
  const dir = tempDir('dsh-b2-contend-')
  const dbPath = join(dir, 'w.db')
  try {
    const db = openWorkbenchDb({ dbPath })
    db.exec('CREATE TABLE IF NOT EXISTS busy_probe (note TEXT NOT NULL) STRICT')
    db.close()

    /**
     * 对照组：**没有** busy_timeout 的连接在别人持写锁时立刻失败。
     * 它同时证明"锁是真的被持有了" —— 否则下面的成功断言可能是空跑。
     */
    const heldForControl = holdWriteLock(dbPath, 400)
    await heldForControl.ready
    const raw = new DatabaseSync(dbPath)
    const controlStart = Date.now()
    assert.throws(() => raw.prepare('INSERT INTO busy_probe (note) VALUES (?)').run('control'), /SQLITE_BUSY|database is locked/i)
    const controlElapsed = Date.now() - controlStart
    raw.close()
    assert.ok(controlElapsed < 300, `对照组应当**立刻**失败（实测 ${controlElapsed}ms）`)
    await heldForControl.done

    /** 被测：应用自己的连接（busy_timeout=5000）必须等到持锁方提交，然后写入成功。 */
    const held = holdWriteLock(dbPath, 700)
    await held.ready
    const app = openWorkbenchDb({ dbPath })
    const start = Date.now()
    try {
      app.prepare('INSERT INTO busy_probe (note) VALUES (?)').run('app')
    } finally {
      app.close()
    }
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 400, `应当等到持锁方提交（实测 ${elapsed}ms；若接近 0 说明根本没等，busy_timeout 没生效）`)
    await held.done

    const verify = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM busy_probe WHERE note = 'app'").get().n, 1)
    } finally {
      verify.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 起一个子进程：在 `holdMs` 内持有 `BEGIN IMMEDIATE`（真的持写锁），
 * 就绪后向 stdout 写 `ready`，到点 COMMIT 并退出。
 *
 * 为什么必须用子进程：`node:sqlite` 是**同步** API，同一线程里没有办法
 * "一边持锁、一边等锁" —— 只有另一个进程/线程才能制造真实的锁竞争。
 */
function holdWriteLock(dbPath, holdMs) {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const [dbPath, holdMs] = process.argv.slice(1)
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    db.prepare('INSERT INTO busy_probe (note) VALUES (?)').run('holder')
    process.stdout.write('ready\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs))
    db.exec('COMMIT')
    db.close()
  `
  const child = spawn(process.execPath, ['-e', script, dbPath, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = new Promise((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk)
      if (buffered.includes('ready')) resolve()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (!buffered.includes('ready')) reject(new Error(`持锁子进程还没就绪就退出了（code=${code}）`))
    })
  })
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`持锁子进程异常退出 code=${code}`))
    })
  })
  return { ready, done }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 验收确认：一次验收 = 一个事务
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 故障注入：包一层代理，在**指定的 SQL** 上抛错。
 *
 * 为什么必须这么做：§3.3 的 bug 是"四步拆成四个事务，崩在中间就留下半截状态"。
 * 光断言"正常路径结果正确"完全测不出这件事 —— 必须在第 2~4 步之间制造一次失败，
 * 再看**前面几步有没有留下痕迹**。
 */
function dbFailingOn(realDb, predicate) {
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          if (predicate(sql)) throw new Error(`注入的失败：${sql.slice(0, 60)}`)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function startDraftServer(db) {
  seedDictionaries(db)
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  return server
}

async function confirmDraft(draftId) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  const task = createTask(db, {
    title: '待验收任务', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute',
  })
  const submitted = submitCompletionDraft(db, {
    taskId: task.id, summary: '做完了，这是总结', sessionId: 'sess-1', requireSummary: true,
  })
  assert.equal(submitted.ok, true, `提验收申请应当成功：${JSON.stringify(submitted)}`)
  const draftId0 = submitted.result.draftId

  const server = startDraftServer(draftId === undefined ? db : dbFailingOn(db, (sql) => sql.includes('UPDATE task_drafts SET status_code')))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workbench/drafts/${draftId0}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const body = await res.json()
    return { status: res.status, body, db, taskId: task.id, draftId: draftId0 }
  } finally {
    server.close()
  }
}

test('§3.3 正常路径：确认验收后任务 done + 草稿 confirmed + 写入一条 summary 共享记忆', async () => {
  const { status, body, db, taskId, draftId } = await confirmDraft()
  try {
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(getTask(db, taskId).statusCode, 'done')
    assert.equal(db.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(draftId).status_code, 'confirmed')
    const memories = db.prepare("SELECT COUNT(*) AS n FROM task_memories WHERE task_id = ? AND kind = 'summary'").get(taskId).n
    assert.equal(memories, 1)
  } finally {
    db.close()
  }
})

test('§3.3 崩在最后一步（草稿标 confirmed）→ **整笔回滚**：任务没 done、记忆没写、草稿仍 pending', async () => {
  const { status, db, taskId, draftId } = await confirmDraft('fail-on-status-update')
  try {
    // 路由把仓库抛错统一转成 400（badRequest），这里只关心"没留下半截状态"
    assert.equal(status, 400)
    assert.equal(
      getTask(db, taskId).statusCode, 'doing',
      '任务不许变成 done —— 这一步在旧实现里是**另一个事务**，所以旧代码在这里会是 done',
    )
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM task_memories WHERE task_id = ? AND kind = 'summary'").get(taskId).n, 0,
      '共享记忆不许写进去（旧实现会留下这条，用户重试后还会再多一条）',
    )
    assert.equal(
      db.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(draftId).status_code, 'pending',
      '草稿必须仍是 pending，用户才能重试',
    )
  } finally {
    db.close()
  }
})

test('§3.3 回滚后可以重试：修掉故障再点一次，仍是**一条** summary 记忆', async () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  const task = createTask(db, {
    title: '待验收任务（重试）', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute',
  })
  const submitted = submitCompletionDraft(db, { taskId: task.id, summary: '总结一', sessionId: 's1', requireSummary: true })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const draftId = submitted.result.draftId
  const failing = dbFailingOn(db, (sql) => sql.includes('UPDATE task_drafts SET status_code'))
  await withServer(failing, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/workbench/drafts/${draftId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(res.status, 400)
  })
  await withServer(db, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/workbench/drafts/${draftId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(res.status, 200, await res.text())
  })
  try {
    assert.equal(getTask(db, task.id).statusCode, 'done')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_memories WHERE task_id = ? AND kind = 'summary'").get(task.id).n, 1)
  } finally {
    db.close()
  }
})

async function withServer(db, fn) {
  seedDictionaries(db)
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(port)
  } finally {
    server.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 事务原语
// ─────────────────────────────────────────────────────────────────────────────

test('§3.4 withTransaction：rollback() 回滚、immediate 拿写锁、嵌套不重复 BEGIN', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    db.exec('CREATE TABLE IF NOT EXISTS tx_probe (v INTEGER NOT NULL) STRICT')

    // rollback()：fn 正常返回，但写入不许落库
    const returned = withTransaction(db, (tx) => {
      db.prepare('INSERT INTO tx_probe (v) VALUES (1)').run()
      assert.equal(db.isTransaction, true, 'fn 内必须处在事务里')
      tx.rollback()
      return 'kept'
    })
    assert.equal(returned, 'kept', 'rollback() 之后返回值仍要照常给出')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 0, 'rollback() 的写入必须丢掉')

    // 抛错：整笔回滚（既有语义，别在重构里丢掉）
    assert.throws(() => withTransaction(db, () => {
      db.prepare('INSERT INTO tx_probe (v) VALUES (2)').run()
      throw new Error('boom')
    }), /boom/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 0)

    // immediate：进 fn 时就已经在事务里（拿的是写锁）
    withTransaction(db, () => {
      assert.equal(db.isTransaction, true)
      db.prepare('INSERT INTO tx_probe (v) VALUES (3)').run()
    }, { immediate: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 1)

    // 嵌套：内层不重复 BEGIN，也不误判为回滚
    withTransaction(db, () => {
      withTransaction(db, () => {
        db.prepare('INSERT INTO tx_probe (v) VALUES (4)').run()
      }, { immediate: true })
    }, { immediate: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 2, '嵌套内层的写入必须并入外层事务')

    // 嵌套里请求单独回滚：必须响亮拒绝，不许假装成功
    assert.throws(() => withTransaction(db, () => {
      withTransaction(db, (inner) => { inner.rollback() })
    }), /嵌套事务里不能单独回滚/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 2, '外层仍然提交了它自己的写入')
  } finally {
    db.close()
  }
})

test('§3.4 全仓只有一处 BEGIN 实现（裸 BEGIN 已收敛）', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join: joinPath, relative } = await import('node:path')
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      const full = joinPath(dir, entry)
      statSync(full).isDirectory() ? walk(full, out) : out.push(full)
    }
    return out
  }
  const offenders = []
  for (const file of walk('src')) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const text = readFileSync(file, 'utf8')
    for (const [index, line] of text.split('\n').entries()) {
      if (/'BEGIN/.test(line) && !file.endsWith(joinPath('repo', 'shared.ts'))) {
        offenders.push(`${relative('.', file)}:${index + 1} ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `裸 BEGIN 只允许出现在 withTransaction 里（repo/shared.ts）；实测还有：\n${offenders.join('\n')}`)
  const shared = readFileSync(joinPath('src', 'db', 'repo', 'shared.ts'), 'utf8')
  assert.match(shared, /BEGIN IMMEDIATE/, 'withTransaction 自己必须同时支持立即事务（否则上面那条收敛就没有意义）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 救援脚本：它以前在受支持的 Node 上直接崩（db.backup 不存在）
// ─────────────────────────────────────────────────────────────────────────────

test('救援脚本 reparent-tasks.mjs 能跑完并留下**可打开**的备份（回归：db.backup 在 node22 是 undefined）', async () => {
  const dir = tempDir('dsh-b2-rescue-')
  try {
    const dbPath = join(dir, 'workbench.db')
    const db = openWorkbenchDb({ dbPath })
    const parent = createTask(db, { title: '父任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: '要被挂上去的任务', typeCode: 'code_impl', priorityCode: 'p1' })
    db.close()

    const result = await runScript(['scripts/reparent-tasks.mjs', '--db', dbPath, '--parent', parent.id, '--tasks', child.id])
    assert.equal(result.code, 0, `脚本应当成功退出。stderr:\n${result.stderr}`)
    assert.match(result.stdout, /已备份/)

    const backups = readdirSync(dir).filter((name) => name.includes('.bak-reparent-'))
    assert.equal(backups.length, 1, `备份必须留下（实测 ${JSON.stringify(readdirSync(dir))}）`)
    const backupPath = join(dir, backups[0])
    assert.equal(versionOf(backupPath), String(SCHEMA_VERSION), '备份必须是一份能打开的完整库')

    const after = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(after.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(child.id).parent_id, parent.id)
    } finally {
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 同一类缺陷的姊妹现场：活库备份 / 过期脚本
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这三处是"§3.1 同一 bug 类"的姊妹现场，落地时顺手查出来的：
 * `scripts/knowledge-supersede.mjs`、`scripts/repro/rollback-live-schema.mjs`、
 * `scripts/repro/verify-kind-colors-migration.mjs` 都在**活库**上 `copyFileSync` 主文件当备份/副本。
 */
test('源码扫描：活库备份不许再用「朴素拷贝主文件」（必须走 snapshotDatabase）', async () => {
  const { readFileSync } = await import('node:fs')
  const files = [
    'scripts/knowledge-supersede.mjs',
    'scripts/repro/rollback-live-schema.mjs',
    'scripts/repro/verify-kind-colors-migration.mjs',
    'scripts/reparent-tasks.mjs',
  ]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.match(text, /snapshotDatabase\(/, `${file} 必须用一致快照做备份/副本`)
    const offenders = text.split('\n')
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => /copyFileSync\(\s*(DB|dbPath|LIVE|SOURCE)\b/.test(line))
    assert.deepEqual(
      offenders.map((o) => `${file}:${o.index} ${o.line.trim()}`), [],
      '活库的 WAL 里可能还有没 checkpoint 的事务：只拷主文件会得到「看着健康、实际缺事务」的备份',
    )
  }
})

test('过期脚本 verify-kind-colors-migration：前提成立时真能跑完 9/9，前提不成立时响亮 SKIP', async () => {
  const dir = tempDir('dsh-b2-legacy-')
  try {
    const home = join(dir, 'home')
    const live = join(home, '.dsh', 'workbench', 'workbench.db')
    const mkdirp = (await import('node:fs')).mkdirSync
    mkdirp(join(home, '.dsh', 'workbench'), { recursive: true })

    // 自建 v15 夹具（不能指望线上库还停在 15 —— 这正是这个脚本腐烂的原因）
    const legacy = new DatabaseSync(live)
    legacy.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    for (const migration of MIGRATIONS) {
      if (migration.version > 15) continue
      migration.up(legacy)
      legacy.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(migration.version))
    }
    legacy.close()
    // 出厂字典也要种（否则脚本要改的那几行 `knowledge_kind` 不存在，断言会读 undefined）
    const seeded = new DatabaseSync(live)
    seedDictionaries(seeded)
    seeded.close()

    const passed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/repro/verify-kind-colors-migration.mjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, USERPROFILE: home },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += String(c) })
      child.stderr.on('data', (c) => { stderr += String(c) })
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(passed.code, 0, `v15 夹具上必须真跑完。stderr:\n${passed.stderr}\nstdout:\n${passed.stdout}`)
    assert.match(passed.stdout, /9\/9 通过/, '迁移 16 的颜色回填 9 条断言必须全部通过')

    // 前提不成立（库已经在 18）→ 必须**响亮跳过**，不是抛 JSON 栈
    const newer = new DatabaseSync(live)
    newer.prepare("UPDATE meta SET value = '18' WHERE key = 'schema_version'").run()
    newer.close()
    const skipped = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/repro/verify-kind-colors-migration.mjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, USERPROFILE: home },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += String(c) })
      child.stderr.on('data', (c) => { stderr += String(c) })
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(skipped.code, 2, '前提过期时必须用退出码 2 说"我验不了"')
    assert.match(skipped.stderr, /迁移 16 不会重跑/)
    assert.doesNotMatch(skipped.stderr, /SyntaxError/, '不许把"验不了"伪装成脚本崩了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
