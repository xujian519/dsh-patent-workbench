/**
 * D02：迁移 19 与任务仓储的进度读写（AX-P01、AX-D02、AX-P06 的仓储部分）。
 *
 * ## 为什么这个文件自己搭一个 v18 库
 *
 * 验收要求的是"**18→19** 迁移幂等、旧任务进度 0、旧计划合法项回填、坏数据保留诊断"。
 * 用 `openWorkbenchDb()` 只能拿到"一路迁到最新"的库，**测不出迁移本身的兼容性**；
 * 所以这里显式按迁移表逐版本升到 18，塞入老格式数据，再跑 19。
 * 迁移只碰内存库（`:memory:`）—— 绝不拿用户真库试迁移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { openWorkbenchDb, migrate } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  createTask, getDailyPlan, getTask, listPendingCompletions, listTaskEvents, setTaskProgress,
  submitCompletionDraft, updateTask,
} from '../lib/db/repo.js'

/** 建一个"装了 18 个迁移"的内存库（不含 19），供兼容性测试用。 */
function openV18Db() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

/**
 * 把库退回到 v18 语义：先按迁移升到 19 再手工删列做不到（SQLite 删列受限），
 * 所以反过来做 —— 从空库**只跑 < 19 的迁移**，再写 meta。
 */
function openLegacyDb(upTo = 18) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}

const AT = '2026-09-30T00:00:00.000Z'

function insertLegacyTask(db, { id, title, statusCode = 'todo', estimatedMinutes = null, archived = 0, source = 'manual', parentId = null, description = null, typeCode = 'code_impl' }) {
  db.prepare(`
    INSERT INTO tasks (id, parent_id, title, description, type_code, status_code, priority_code, ai_policy_code,
      due_at, all_day, estimated_minutes, source, workspace_path, archived, extra,
      created_at, updated_at, completed_at, cancelled_at)
    VALUES (?, ?, ?, ?, ?, ?, 'p1', 'consult', NULL, 0, ?, ?, NULL, ?, '{}', ?, ?, NULL, NULL)
  `).run(id, parentId, title, description ?? '', typeCode, statusCode, estimatedMinutes, source, archived, AT, AT)
}

