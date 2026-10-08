/**
 * 写入者不得自裁：**草稿确认只能由用户发起**（T5，2026-10-07 灵枢调研 §7）。
 *
 * ## 为什么要有这道守卫
 *
 * 灵枢（dsh-memory）把「谁写的」显式化，这里对应的是专利业务的一条执业红线：
 * **AI 不能替代理人拍板**。草稿确认 = 内容真正入库 = 一次决定，这个动作只能是用户做的。
 * 事后可以从任务事件的 actor 里看出"这条是谁建的"，但**确认这一刻**此前没有任何拦阻点。
 *
 * ## 今天的可达性（诚实记录，别被测试的绿色骗了）
 *
 * 盘点结论：`createDraft()` 的 7 个调用点**全部**是 AI 侧
 * （`src/tools.ts` ×5 个 MCP 工具、`src/db/repo/progress.ts` 的验收提交、以及
 * `POST /api/workbench/drafts` 这条"AI 会话自建知识草稿"的绕行口）。
 * 客户端的建草稿路径**根本不存在**（`DraftBanner` 只 POST confirm/defer/abandon/resume）。
 * 而 4 个 `confirm*Draft()` 的生产调用点**全部**传 `'user'` 或缺省（= `'user'`）。
 *
 * → 所以这道守卫在今天的生产路径上**打不着**，它是**前向守卫**：
 *   谁哪天补上「让 AI 确认」的入口（一个 `workbench_confirm_draft` 工具、
 *   或让 `POST /drafts/:id/confirm` 认调用方身份），谁就会当场撞上它。
 *
 * 本文件要钉的不是"生产上拦住了谁"，而是**这道断言真的会响、而且只在该响的时候响**：
 * 上面那句"打不着"正是靠 `confirm*Draft(db, id, 'ai')` 这个测试面**测出来的可达性**。
 *
 * ## 不做什么
 *
 * 守卫**不改草稿状态、不记 `rejection`**：actor 不对是**调用方的 bug**，
 * 不是"用户驳回了这条草稿"。混进负记忆（`rejectionCount`）会让统计失真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  confirmDailyPlanDraft, confirmKnowledgeDraft, confirmSubtaskPlanDraft, confirmTaskDraft,
  createDraft, createTask, getDraft, getTask, listTasks,
} from '../lib/db/repo.js'

/** 每个用例一个临时库；Windows 上必须先关库再删目录，否则 EPERM 会盖掉真正的失败原因。 */
function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-actor-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try {
    seedDictionaries(db)
    fn(db)
  } finally {
    try { db.close() } catch { /* 已经关过就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

const taskDraft = (db, payloadPatch = {}, input = {}) => createDraft(db, {
  kindCode: 'task',
  sessionId: 'session-ai',
  ...input,
  payload: { title: '守卫用例任务', typeCode: 'personal', priorityCode: 'p3', subtasks: [], ...payloadPatch },
})

test('AI 建的草稿 → AI 确认被拒（红线本体），且草稿仍是 pending', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    assert.throws(() => confirmTaskDraft(db, draft.id, 'ai'), /只能由用户/)
    const after = getDraft(db, draft.id)
    assert.equal(after.statusCode, 'pending', '被拒的确认不能把草稿改成任何终态')
    assert.equal(after.rejectionCount, 0, 'actor 不对不是"用户驳回"，不许写进负记忆')
    assert.equal(listTasks(db).length, 0, '拒绝必须是**事务前**的：一条任务都不许落库')
  })
})

test('AI 建的草稿 → 用户确认照常建单（守卫不误伤正常路径）', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    const result = confirmTaskDraft(db, draft.id)
    assert.equal(result.task.title, '守卫用例任务')
    assert.equal(getDraft(db, draft.id).statusCode, 'confirmed')
  })
})

test('`created_by` 落库：AI 路径建的草稿记 ai（默认值就是 ai —— 漏标记要 fail-closed）', () => {
  withDb((db) => {
    assert.equal(getDraft(db, taskDraft(db).id).createdBy, 'ai', '不传 createdBy 时不许静默当成用户建的')
    assert.equal(getDraft(db, taskDraft(db, {}, { createdBy: 'user' }).id).createdBy, 'user')
  })
})

test('守卫覆盖全部 4 个确认入口（不是只在 task 上加了检查）', () => {
  withDb((db) => {
    const parent = createTask(db, { title: '父任务', typeCode: 'personal', priorityCode: 'p3' })
    const planTask = createTask(db, { title: '计划里的任务', typeCode: 'personal', priorityCode: 'p3' })

    const plan = createDraft(db, { kindCode: 'subtask_plan', sessionId: 's', payload: { parentTaskId: parent.id, subtasks: [{ title: '子任务' }] } })
    assert.throws(() => confirmSubtaskPlanDraft(db, plan.id, 'ai'), /只能由用户/)

    const knowledge = createDraft(db, { kindCode: 'knowledge', sessionId: 's', payload: { title: '经验', contentMd: '正文', kindCode: 'note' } })
    assert.throws(() => confirmKnowledgeDraft(db, knowledge.id, 'ai'), /只能由用户/)

    const daily = createDraft(db, { kindCode: 'daily_plan', sessionId: 's', payload: { planDate: '2026-10-08', summary: '', items: [{ taskId: planTask.id, order: 1, note: '' }] } })
    assert.throws(() => confirmDailyPlanDraft(db, daily.id, 'ai'), /只能由用户/)

    // 四条草稿一条都没被消费掉：守卫放在 withDraftConfirm 里，4 条路共用同一道。
    for (const id of [plan.id, knowledge.id, daily.id]) assert.equal(getDraft(db, id).statusCode, 'pending')

    // 换成用户来确认，4 条都要能走通（否则"守卫"就变成了"永久卡死"）。
    assert.equal(confirmSubtaskPlanDraft(db, plan.id).tasks.length, 1)
    assert.equal(confirmKnowledgeDraft(db, knowledge.id).title, '经验')
    assert.equal(confirmDailyPlanDraft(db, daily.id).planDate, '2026-10-08')
  })
})

test('已确认的草稿：AI 连**回放**都不许触发（守卫在回放分支之前）', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    confirmTaskDraft(db, draft.id)
    assert.throws(() => confirmTaskDraft(db, draft.id, 'ai'), /只能由用户/)
  })
})

test('用户建的草稿：AI 同样不能确认（红线是"AI 不替用户拍板"，不只是"不自裁"）', () => {
  withDb((db) => {
    const draft = taskDraft(db, {}, { createdBy: 'user' })
    assert.throws(() => confirmTaskDraft(db, draft.id, 'ai'), /只能由用户/)
    assert.equal(getTask(db, draft.id), undefined)
  })
})

test('老库的行（`created_by` 为 NULL）不追溯、不误伤：用户确认照旧', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    // 模拟 v25 之前建的行：这一列上线前根本没有值，不能拿"默认 ai"去追溯历史。
    db.prepare('UPDATE task_drafts SET created_by = NULL WHERE id = ?').run(draft.id)
    assert.equal(getDraft(db, draft.id).createdBy, null)
    assert.equal(confirmTaskDraft(db, draft.id).task.title, '守卫用例任务')
  })
})

/**
 * ── 下半场：`at` 形状守卫（与 actor 守卫同在 `withDraftConfirm` 里，生来一对）──
 *
 * 4 个确认入口都是 `(db, draftId, actor = 'user', at = nowIso())`：`actor` 与 `at`
 * **同为 `string` 且相邻**，写反 TypeScript 一声不吭；`confirmTaskDraft` 的第 5 个
 * 参数 `intent` 也是 `string`，忘了传 `at` 时它会顺位掉进 `at`。
 * 两种错的共同后果都是**静默写坏数据**（一串语义文本进了 `updated_at`），所以钉三件事：
 * ① 守卫真的会响；② 响在**事务之前**（一条数据都不许落库）；③ 正常 ISO 时间串不误伤。
 */

test('`at` 位收到非时间串（如 `intent` 顺位掉进来）→ 当场拒绝，且事务前不落库', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    // 漏传 `at`、`intent` 顶上来 —— 这串 'create' 若照单全收，就成了 updated_at。
    assert.throws(() => confirmTaskDraft(db, draft.id, 'user', 'create'), /时间串/)
    assert.equal(listTasks(db).length, 0, '形状不对必须是**事务前**的：一条任务都不许落库')
    assert.equal(getDraft(db, draft.id).statusCode, 'pending', '守卫不改草稿状态')

    // 换成真正的 ISO 串立刻走通 —— 证明拦住的是形状，不是这条草稿本身。
    assert.equal(confirmTaskDraft(db, draft.id, 'user', '2026-10-08T00:00:00.000Z').task.title, '守卫用例任务')
  })
})

