/**
 * H4-1 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-calendar.mjs` 现打包）。
 *
 * ## 为什么需要它
 *
 * `CalendarView` 的行为（周/月切换、翻页、点格子选中、以及"切页签再切回不丢模式"）只能在
 * 真浏览器里跑：Node 没有 DOM，`react-dom/server` 只能给静态 HTML、点不动。
 * 所以这里把**真实组件**用**真实 props** 渲染进页面，再暴露 `window.__h4` 给 CDP 驱动做断言。
 *
 * ## 它刻意模仿 `index.tsx` 的那一处结构
 *
 * `cal = useCalendarView(NOW)` 由**容器**调用，视图随 `view` 状态挂载/卸载 —— 这正是
 * `index.tsx` 里的形状。于是"切到别的页签再切回来"这条断言才测在正确的地方。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CalendarView } from '../../../src/client/components/CalendarView.js'
import { useCalendarView } from '../../../src/client/calendarView.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import { startOfDay } from '../../../src/client/format.js'
import type { DayPanelProps } from '../../../src/client/components/DayPanel.js'
import type { Task } from '../../../src/client/viewTypes.js'

/** 固定的"今天" = 2026-10-03（周六）。写死才能让断言可复现。 */
const NOW = new Date(2026, 9, 3, 10, 30)
/** 面板里的"某一天"（与 `picked` 的初值一致；日历格子的日期由游标算）。 */
const PANEL_DAY = '2026-09-28'

function task(id: string, title: string, localDue: [number, number, number], statusCode = 'todo'): Task {
  const dueAt = new Date(localDue[0], localDue[1], localDue[2], 9, 0).toISOString()
  return {
    id, parentId: null, title, description: '', typeCode: 'code_impl', statusCode, priorityCode: 'p2',
    aiPolicyCode: 'consult', dueAt, effectiveDueAt: dueAt, allDay: false, estimatedMinutes: 30,
    source: 'manual', workspacePath: null, effectiveWorkspacePath: null, archived: false, extra: {},
    createdAt: dueAt, updatedAt: dueAt, completedAt: null, cancelledAt: null,
  }
}

/**
 * 4 条任务：本地 9/30、10/1、10/3 各一条，外加**一条已取消**的 10/2 ——
 * 已取消那条用来验证 `isTaskDueOnDay` 的 status 口径真的生效（那一格不该出标记）。
 */
const TASKS: Task[] = [
  task('t1', '甲（9/30）', [2026, 8, 30]),
  task('t2', '乙（10/1）', [2026, 9, 1]),
  task('t3', '丙（10/3 = 今天）', [2026, 9, 3]),
  task('t4', '丁（10/2，已取消）', [2026, 9, 2], 'cancelled'),
]

const picks: string[] = []
const events: string[] = []

const dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'> = {
  day: PANEL_DAY,
  isToday: false,
  readOnly: false,
  extraTabsAvailable: true,
  tab: 'plan',
  onTabChange: () => undefined,
  plan: null,
  candidateRows: [],
  promptInfo: { truncated: false, notice: '' },
  planTree: [],
  overdueTree: [],
  unscheduledTree: [],
  doneTree: [],
  expanded: new Set<string>(),
  onToggleExpanded: () => undefined,
  tasks: TASKS,
  dicts: [],
  pending: null,
  busy: false,
  onOpen: () => undefined,
  onSort: () => { events.push('onSort') },
  onComplete: async () => undefined,
  onDefer: async () => undefined,
  onClearPlan: () => undefined,
}

function Harness(): JSX.Element {
  const cal = useCalendarView(NOW)
  const [view, setView] = useState<'calendar' | 'today'>('calendar')
  const [picked, setPicked] = useState<Date>(() => startOfDay(NOW))

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      mode: () => cal.mode,
      cursor: () => cal.cursor.toISOString(),
      picks: () => picks.slice(),
      events: () => events.slice(),
      setView: (next: 'calendar' | 'today') => setView(next),
    }
  })

  return view === 'calendar'
    ? (
      <div id="calendar-host">
        <CalendarView
          now={NOW}
          picked={picked}
          onPickDay={(day) => { picks.push(day.toISOString()); setPicked(startOfDay(day)) }}
          cal={cal}
          dayPanelProps={dayPanelProps}
        />
      </div>
    )
    : <div id="other-view">另一个页签</div>
}

const style = document.createElement('style')
style.textContent = WORKBENCH_CSS
document.head.appendChild(style)
const host = document.createElement('div')
host.id = 'root'
document.body.appendChild(host)
createRoot(host).render(<Harness />)