function insertLegacyPlan(db, planDate, itemsJson, sourceCode = 'ai') {
  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, summary, items_json, source_code, session_id, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, NULL, ?, ?)
  `).run(`plan-${planDate}`, planDate, itemsJson, sourceCode, AT, AT)
}

// ---------------------------------------------------------------------------
// AX-P01：18 → 19
// ---------------------------------------------------------------------------

test('迁移 19：旧任务（含 done）一律 progress=0，原字段不变，二次 migrate 无变化', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 't-todo', title: '待办', statusCode: 'todo' })
    insertLegacyTask(db, { id: 't-doing', title: '进行中', statusCode: 'doing', estimatedMinutes: 600 })
    insertLegacyTask(db, { id: 't-done', title: '已完成', statusCode: 'done' })
    const before = db.prepare("SELECT * FROM tasks WHERE id = 't-doing'").get()

    migrate(db)

    assert.equal(SCHEMA_VERSION, 23)
    for (const id of ['t-todo', 't-doing', 't-done']) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      assert.equal(row.progress_percent, 0, `${id} 的旧进度必须是 0（不反推）`)
    }
    const after = db.prepare("SELECT * FROM tasks WHERE id = 't-doing'").get()
    /**
     * 除新列外，原字段逐字不变（防止迁移"顺手"改写别的字段）。
     *
     * ⚠️ 阶段 4 · E 片的迁移 22 会**删掉** recurrence 四列，所以这四列在这里的"不变"
     * 应当表现为"已消失"而不是"值相同" —— 判据跟着意图走，不是放宽：
     * 它本来要说的是"没有任何迁移**改写**已有数据"，删列不是改写。
     */
    const droppedByMigration22 = new Set(['recurrence_code', 'recurrence_rule', 'recurrence_master_id', 'recurrence_last_generated'])
    for (const key of Object.keys(before)) {
      if (droppedByMigration22.has(key)) {
        assert.ok(!(key in after), `字段 ${key} 已被迁移 22 删除，不该还在`)
        continue
      }
      assert.deepEqual(after[key], before[key], `字段 ${key} 不应被迁移改动`)
    }

    // 幂等：再跑一次 migrate 不报错、数据不变。
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all())
    migrate(db)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all()), snapshot)
  } finally {
    db.close()
  }
})

test('迁移 19：CHECK(progress_percent BETWEEN 0 AND 99) 是最后一道防线', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    assert.equal(task.progressPercent, 0, '新建任务默认 0')
    assert.throws(
      () => db.prepare('UPDATE tasks SET progress_percent = 100 WHERE id = ?').run(task.id),
      /CHECK/i,
      '库里绝不允许出现 100（它是提交完成验收的触发值，不是进度）',
    )
    assert.throws(
      () => db.prepare('UPDATE tasks SET progress_percent = -1 WHERE id = ?').run(task.id),
      /CHECK/i,
    )
  } finally {
    db.close()
  }
})

test('迁移 19：ai_session_scope/persona 字典就位，且不重复插入', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    migrate(db)
    const row = db.prepare("SELECT * FROM dictionaries WHERE kind = 'ai_session_scope' AND code = 'persona'").get()
    assert.ok(row, 'persona scope 字典必须存在（S11 角色绑定复用 ai_session_registry）')
    assert.equal(row.active, 1)
    // 幂等：migrate 再跑一次不会插第二条（version 已到 19 不会再执行 up）
    migrate(db)
    const count = db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'ai_session_scope' AND code = 'persona'").get()
    assert.equal(count.n, 1)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// AX-D02：旧计划 JSON 回填
// ---------------------------------------------------------------------------

test('迁移 19：旧计划合法项回填 minutes 快照 / effortDone=false，保留顺序与备注、未知任务保留', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 'task-est', title: '有估时', estimatedMinutes: 90 })
    insertLegacyTask(db, { id: 'task-noest', title: '无估时' })
    db.prepare("INSERT INTO meta (key, value) VALUES ('default_estimate_minutes', '45')").run()
    insertLegacyPlan(db, '2026-09-29', JSON.stringify([
      { taskId: 'task-est', order: 1, title: '有估时', note: '先做这个' },
      { taskId: 'task-noest', order: 2, title: '无估时', note: '' },
      { taskId: 'deleted-task', order: 3, title: '任务已删除但项要保留', note: '别丢' },
      { taskId: 'task-est', order: 4, title: '已有合法值', note: '', minutes: 25, effortDone: true },
    ]))

    migrate(db)

    const plan = getDailyPlan(db, '2026-09-29')
    assert.equal(plan.items.length, 4, '坏数据/未知任务一律不得被删')
    assert.deepEqual(plan.items.map((item) => item.order), [1, 2, 3, 4], '顺序逐字保留')
    assert.equal(plan.items[0].minutes, 90, '缺 minutes 用该任务当时的合法估时')
    assert.equal(plan.items[0].effortDone, false)
    assert.equal(plan.items[0].title, '有估时', '原字段保留')
    assert.equal(plan.items[0].note, '先做这个')
    assert.equal(plan.items[1].minutes, 45, '任务没有估时 → 设置里的默认投入')
    assert.equal(plan.items[2].minutes, 45, '未知 taskId 保留项，minutes 走默认（不猜、不删）')
    assert.equal(plan.items[2].title, '任务已删除但项要保留')
    assert.equal(plan.items[3].minutes, 25, '已有合法 minutes 不覆盖')
    assert.equal(plan.items[3].effortDone, true, '已有合法 effortDone 不覆盖')

    // 幂等：第二次 migrate 不再改动
    const snapshot = JSON.stringify(getDailyPlan(db, '2026-09-29').items)
    migrate(db)
    assert.equal(JSON.stringify(getDailyPlan(db, '2026-09-29').items), snapshot)
  } finally {
    db.close()
  }
})

test('迁移 19：坏 JSON / 非数组 / 坏项**原串保留**并输出带 planDate 的诊断', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 'ok-task', title: '正常任务', estimatedMinutes: 30 })
    insertLegacyPlan(db, '2026-09-28', '{这不是 JSON')
    insertLegacyPlan(db, '2026-09-27', '{"taskId":"ok-task"}')
    insertLegacyPlan(db, '2026-09-26', JSON.stringify(['不是对象', { taskId: 'ok-task', order: 1, title: '正常项' }]))

    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    try {
      migrate(db)
    } finally {
      console.warn = originalWarn
    }

    // 坏 JSON：原串一个字节都不动（读取端据此报"计划数据无法解析"，而不是假装 0）
    const broken = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-28'").get()
    assert.equal(broken.items_json, '{这不是 JSON')
    const notArray = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-27'").get()
    assert.equal(notArray.items_json, '{"taskId":"ok-task"}')
    // 坏项：**原串照样留在库里**（一个字节不动），读取端把它折成诊断而不是当成一项计划
    const rawMixed = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-26'").get()
    assert.equal(rawMixed.items_json, JSON.stringify(['不是对象', { taskId: 'ok-task', order: 1, title: '正常项', minutes: 30, effortDone: false }]), '迁移只做加法，坏项原样留在数组里')
    const mixed = getDailyPlan(db, '2026-09-26')
    assert.equal(mixed.readable, true)
    assert.equal(mixed.items.length, 1, '坏项不进 items（但会在 diagnostics 里点名）')
    assert.equal(mixed.items[0].taskId, 'ok-task')
    assert.equal(mixed.items[0].minutes, 30)
    assert.equal(mixed.items[0].effortDone, false)
    assert.ok(mixed.diagnostics.some((text) => text.includes('第 1 项不是对象')), '坏项必须留下可读诊断（不静默丢件）')

    const joined = warnings.join('\n')
    assert.match(joined, /2026-09-28/, '诊断必须带 planDate')
    assert.match(joined, /2026-09-27/)
    assert.match(joined, /2026-09-26/)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// 仓储层：setTaskProgress（AX-P02 的存储侧 / AX-P06 的回退语义）
// ---------------------------------------------------------------------------

test('setTaskProgress: 0–99 写入成功；同值幂等（不写事件、不刷新 updatedAt）', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const first = setTaskProgress(db, task.id, 75, 'ai', '2026-09-30T10:00:00.000Z', '推进了一半多')
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    assert.equal(getTask(db, task.id).progressPercent, 75)

    const eventsAfterFirst = listTaskEvents(db, task.id)
    const updated = eventsAfterFirst.find((event) => event.event_code === 'updated' && event.actor === 'ai')
    assert.ok(updated, '写进度必须留一条 updated 事件')
    assert.deepEqual(JSON.parse(updated.before_json), { progressPercent: 0 })
    assert.deepEqual(JSON.parse(updated.after_json), { progressPercent: 75 })
    assert.equal(updated.note, '推进了一半多')

    // 同值重复提交：状态 200 语义、但不重复写事件、不刷新 updatedAt
    // （比的是**写入之后**的快照：`task` 是创建时的对象，updatedAt 还是建任务那一刻）
    const afterFirst = getTask(db, task.id)
    assert.equal(afterFirst.updatedAt, '2026-09-30T10:00:00.000Z', '写入时会带上新 updatedAt')
    const same = setTaskProgress(db, task.id, 75, 'ai', '2026-09-30T11:00:00.000Z')
    assert.equal(same.ok, true)
    assert.equal(same.changed, false)
    assert.equal(same.alreadyAt, 75)
    assert.equal(getTask(db, task.id).updatedAt, afterFirst.updatedAt, '同值不得刷新 updatedAt')
    assert.equal(listTaskEvents(db, task.id).length, eventsAfterFirst.length, '同值不得追加事件')
  } finally {
    db.close()
  }
})

test('setTaskProgress: 非法值 / 越界 / 100 一律拒绝且**无部分写入**', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    setTaskProgress(db, task.id, 30)
    const before = getTask(db, task.id)
    const eventCount = listTaskEvents(db, task.id).length

    for (const bad of [-1, 100, 101, 1.5, '50', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = setTaskProgress(db, task.id, bad)
      assert.equal(result.ok, false, `${String(bad)} 必须被拒`)
      assert.match(result.error, /^错误：/, '错误要给用户看的中文')
    }
    const after = getTask(db, task.id)
    assert.equal(after.progressPercent, 30, '拒绝时不得改动进度')
    assert.equal(after.updatedAt, before.updatedAt, '拒绝时不得刷新 updatedAt')
    assert.equal(listTaskEvents(db, task.id).length, eventCount, '拒绝时不得写事件')
  } finally {
    db.close()
  }
})

test('setTaskProgress: 不存在 / 已归档 / done / cancelled 拒绝，不重开任务', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    assert.match(setTaskProgress(db, 'nope', 10).error, /不存在/)

    const done = createTask(db, { title: '已完成', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'done' })
    assert.match(setTaskProgress(db, done.id, 50).error, /已完成/)
    const cancelled = createTask(db, { title: '已取消', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'cancelled' })
    assert.match(setTaskProgress(db, cancelled.id, 50).error, /已取消/)
    const archivedTask = createTask(db, { title: '已归档', typeCode: 'code_impl', priorityCode: 'p1' })
    updateTask(db, archivedTask.id, { archived: true })
    assert.match(setTaskProgress(db, archivedTask.id, 50).error, /已归档/)

    // 四个都被拒 → 状态一点没动
    assert.equal(getTask(db, done.id).statusCode, 'done')
    assert.equal(getTask(db, cancelled.id).statusCode, 'cancelled')
    assert.equal(getTask(db, archivedTask.id).progressPercent, 0)
  } finally {
    db.close()
  }
})

test('setTaskProgress: 驳回/暂存不回退进度；验收通过后原进度保留；级联不改祖先/后代显式值', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const parent = createTask(db, { title: '父', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute' })
    const child = createTask(db, { title: '子', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id, statusCode: 'doing' })
    setTaskProgress(db, parent.id, 60)
    setTaskProgress(db, child.id, 20)

    // 提交验收 → 驳回：草稿被丢弃，但进度不回退
    const submitted = submitCompletionDraft(db, { taskId: parent.id, summary: '做完了', sessionId: 's-1', requireSummary: true })
    assert.equal(submitted.ok, true)
    db.prepare("UPDATE task_drafts SET status_code = 'abandoned' WHERE id = ?").run(submitted.result.draftId)
    assert.equal(getTask(db, parent.id).progressPercent, 60, '驳回不回退进度')

    // 验收通过（模拟确认路径）→ 级联完成后代，但显式进度一个都不改
    db.prepare("UPDATE task_drafts SET status_code = 'pending' WHERE id = ?").run(submitted.result.draftId)
    db.prepare("UPDATE tasks SET status_code = 'done', completed_at = ? WHERE id IN (?, ?)").run(AT, parent.id, child.id)
    assert.equal(getTask(db, parent.id).progressPercent, 60, '完成不重置进度')
    assert.equal(getTask(db, child.id).progressPercent, 20, '级联不改后代的显式值')
    // done 任务不画进度条这件事由 projectProgress 管（见 progress.test.mjs），这里只验库值保留
  } finally {
    db.close()
  }
})

test('listPendingCompletions: 一次查询给出全部待验收；deferred 仍算待验收；驳回后不再出现', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const a = createTask(db, { title: 'A', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const b = createTask(db, { title: 'B', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    assert.deepEqual(listPendingCompletions(db), { available: true, items: [] })

    const draftA = submitCompletionDraft(db, { taskId: a.id, summary: 'A 完成', sessionId: null, requireSummary: false })
    const draftB = submitCompletionDraft(db, { taskId: b.id, summary: 'B 完成', sessionId: null, requireSummary: false })
    assert.equal(draftA.ok, true)

    // B 暂存：语义上**仍是待验收**（只是不自动弹窗）
    db.prepare('UPDATE task_drafts SET deferred_at = ? WHERE id = ?').run(AT, draftB.result.draftId)
    const pending = listPendingCompletions(db)
    assert.equal(pending.items.length, 2)
    assert.equal(pending.items.find((item) => item.taskId === b.id).deferred, true)
    assert.equal(pending.items.find((item) => item.taskId === a.id).deferred, false)

    // 驳回（草稿置 abandoned）后不再出现
    db.prepare("UPDATE task_drafts SET status_code = 'abandoned' WHERE id = ?").run(draftA.result.draftId)
    const afterReject = listPendingCompletions(db)
    assert.deepEqual(afterReject.items.map((item) => item.taskId), [b.id])

    // 同一任务重复提交只留一条 pending（不出现两份待验收）
    submitCompletionDraft(db, { taskId: b.id, summary: 'B 完成（修订）', sessionId: null, requireSummary: false })
    assert.equal(listPendingCompletions(db).items.filter((item) => item.taskId === b.id).length, 1)
  } finally {
    db.close()
  }
})

/**
 * 迁移 21：容量功能删除后的 meta 键收拾（决策 4）。
 *
 * 为什么必须有这条：这个迁移动的是**用户看不见的键**，写错了不会崩，只会静默地
 * 把用户的选择丢掉 —— 那正是最难发现的一类失败。两条都必须钉住：
 * 改名要**搬走值**（而不是删旧键让开关回落到缺省 false），删键要真删。
 */
test('迁移 21：daily_capacity_include_overdue 改名成 plan_include_overdue（值照搬），daily_capacity_minutes 删除', () => {
  const db = openLegacyDb(20)
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES ('daily_capacity_include_overdue', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
    db.prepare("INSERT INTO meta (key, value) VALUES ('daily_capacity_minutes', '555') ON CONFLICT(key) DO UPDATE SET value = '555'").run()

    migrate(db)

    const meta = new Map(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]))
    assert.equal(meta.get('plan_include_overdue'), '1', '用户的选择必须被搬到新键上（不是回落到缺省 false）')
    assert.equal(meta.has('daily_capacity_include_overdue'), false, '旧键必须消失（否则两个键各有各的口径）')
    assert.equal(meta.has('daily_capacity_minutes'), false, '容量读数已不存在，这个键没有任何读取方')
    assert.equal(meta.get('schema_version'), '23', 'migrate 一律跑到最新版（迁移 21 之后还有 22 / 23）')

    // 幂等：再跑一次不报错、内容不变
    const snapshot = JSON.stringify(db.prepare('SELECT key, value FROM meta ORDER BY key').all())
    migrate(db)
    assert.equal(JSON.stringify(db.prepare('SELECT key, value FROM meta ORDER BY key').all()), snapshot)
  } finally {
    db.close()
  }
})

test('迁移 21：两个键同时存在时也不因 UNIQUE 冲突而炸（OR REPLACE 的用意）', () => {
  const db = openLegacyDb(20)
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES ('daily_capacity_include_overdue', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
    db.prepare("INSERT INTO meta (key, value) VALUES ('plan_include_overdue', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
    migrate(db)
    const meta = new Map(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]))
    assert.equal(meta.get('plan_include_overdue'), '1', '旧键带值搬过来（用户在原开关上做过的选择优先）')
    assert.equal(meta.get('schema_version'), '23', 'migrate 一律跑到最新版（迁移 21 之后还有 22 / 23）')
  } finally {
    db.close()
  }
})

/**
 * 迁移 22（阶段 4 · E 片）：把前四片删掉代码后留在库里的东西一并清掉。
 *
 * 这条测试刻意**造出老库状态**（四张表、recurrence 四列、16 行出厂字典都还在），
 * 因为"删干净"最容易骗人的地方是：删了代码但忘了迁库，于是新库没有、老库还有，
 * 而所有测试都是在**新库**上跑的（全绿）。
 */
test('迁移 22：四张废表 + tasks 的 recurrence 四列与两个索引全部消失，16 行出厂字典转停用', () => {
  /** 迁移 22 要停用的 16 行（与 schema.ts 里那张表逐字对应）。 */
  const RETIRED = [
    ['idea_kind', 'spark'], ['idea_kind', 'random'], ['idea_kind', 'plugin'], ['idea_kind', 'project'], ['idea_kind', 'skill'],
    ['draft_kind', 'idea_cluster'], ['draft_kind', 'idea_tasks'], ['draft_kind', 'report'],
    ['ai_session_scope', 'day_report'], ['ai_session_scope', 'week_report'],
    ['ai_session_scope', 'idea_association'], ['ai_session_scope', 'idea_brainstorm'],
    ['recurrence', 'none'], ['recurrence', 'daily'], ['recurrence', 'weekly'], ['recurrence', 'monthly'],
  ]
  const tableNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  const taskColumns = () => db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)
  const indexNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name)

  const db = openLegacyDb(21)
  try {
    // 老库的出厂字典：这批 code 已从 seed.ts 移除，所以显式种回来模拟"老库就是有这些行"
    const insert = db.prepare(`INSERT OR IGNORE INTO dictionaries
      (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, '{}', 1, 1, 10, ?, ?)`)
    for (const [kind, code] of RETIRED) insert.run(kind, code, code, AT, AT)
    insert.run('draft_kind', 'daily_plan', '今日计划', AT, AT)
    insert.run('ai_session_scope', 'daily_plan', '今日计划会话', AT, AT)

    // 迁移前：四表与 recurrence 列确实在（否则下面"消失"的断言是空跑）
    for (const table of ['ideas', 'idea_clusters', 'idea_links', 'task_reports']) {
      assert.ok(tableNames().includes(table), `老库该有表 ${table}`)
    }
    for (const column of ['recurrence_code', 'recurrence_rule', 'recurrence_master_id', 'recurrence_last_generated']) {
      assert.ok(taskColumns().includes(column), `老库该有列 ${column}`)
    }
    assert.deepEqual(indexNames().filter((name) => name.startsWith('idx_tasks_recurrence')).length, 2)

    migrate(db)

    for (const table of ['ideas', 'idea_clusters', 'idea_links', 'task_reports']) {
      assert.ok(!tableNames().includes(table), `表 ${table} 必须消失`)
    }
    for (const column of ['recurrence_code', 'recurrence_rule', 'recurrence_master_id', 'recurrence_last_generated']) {
      assert.ok(!taskColumns().includes(column), `列 ${column} 必须消失（不留永远为空的列）`)
    }
    assert.deepEqual(indexNames().filter((name) => name.startsWith('idx_tasks_recurrence')), [], '两个 recurrence 索引必须消失')
    // 别的索引不许被顺手删掉（DROP COLUMN 的连带影响只该落在 recurrence 上）
    assert.ok(indexNames().includes('idx_tasks_status'), '无关索引不受影响')

    const inactive = db.prepare('SELECT kind, code FROM dictionaries WHERE active = 0').all()
      .map((row) => `${row.kind}:${row.code}`).sort()
    assert.deepEqual(inactive, RETIRED.map(([kind, code]) => `${kind}:${code}`).sort(), '这 16 行必须停用（不多不少）')
    for (const [kind, code] of [['draft_kind', 'daily_plan'], ['ai_session_scope', 'daily_plan']]) {
      assert.equal(db.prepare('SELECT active FROM dictionaries WHERE kind = ? AND code = ?').get(kind, code).active, 1,
        `${kind}:${code} 仍在用（日报计划），必须保持 active=1`)
    }
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '23')

    // 幂等：再跑一次不报错（DROP 都带 IF EXISTS / 列有存在性判断）
    migrate(db)
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '23')
  } finally {
    db.close()
  }
})

/**
 * D4「迁移前自动备份」：破坏性迁移（`destructive: true`）跑之前必须留下**可用**的回滚点。
 *
 * 为什么这条必须验"备份能打开、且停在迁移前的版本"：
 * 只断言"backups/ 里多了一个文件"会漏掉 WAL 那个经典坑 —— WAL 模式下未 checkpoint 的
 * 事务还在 `.db-wal` 里，直接拷 `.db` 会得到一个**缺最近事务**的备份，文件在、
 * 大小也对，回滚时才发现少了数据。所以这里真开备份库读 schema_version。
 */
test('破坏性迁移前自动整库备份：openWorkbenchDb 先写一份停在旧版本的备份，再跑迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-backup-'))
  try {
    const dbPath = join(dir, 'workbench.db')
    const first = openWorkbenchDb({ dbPath })
    // 先写入一批真实数据：备份里必须**有**它们，否则下面那条 WAL 反向验证是空跑
    seedDictionaries(first)
    /**
     * 模拟"用户的库停在 21，插件已升到最新版"。22 与 23 **都是**破坏性迁移
     *（22 DROP 表/列，23 改写任务描述），所以这一次备份要覆盖到最上面那个待跑的版本号。
     */
    first.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run()
    first.close()

    const second = openWorkbenchDb({ dbPath })
    assert.equal(second.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '23', '迁移照常跑完')
    second.close()

    const backups = readdirSync(join(dir, 'backups'))
    assert.equal(backups.length, 1, `该且只该备份一次（实测 ${JSON.stringify(backups)}）`)
    assert.match(backups[0], /^workbench-\d{8}-\d{6}-pre-schema21-to-23\.db$/, '文件名要能自证"哪次迁移、从哪版到哪版"（到**最上面**那个待跑的破坏性版本）')

    const restored = new DatabaseSync(join(dir, 'backups', backups[0]))
    try {
      assert.equal(restored.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '21', '备份必须停在迁移前')
      // WAL 坑的反向验证：备份里必须**有**建库之后写入的数据（不是一份缺事务的空壳）
      assert.ok(restored.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'type'").get().n > 0, '备份里要有真实数据')
    } finally {
      restored.close()
    }

    // 到了最新版后再开：没有待跑的破坏性迁移 → 不许再备份（否则 backups/ 会被每次开库刷爆）
    const third = openWorkbenchDb({ dbPath })
    third.close()
    assert.equal(readdirSync(join(dir, 'backups')).length, 1, '非破坏性路径不该重复备份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移 22 配套：seedDictionaries 不再种 recurrence 出厂行（新库不留永远选不到的选项）', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'recurrence'").get().n, 0)
    // 日报计划的两个 code 必须还在（它们是"亲戚"，不是被删的那批）
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'draft_kind' AND code = 'daily_plan'").get().n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'ai_session_scope' AND code = 'daily_plan'").get().n, 1)
    // 已删功能的 code 一个都不许被种回来
    for (const [kind, code] of [['draft_kind', 'report'], ['idea_kind', 'spark'], ['ai_session_scope', 'day_report']]) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dictionaries WHERE kind = ? AND code = ?').get(kind, code).n, 0,
        `${kind}:${code} 不该再被出厂种入`)
    }
  } finally {
    db.close()
  }
})

test('openWorkbenchDb 全新库即 schema 23，且旧客户端省略 progressPercent 仍可读写', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    assert.equal(Number(version.value), 23)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    // 老调用点（不带 progressPercent 的 patch）照常工作，进度保持原值
    setTaskProgress(db, task.id, 40)
    const updated = updateTask(db, task.id, { title: '改了标题' })
    assert.equal(updated.progressPercent, 40, 'title 变更不得顺手抹掉进度')
    assert.equal(updated.title, '改了标题')
  } finally {
    db.close()
  }
})

/**
 * 迁移 23（阶段 6 · bridge 收口）：把 bridge 遗留的任务树归档并标注。
 *
 * 造的是**真实形态**：两个 `source='patent'` 根（bridge 建的"案件"）+ 它们的 L1–L5 子任务，
 * 外加一条**用户自己**挂在阶段子任务下的普通任务（只归档根会留下"父已归档、子还在"的孤儿）。
 */
test('迁移 23：bridge 任务树整体归档 + 追加标注 + 留 system 事件；非 bridge 任务一个字节不动', () => {
  const db = openLegacyDb(22)
  try {
    insertLegacyTask(db, { id: 'case-a', title: 'CN2026-0001', source: 'patent', typeCode: 'patent_case', statusCode: 'doing' })
    insertLegacyTask(db, { id: 'case-a-l1', title: 'L1 交底书理解', source: 'patent', typeCode: 'patent_stage_l1', parentId: 'case-a', statusCode: 'done' })
    insertLegacyTask(db, { id: 'case-a-l2', title: 'L2 现有技术检索', source: 'patent', typeCode: 'patent_stage_l2', parentId: 'case-a', statusCode: 'todo' })
    // ⚠️ 用户自己加的（source 是 manual）：只归档 `source='patent'` 会在它身上留下孤儿
    insertLegacyTask(db, { id: 'user-sub', title: '补一份检索记录', source: 'manual', parentId: 'case-a-l2', statusCode: 'todo' })
    insertLegacyTask(db, { id: 'plain', title: '普通任务', source: 'manual', statusCode: 'todo', description: '我的原文' })

    migrate(db)

    const rows = new Map(db.prepare("SELECT id, archived, description, status_code FROM tasks").all().map((row) => [row.id, row]))
    for (const id of ['case-a', 'case-a-l1', 'case-a-l2', 'user-sub']) {
      assert.equal(rows.get(id).archived, 1, `${id} 必须归档（含用户自建子任务，否则会变成孤儿）`)
    }
    assert.equal(rows.get('case-a-l2').status_code, 'todo', '只归档，不改状态（追溯链靠它）')
    assert.match(rows.get('case-a').description, /已由案卷接管/, '根任务要带标注')
    assert.match(rows.get('user-sub').description, /已由案卷接管/, '用户自建子任务也要带标注（它同样被归档了）')
    assert.equal(rows.get('plain').archived, 0, '非 bridge 任务不许被动')
    assert.equal(rows.get('plain').description, '我的原文', '非 bridge 任务的描述一个字节不动')

    const events = db.prepare("SELECT task_id, actor, note FROM task_events WHERE actor = 'system'").all()
    assert.equal(events.length, 4, '每个被归档的任务留一条 system 事件（4 条）')
    assert.ok(events.every((row) => /已由案卷接管/.test(row.note)), '事件备注要说清为什么')

    // patent_* 字典**不许**被停用：这 4 条任务的 type_code 指着它
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind='type' AND code LIKE 'patent%'").get().n, 0,
      'legacy 库里本来没有这些字典项 —— 但这句要提醒：迁移 23 不许去动字典（下面用真实字典再验一次）')

    // 幂等：再跑一次不叠标注、不重复写事件
    const before = db.prepare('SELECT id, description FROM tasks ORDER BY id').all()
    migrate(db)
    assert.deepEqual(db.prepare('SELECT id, description FROM tasks ORDER BY id').all(), before, '二次迁移不许改任何描述')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE actor = 'system'").get().n, 4, '事件也不许重复写')
  } finally {
    db.close()
  }
})

test('迁移 23：patent_* 类型字典保持可用（停用会让归档任务显示成英文码）', () => {
  const db = openLegacyDb(22)
  try {
    // 造出 bridge 当年种下的那两行字典（active=1）
    const insert = db.prepare(`INSERT OR IGNORE INTO dictionaries (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
      VALUES ('type', ?, ?, '{}', 0, 1, 5, ?, ?)`)
    insert.run('patent_case', '专利案件', AT, AT)
    insert.run('patent_stage_l1', 'L1 交底书理解', AT, AT)
    insertLegacyTask(db, { id: 'case-b', title: 'CN2026-0002', source: 'patent', typeCode: 'patent_case' })

    migrate(db)

    assert.equal(db.prepare("SELECT active FROM dictionaries WHERE kind='type' AND code='patent_case'").get().active, 1, '字典必须仍然可用')
    assert.equal(db.prepare('SELECT archived FROM tasks WHERE id = ?').get('case-b').archived, 1)
  } finally {
    db.close()
  }
})

/**
 * M17：`schema_version` 是脏值时**拒绝打开**，不许当成 0。
 *
 * ## 为什么这是一条安全断言而不是洁癖
 *
 * 旧实现 `Number(row.value)` 对非数字串给 `NaN`，而 `migration.version <= NaN` 恒为 false
 * —— 于是**全部迁移从第一个重放**。在已有数据的库上重放：撞"表已存在"则插件彻底起不来，
 * 若建表语句带 IF NOT EXISTS 则静默跑完并把版本号写成最新（看上去一切正常）。
 * 两种结果都不是"用户手滑改了一个 meta 值"该付的代价。
 */
test('schema_version 是脏值 → 拒绝打开（不许当 0 重放全部迁移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-badversion-'))
  try {
    const dbPath = join(dir, 'workbench.db')
    const first = openWorkbenchDb({ dbPath })
    seedDictionaries(first)
    first.prepare("UPDATE meta SET value = 'not-a-number' WHERE key = 'schema_version'").run()
    first.close()

    assert.throws(
      () => openWorkbenchDb({ dbPath }),
      /schema_version 不是合法版本号/,
      '脏版本号必须当场报错并说清原因，而不是把迁移重放一遍',
    )

    // 负数同样是脏值（`1 <= -5` 为假 → 一样会重放）
    const second = openWorkbenchDb({ dbPath: ':memory:' })
    try {
      second.prepare("UPDATE meta SET value = '-1' WHERE key = 'schema_version'").run()
      assert.throws(() => migrate(second), /schema_version 不是合法版本号/)
    } finally {
      second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
