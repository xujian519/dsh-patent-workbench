/**
 * 日历方案 A：格子同时表达截止与当日计划；选中日计划的加载 / 失败不能装成空计划。
 *
 * 截止只走 `isTaskDueOnDay`。计划信号走 `dailyPlanHasSignal`（与 `GET /plans?date=` 同一份）。
 * 真点击在 `scripts/repro/verify-h4-calendar.mjs`；这里钉住判定和静态渲染。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { dailyPlanHasSignal } from '../lib/shared/dailyPlanPolicy.js'
import {
  CALENDAR_MONTH_LEGEND, CALENDAR_WEEK_PLAN_LABEL, calendarCellSignal, monthGridOf, overlayPickedPlanDate,
  planDateSpan, weekDaysOf, weekDueLabel,
} from '../lib/client/calendarView.js'
import { resolvePickedPlanView } from '../lib/client/pickedDayPlan.js'
import { CalendarView } from '../lib/client/components/CalendarView.js'
import { isTaskDueOnDay } from '../lib/client/taskFilterSort.js'

const noop = () => undefined

function task(over = {}) {
  return {
    id: 't', parentId: null, title: '任务', description: '', statusCode: 'todo', priorityCode: 'p2',
    typeCode: 'code_impl', dueAt: null, effectiveDueAt: null, completedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', ...over,
  }
}

const OCT_3 = new Date(2026, 9, 3)
const OCT_4 = new Date(2026, 9, 4)
const SEP_28 = new Date(2026, 8, 28)
const dueOn = (day) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).toISOString()

test('dailyPlanHasSignal：没有记录 / 空项 / 有项 / 整份不可解析', () => {
  assert.equal(dailyPlanHasSignal(null), false)
  assert.equal(dailyPlanHasSignal(undefined), false)
  assert.equal(dailyPlanHasSignal({ items: [], readable: true }), false)
  assert.equal(dailyPlanHasSignal({ items: [{ taskId: 'a' }], readable: true }), true)
  assert.equal(dailyPlanHasSignal({ items: [], readable: false }), true, '不可解析不能当成没有计划')
})

test('格子：无计划无截止是空白；仅计划 / 仅截止 / 两者并存', () => {
  const tasks = [
    task({ id: 'due', effectiveDueAt: dueOn(OCT_3) }),
    task({ id: 'cancelled', statusCode: 'cancelled', effectiveDueAt: dueOn(OCT_4) }),
  ]
  const plans = new Set(['2026-10-04', '2026-09-28'])
  const blank = calendarCellSignal(tasks, new Date(2026, 8, 29), plans)
  const planOnly = calendarCellSignal(tasks, OCT_4, plans)
  const dueOnly = calendarCellSignal(tasks, OCT_3, plans)
  const together = calendarCellSignal([
    task({ effectiveDueAt: dueOn(SEP_28) }),
  ], SEP_28, new Set(['2026-09-28']))
  assert.deepEqual(blank, { dueCount: 0, hasPlan: false })
  assert.deepEqual(planOnly, { dueCount: 0, hasPlan: true }, '已取消的截止不算截止，计划点还在')
  assert.equal(isTaskDueOnDay(tasks[1], OCT_4), false)
  assert.deepEqual(dueOnly, { dueCount: 1, hasPlan: false })
  assert.deepEqual(together, { dueCount: 1, hasPlan: true })
  assert.equal(weekDueLabel(0), null)
  assert.equal(weekDueLabel(2), '2 个截止')
  assert.equal(weekDueLabel(1), '1 个截止')
})

test('选中日请求成功才改格子上的计划点；失败和加载中不动', () => {
  const fetched = new Set(['2026-10-03', '2026-10-04'])
  assert.deepEqual(
    [...overlayPickedPlanDate(fetched, { day: '2026-10-04', phase: 'error', plan: null })].sort(),
    ['2026-10-03', '2026-10-04'],
  )
  assert.deepEqual(
    [...overlayPickedPlanDate(fetched, { day: '2026-10-04', phase: 'loading', plan: null })].sort(),
    ['2026-10-03', '2026-10-04'],
  )
  assert.deepEqual(
    [...overlayPickedPlanDate(fetched, { day: '2026-10-04', phase: 'ready', plan: null })].sort(),
    ['2026-10-03'],
    '成功且确实没有计划，才拿掉这一天',
  )
  assert.ok(
    overlayPickedPlanDate(fetched, {
      day: '2026-09-28',
      phase: 'ready',
      plan: { planDate: '2026-09-28', items: [{ taskId: 'a' }], readable: true },
    }).has('2026-09-28'),
  )
  assert.equal(
    overlayPickedPlanDate(new Set(), {
      day: '2026-10-01',
      phase: 'ready',
      plan: { planDate: '2026-10-02', items: [{ taskId: 'a' }] },
    }).size,
    0,
    '请求回来的计划日期对不上这一天时，不把信号画到错误的格子上',
  )
})

test('可见格子的日期区间是闭区间', () => {
  const span = planDateSpan(weekDaysOf(SEP_28))
  assert.deepEqual(span, { from: '2026-09-28', to: '2026-10-04' })
  assert.equal(planDateSpan([]), null)
})

test('选中日计划：对不上的快照是 loading；失败不是 ready+null', () => {
  assert.deepEqual(resolvePickedPlanView({
    enabled: true, anchor: '2026-10-04', refreshKey: 1, retryKey: 0,
    snapshot: { anchor: '2026-10-03', refreshKey: 1, retryKey: 0, phase: 'ready', plan: null, session: null },
  }), { phase: 'loading', plan: null })
  assert.deepEqual(resolvePickedPlanView({
    enabled: true, anchor: '2026-10-04', refreshKey: 0, retryKey: 1,
    snapshot: { anchor: '2026-10-04', refreshKey: 0, retryKey: 1, phase: 'error', plan: null, session: null },
  }), { phase: 'error', plan: null })
  assert.deepEqual(resolvePickedPlanView({
    enabled: true, anchor: '2026-10-04', refreshKey: 0, retryKey: 0,
    snapshot: { anchor: '2026-10-04', refreshKey: 0, retryKey: 0, phase: 'ready', plan: null, session: null },
  }), { phase: 'ready', plan: null })
  const kept = { planDate: '2026-10-04', items: [{ taskId: 'a' }] }
  assert.equal(resolvePickedPlanView({
    enabled: false, anchor: '2026-10-04', refreshKey: 0, retryKey: 0,
    snapshot: { anchor: '2026-10-04', refreshKey: 0, retryKey: 0, phase: 'ready', plan: kept, session: null },
  }).plan, null, '离开日历 / 计划页签时不把计划交给面板')
})

function panelProps(over = {}) {
  return {
    day: '2026-09-28',
    isToday: false,
    readOnly: false,
    extraTabsAvailable: true,
    tab: 'plan',
    onTabChange: noop,
    plan: null,
    candidateRows: [],
    promptInfo: { truncated: false, notice: '' },
    planTree: [], overdueTree: [], unscheduledTree: [], doneTree: [],
    expanded: new Set(),
    onToggleExpanded: noop,
    tasks: [],
    dicts: [],
    pending: null,
    busy: false,
    onOpen: noop,
    onSort: noop,
    onComplete: async () => undefined,
    onDefer: async () => undefined,
    onClearPlan: noop,
    ...over,
  }
}

function calendarProps(mode, over = {}) {
  const cursor = SEP_28
  return {
    now: OCT_3,
    picked: SEP_28,
    onPickDay: noop,
    cal: {
      cursor, mode,
      weekDays: weekDaysOf(cursor),
      monthGrid: monthGridOf(cursor),
      setMode: noop, shift: noop, jumpToToday: noop,
    },
    dayPanelProps: panelProps(),
    planMarks: { dates: new Set(['2026-10-03', '2026-10-04']), failed: false },
    ...over,
  }
}

test('周/月格子渲染：截止文案、计划文案、月图例，法定期限不进格子', () => {
  const tasks = [
    task({ id: 'due', effectiveDueAt: dueOn(OCT_3) }),
    task({ id: 'cancelled', statusCode: 'cancelled', effectiveDueAt: dueOn(new Date(2026, 9, 2)) }),
  ]
  const week = renderToStaticMarkup(createElement(CalendarView, calendarProps('week', {
    dayPanelProps: panelProps({ tasks }),
  })))
  assert.match(week, /2026-10-03[\s\S]*1 个截止/)
  assert.ok(week.includes(CALENDAR_WEEK_PLAN_LABEL))
  assert.ok(week.includes('data-cal-day="2026-10-04"') && week.includes('data-plan="1"'))
  assert.equal(week.includes(CALENDAR_MONTH_LEGEND), false, '周视图不放月图例')
  assert.equal(week.includes('UpcomingDeadlines') || week.includes('法定期限'), false)

  const month = renderToStaticMarkup(createElement(CalendarView, calendarProps('month', {
    dayPanelProps: panelProps({ tasks }),
  })))
  assert.ok(month.includes(CALENDAR_MONTH_LEGEND))
  assert.ok(month.includes('wb-plan-dot'))
  assert.ok(month.includes('●'))
})

test('选中日计划：加载中与失败不渲染空计划文案；成功空态仍可排序', () => {
  const loading = renderToStaticMarkup(createElement(CalendarView, calendarProps('week', {
    dayPanelProps: panelProps({ planRequest: 'loading' }),
  })))
  assert.ok(loading.includes('加载中…'))
  assert.equal(loading.includes('没有计划任务'), false)

  const failed = renderToStaticMarkup(createElement(CalendarView, calendarProps('week', {
    dayPanelProps: panelProps({ planRequest: 'error', onRetryPlan: noop }),
  })))
  assert.ok(failed.includes('当天计划加载失败'))
  assert.ok(failed.includes('重试'))
  assert.equal(failed.includes('没有计划任务'), false)

  const ready = renderToStaticMarkup(createElement(CalendarView, calendarProps('week', {
    dayPanelProps: panelProps({ planRequest: 'ready' }),
  })))
  assert.ok(ready.includes('2026-09-28 没有计划任务'))
  assert.ok(ready.includes('AI 智能排序'))

  const marksFailed = renderToStaticMarkup(createElement(CalendarView, calendarProps('week', {
    planMarks: { dates: new Set(), failed: true, retry: noop },
  })))
  assert.ok(marksFailed.includes('日历计划标记加载失败'))
  assert.ok(marksFailed.includes('重试'))
})
