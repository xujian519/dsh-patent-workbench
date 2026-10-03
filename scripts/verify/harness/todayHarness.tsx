/**
 * H4-2 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-today.mjs` 现打包）。
 *
 * 与 `calendarHarness.tsx` 同一套路：把抽出来的 `TodayView` 用**真实 props** 渲染进页面，
 * 再暴露 `window.__h4` 给 CDP 驱动做交互断言。
 *
 * ## 它刻意模仿 `index.tsx` 的那一处结构
 *
 * 两个容器 state（`dayTab`、`view`）都挂在**这里的容器**上 —— 这正是 `index.tsx` 的形状：
 * `TodayView` 自己一个 `useState` 都没有。于是"切到别的页签再切回来，面板页签不丢"
 * 这条断言才测在正确的地方（H4 plan §3 那条规则）。
 *
 * `engineAvailable` / `isToday` / `busy` 做成可切换的 state，用来验证降级态与只读态
 * 确实由 props 驱动（而不是组件自己猜）。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TodayView } from '../../../src/client/components/views/TodayView.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { DayPanelProps } from '../../../src/client/components/DayPanel.js'
import type { UpcomingDeadlineView } from '../../../src/client/components/MattersView.js'
import type { Task } from '../../../src/client/viewTypes.js'
import type { TaskTreeNode } from '../../../src/client/taskFilterSort.js'

/** 固定的"今天"日键（与 `index.tsx` 里 `dayPanel.day` 同形）。 */
const TODAY = '2026-10-03'

function task(id: string, title: string): Task {
  const at = new Date(2026, 9, 3, 9, 0).toISOString()
  return {
    id, parentId: null, title, description: '', typeCode: 'code_impl', statusCode: 'todo', priorityCode: 'p2',
    aiPolicyCode: 'consult', dueAt: at, effectiveDueAt: at, allDay: false, estimatedMinutes: 30,
    source: 'manual', workspacePath: null, effectiveWorkspacePath: null, archived: false, extra: {},
    createdAt: at, updatedAt: at, completedAt: null, cancelledAt: null,
  }
}

const TASKS: Task[] = [task('t1', '逾期任务甲')]
/** 逾期页签放一条行：用来证明"点页签后真的换了树"，而不只是按钮高亮变了。 */
const OVERDUE_TREE: TaskTreeNode<Task>[] = [{ task: TASKS[0], children: [] }]

const DEADLINES: UpcomingDeadlineView[] = [
  { id: 'a', matterId: 'm1', caseNumber: '2026-UM-002', matterTitle: '某装置', label: '答复一通', dueDate: '2026-09-28', status: 'pending', overdue: true },
  { id: 'b', matterId: 'm2', caseNumber: '2026-INV-001', matterTitle: '某方法', label: '缴年费', dueDate: '2026-10-02', status: 'pending', overdue: false },
]

const STATS = { overdue: 7, todayDue: 3, doing: 11, total: 42 }

const events: string[] = []

function Harness(): JSX.Element {
  const [view, setView] = useState<'today' | 'other'>('today')
  /** 与 `index.tsx` 一样：日期面板的页签 state 挂在**容器**上。 */
  const [dayTab, setDayTab] = useState<DayPanelProps['tab']>('plan')
  const [engineAvailable, setEngineAvailable] = useState(true)
  const [isToday, setIsToday] = useState(true)
  const [busy, setBusy] = useState(false)

  const dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'> = {
    day: TODAY,
    isToday,
    readOnly: false,
    extraTabsAvailable: true,
    tab: dayTab,
    onTabChange: setDayTab,
    plan: null,
    candidateRows: [],
    promptInfo: { truncated: false, notice: '' },
    planTree: [],
    overdueTree: OVERDUE_TREE,
    unscheduledTree: [],
    doneTree: [],
    expanded: new Set<string>(),
    onToggleExpanded: () => undefined,
    tasks: TASKS,
    dicts: [],
    pending: null,
    busy,
    onOpen: () => undefined,
    onSort: () => { events.push('onSort') },
    onComplete: async () => undefined,
    onDefer: async () => undefined,
    onClearPlan: () => undefined,
  }

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      view: () => view,
      dayTab: () => dayTab,
      events: () => events.slice(),
      setView: (next: 'today' | 'other') => setView(next),
      setEngineAvailable: (next: boolean) => setEngineAvailable(next),
      setIsToday: (next: boolean) => setIsToday(next),
      setBusy: (next: boolean) => setBusy(next),
    }
  })

  return view === 'today'
    ? (
      <div id="today-host">
        <TodayView
          stats={STATS}
          deadlines={DEADLINES}
          upcomingDays={7}
          engineAvailable={engineAvailable}
          onRecomputeAll={() => { events.push('recomputeAll') }}
          busy={busy}
          dayPanelProps={dayPanelProps}
          onQuickEntry={() => { events.push('quickEntry') }}
          onNewTask={() => { events.push('newTask') }}
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
