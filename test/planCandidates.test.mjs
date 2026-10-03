/**
 * 当日候选判定（AX-C01 / AX-C02 / §5.2）—— 「今天该做什么」的**唯一判定**。
 *
 * 这个文件是"上一版 `capacity.test.mjs`"的继任者：容量账本已随容量功能删除
 * （2026-10-03 决策 4），但候选判定本身完整保留（AI 智能排序与手动添加都在用它），
 * 它原来那批最有价值的断言 —— 长任务在推进、继承截止、日界两端、脏有效截止、
 * 归档/done 不进候选 —— 一条都没少。
 *
 * 两条纪律：
 * 1. **夹具只有一份**（`test/fixtures/planCandidatesFixture.mjs`）；
 * 2. 断言打**两条路径**：共享纯函数（`lib/shared/dailyPlanPolicy.js`）与客户端接线
 *    （`lib/client/dailyPlanCandidates.js`）。接线只许做形状转换，结果必须完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_A,
  PLAN_DAY_END,
  PLAN_DAY_START,
  PLAN_EXPECTED,
  PLAN_FIXTURE,
  PLAN_NOW,
  PLAN_TODAY,
} from './fixtures/planCandidatesFixture.mjs'
import { planCandidates } from '../lib/shared/dailyPlanPolicy.js'
import { planDayRange, todayPlanCandidates } from '../lib/client/dailyPlanCandidates.js'

const tasks = () => PLAN_FIXTURE.tasks.map((task) => ({ ...task }))
const planA = () => PLAN_A.map((item) => ({ ...item }))

/** 走共享纯函数（候选判定的唯一实现）。 */
function candidates(overrides = {}) {
  return planCandidates({
    tasks: tasks(),
    planItems: planA(),
    dayStartMs: PLAN_DAY_START,
    dayEndMs: PLAN_DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: PLAN_FIXTURE.defaultEstimateMinutes,
    ...overrides,
  })
}

const ids = (rows) => rows.map((row) => row.taskId)

// ---------------------------------------------------------------------------
// AX-C01：谁进候选（表驱动）
// ---------------------------------------------------------------------------

test('AX-C01 候选表驱动：未来 doing 入候选、未来 todo 不入、归档/done 不入', () => {
  const result = candidates({ planItems: [] })
  const byId = new Map(result.candidates.map((row) => [row.taskId, row]))
  assert.ok(byId.has('S2'), '截止在 5 天后的 doing 长任务必须可见（这是"排不出来"的根因修复）')
  assert.ok(!byId.has('S11'), '未来截止的 todo 不自动入候选')
  assert.ok(!byId.has('S12'), '无截止且不在推进的不入候选')
  assert.ok(!byId.has('S13'), 'done 不入候选')
  assert.ok(!byId.has('S14'), 'archived 不入候选')
  assert.equal(byId.get('S8').dueToday, true)
  assert.equal(byId.get('S8').overdue, false)
  assert.deepEqual(byId.get('S2').reasons, ['in-progress'])
  assert.deepEqual(byId.get('S6').reasons, ['in-progress'])
  assert.deepEqual(byId.get('S7').reasons, ['due-today'])
  assert.deepEqual(byId.get('S10').reasons, ['in-progress'])
  assert.equal(byId.get('S10').dueUnparseable, true)
})

test('AX-C01 无计划：候选全集 8 条全部可见（不退回"按到期任务求和"那套）', () => {
  const result = candidates({ planItems: [] })
  assert.equal(result.candidates.length, PLAN_EXPECTED.noPlanCandidates.total)
  assert.deepEqual(ids(result.candidates), PLAN_EXPECTED.noPlanCandidates.ids)
  const suggested = result.candidates.reduce((sum, row) => sum + row.suggestedMinutes, 0)
  assert.equal(suggested, PLAN_EXPECTED.noPlanCandidates.suggested)
})

test('AX-C04 脏 due 的 doing 任务仍进候选，但带"截止时间无法解析"诊断（不当作无截止）', () => {
  const result = candidates({ planItems: [] })
  const s10 = result.candidates.find((row) => row.taskId === 'S10')
  assert.ok(s10, 'S10 是 doing，必须进候选')
  assert.equal(s10.dueUnparseable, true)
  assert.ok(result.diagnostics.some((row) => row.taskId === 'S10'), '脏 due 必须留下诊断')
})

test('AX-C01 逾期候选只受开关影响：关着不入、打开才入', () => {
  const off = candidates()
  const on = candidates({ includeOverdue: true })
  assert.deepEqual(ids(off.candidates).filter((id) => !PLAN_A.some((item) => item.taskId === id)), PLAN_EXPECTED.planAUnscheduled.ids)
  assert.deepEqual(ids(on.candidates).filter((id) => !PLAN_A.some((item) => item.taskId === id)), PLAN_EXPECTED.planAUnscheduledOverdue.ids)
  // 开关只加不减：打开后前一批候选一条都不许消失
  for (const id of ids(off.candidates)) assert.ok(ids(on.candidates).includes(id), `${id} 不该因开关被藏掉`)
})

