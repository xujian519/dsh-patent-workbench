/**
 * 今日视图（方案 A）：紧迫条 + 跨案卷期限看板 + 日期面板的 **today 实例**。
 *
 * ## 边界（为什么这么切）
 *
 * - **传进来的**：任务统计（bootstrap）、期限行（服务端聚合，已带 `overdue`）、
 *   日期面板的**整份 props**（`dayPanelProps`：今日与日历共用一份装配，
 *   两份清单迟早漂移，见 `index.tsx` 的注释）。
 * - **留在这里的**：三块怎么排，以及「期限紧迫」要展开看板其余行的那一下。
 *   日期面板的页签 state **不在这里** —— 它住在容器上，切走再切回来不能丢
 *   （H4 plan §3）。这里的 `deadlineFocus` 只服务这一屏的展开/滚动，卸载即弃。
 *
 * ## 不许在这里做判定
 *
 * 「哪一天」由 `dayPanelProps.day` 给出（容器里的 `useDayPanelModel` 算的，ADR0001 唯一口径）；
 * 期限「是否已过期」只信服务端 `overdue`；「今日届满」是 `dueDate === dayPanelProps.day`，
 * 不在这里另取本地时钟。任务逾期 / 今日到期的数字来自 bootstrap，这里只做 `?? 0`。
 *
 * ## 空态的「快速录入 / 新建任务」
 *
 * 两个按钮调的是**容器传进来的**同一个入口（`onQuickEntry` / `onNewTask`），
 * 与拆分前那两行逐字同义 —— 不在这里另开构造入口。
 */
import { useRef, useState } from 'react'
import { DayPanel, type DayPanelProps } from '../DayPanel.js'
import { UpcomingDeadlines, type UpcomingDeadlineView } from '../MattersView.js'
import { Icon } from '../Icon.js'
import type { Bootstrap } from '../../viewTypes.js'
import { deadlineUrgencyCount, groupUpcomingDeadlines } from '../../deadlineBoard.js'

export interface TodayViewProps {
  /** bootstrap 里的任务统计；bootstrap 还没回来时为 undefined（显示 0）。 */
  stats: Bootstrap['stats'] | undefined
  /** 近 `days` 天内到期的期限（服务端聚合端点给的，客户端不算日期）。 */
  deadlines: readonly UpcomingDeadlineView[]
  upcomingDays: number
  /** 期限引擎是否可用（服务端软探测结果）。 */
  engineAvailable: boolean
  /** 「重算全部」：逐案卷重算，再重新拉看板。 */
  onRecomputeAll: () => void
  /** 点期限行：打开该案卷详情（容器切到案卷视图并选中 `matterId`）。 */
  onOpenMatter: (matterId: string) => void
  busy: boolean
  /** 日期面板的共装配（今日与日历同一份）；空态由本视图自己给。 */
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  /** 空态里的两个入口（容器的构造入口）。 */
  onQuickEntry: () => void
  onNewTask: () => void
}

type UrgencyTarget = 'tasks-overdue' | 'tasks-due-today' | 'deadlines'

export function TodayView({
  stats, deadlines, upcomingDays, engineAvailable, onRecomputeAll, onOpenMatter, busy,
  dayPanelProps, onQuickEntry, onNewTask,
}: TodayViewProps): JSX.Element {
  const dayPanelAnchor = useRef<HTMLDivElement>(null)
  /** 递增即让期限看板展开「其余」并滚进视口。0 = 还没人点过「期限紧迫」。 */
  const [deadlineFocus, setDeadlineFocus] = useState(0)
  const deadlineHot = deadlineUrgencyCount(groupUpcomingDeadlines(deadlines, dayPanelProps.day))
  const taskOverdue = stats?.overdue ?? 0
  const taskDueToday = stats?.todayDue ?? 0

  const showDayPanel = (): void => {
    dayPanelAnchor.current?.scrollIntoView({ block: 'start' })
  }

  const onUrgency = (target: UrgencyTarget): void => {
    switch (target) {
      case 'tasks-overdue':
        dayPanelProps.onTabChange('overdue')
        showDayPanel()
        return
      case 'tasks-due-today':
        dayPanelProps.onTabChange('plan')
        showDayPanel()
        return
      case 'deadlines':
        setDeadlineFocus((value) => value + 1)
        return
      default: {
        const unreachable: never = target
        return unreachable
      }
    }
  }

  return (
    <>
      <div className="wb-stats wb-stats-sticky wb-urgency" data-urgency-strip>
        <button
          type="button"
          className={`wb-urgency-item${taskOverdue > 0 ? ' is-hot' : ''}`}
          data-urgency="tasks-overdue"
          onClick={() => onUrgency('tasks-overdue')}
        >
          <b>{taskOverdue}</b>
          <span className="wb-urgency-label">任务逾期</span>
        </button>
        <button
          type="button"
          className="wb-urgency-item"
          data-urgency="tasks-due-today"
          onClick={() => onUrgency('tasks-due-today')}
        >
          <b>{taskDueToday}</b>
          <span className="wb-urgency-label">今日到期</span>
        </button>
        <button
          type="button"
          className={`wb-urgency-item${deadlineHot > 0 ? ' is-hot' : ''}`}
          data-urgency="deadlines"
          onClick={() => onUrgency('deadlines')}
        >
          <b>{deadlineHot}</b>
          <span className="wb-urgency-label">期限紧迫</span>
          <span className="wb-urgency-sub">含已过期与今日届满</span>
        </button>
        <div className="wb-urgency-secondary" data-urgency-secondary>
          <span>进行中 {stats?.doing ?? 0}</span>
          <span>总数 {stats?.total ?? 0}</span>
        </div>
      </div>

      {/**
        * 期限看板仍挂在今日（不另开顶级页签）：已过期 → 今日届满 → 近 N 天其余。
        * 日键用面板的 `day`，与「今天」是同一份（ADR0001）。
        */}
      <UpcomingDeadlines
        deadlines={deadlines}
        days={upcomingDays}
        todayKey={dayPanelProps.day}
        engineAvailable={engineAvailable}
        onRecomputeAll={onRecomputeAll}
        onOpenMatter={onOpenMatter}
        expandToken={deadlineFocus}
        busy={busy}
      />

      {/**
        * 今日 = 日期面板的 **today 实例**（ADR0001 口径冻结 / D15）。
        * 页签成员、排入今日、AI 排序都不在这里改。
        */}
      <div ref={dayPanelAnchor} className="wb-today-panel" data-today-day-panel>
        <DayPanel
          {...dayPanelProps}
          emptyPlanAction={(
            <div className="wb-empty" style={{ padding: '28px 18px' }}>
              <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="today" size={30} /></div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>今天没有需要关注的任务</div>
              <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>可以快速录入一个新任务，或新建一个待办</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="wb-btn primary" onClick={onQuickEntry}>快速录入</button>
                <button className="wb-btn" onClick={onNewTask}>新建任务</button>
              </div>
            </div>
          )}
        />
      </div>
    </>
  )
}