test('`at` 守卫覆盖全部 4 个确认入口（不是只在 task 上加了检查）', () => {
  withDb((db) => {
    const planTask = createTask(db, { title: '计划里的任务', typeCode: 'personal', priorityCode: 'p3' })
    const plan = createDraft(db, { kindCode: 'subtask_plan', sessionId: 's', payload: { parentTaskId: planTask.id, subtasks: [{ title: '子任务' }] } })
    const knowledge = createDraft(db, { kindCode: 'knowledge', sessionId: 's', payload: { title: '经验', contentMd: '正文', kindCode: 'note' } })
    const daily = createDraft(db, { kindCode: 'daily_plan', sessionId: 's', payload: { planDate: '2026-10-08', summary: '', items: [{ taskId: planTask.id, order: 1, note: '' }] } })

    assert.throws(() => confirmSubtaskPlanDraft(db, plan.id, 'user', 'soon'), /时间串/)
    assert.throws(() => confirmKnowledgeDraft(db, knowledge.id, 'user', 'soon'), /时间串/)
    assert.throws(() => confirmDailyPlanDraft(db, daily.id, 'user', 'soon'), /时间串/)

    for (const id of [plan.id, knowledge.id, daily.id]) assert.equal(getDraft(db, id).statusCode, 'pending')
  })
})