test('AX-C01 已在计划中的任务永远进候选，并带计划投入快照（界面要显示它）', () => {
  const result = candidates()
  const planned = result.candidates.find((row) => row.taskId === 'S2')
  assert.ok(planned.planned)
  assert.equal(planned.plannedMinutes, 120, '已排入的候选要带计划投入快照（快照 ≠ 估时 600）')
  assert.equal(PLAN_FIXTURE.tasks.find((task) => task.id === 'S2').estimatedMinutes, 600)
})

test('AX-C01 排序稳定：优先级 → 有效截止升序（坏值最后）→ createdAt → id', () => {
  const result = candidates({ planItems: [] })
  assert.deepEqual(ids(result.candidates), PLAN_EXPECTED.sortedAllIds)
  assert.deepEqual(result.candidates.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(result.candidates[0].taskId, 'S1', 'p0 第一')
  assert.equal(result.candidates[1].taskId, 'S2', 'p1 前进优先于所有 p2')
  assert.equal(result.candidates[result.candidates.length - 1].taskId, 'S8', 'p3 排最后')
  assert.ok(!result.candidates.some((row) => row.taskId === 'S9'), '次日 00:00 到期的不进今天的候选')
  assert.ok(!result.candidates.some((row) => row.taskId === 'S11'), '未来 todo 不进候选')
  assert.ok(!result.candidates.some((row) => row.taskId === 'S13'), 'done 不进候选')
})

test('AX-C01 排序在"有计划"时按同一条口径（未排入区不重编序号）', () => {
  const result = candidates()
  const unplanned = result.candidates.filter((row) => PLAN_A.some((item) => item.taskId === row.taskId) === false)
  assert.deepEqual(ids(unplanned), PLAN_EXPECTED.sortedIds)
  assert.deepEqual(unplanned.map((row) => row.rank), [4, 5, 6], 'rank 是候选**全集**里的稳定序号')
})

test('AX-C01 建议投入 = 当前估时，缺估时时用默认值并标记', () => {
  const result = candidates({ planItems: [] })
  const byId = new Map(result.candidates.map((row) => [row.taskId, row]))
  assert.equal(byId.get('S5').suggestedMinutes, 45)
  assert.equal(byId.get('S7').suggestedMinutes, 30, 'S7 没填估时 → 默认 30')
  assert.equal(byId.get('S7').usedDefaultEstimate, true)
  assert.equal(byId.get('S10').suggestedMinutes, 30)
})

// ---------------------------------------------------------------------------
// 接线一致性 + 日界
// ---------------------------------------------------------------------------

test('客户端候选入口与共享候选判定给同一份全集（含诊断）', () => {
  const shared = candidates()
  const client = todayPlanCandidates({
    tasks: tasks(),
    plan: { items: planA() },
    includeOverdue: false,
    defaultEstimateMinutes: PLAN_FIXTURE.defaultEstimateMinutes,
    now: PLAN_NOW,
  })
  assert.deepEqual(ids(client.candidates), ids(shared.candidates))
  assert.deepEqual(client.diagnostics.map((row) => row.taskId), shared.diagnostics.map((row) => row.taskId))
  assert.deepEqual(client.candidates.map((row) => row.suggestedMinutes), shared.candidates.map((row) => row.suggestedMinutes))
})

test('客户端接线把"没计划"也当合法输入（不许自己造一份空计划出来当有计划）', () => {
  const client = todayPlanCandidates({
    tasks: tasks(),
    plan: null,
    includeOverdue: false,
    defaultEstimateMinutes: PLAN_FIXTURE.defaultEstimateMinutes,
    now: PLAN_NOW,
  })
  const shared = candidates({ planItems: [] })
  assert.deepEqual(ids(client.candidates), ids(shared.candidates))
})

test('日界：本地日 00:00:00 算"今天"，下一天 00:00:00 不算', () => {
  const range = planDayRange(new Date(2026, 8, 30, 15, 0, 0))
  assert.deepEqual(range, { dayStartMs: PLAN_DAY_START, dayEndMs: PLAN_DAY_END })
  assert.equal(PLAN_TODAY, '2026-09-30')
  const result = candidates({ planItems: [] })
  assert.ok(ids(result.candidates).includes('S8'), 'S8 元在本地日 00:00:00，必须算今天到期')
  assert.ok(!ids(result.candidates).includes('S9'), 'S9 是次日 00:00:00，不许算今天')
})
