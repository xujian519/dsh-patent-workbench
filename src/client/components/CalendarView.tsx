/**
 * 日历视图（H4-1）：周 / 月两种形态 + 选中那一日的**同一个**日期面板。
 *
 * ## 边界（为什么这么切）
 *
 * - **传进来的**：游标与模式（`cal`，state 挂在容器上 —— 视图随页签卸载，见下方注释）、
 *   选中日（`picked`，与「今日」视图共用一份 state）、以及日期面板的**整份 props**
 *   （`dayPanelProps`：今日与日历共用一份装配，两份清单迟早漂移，见 `index.tsx` 的注释）。
 * - **留在这里的**：只有"怎么画格子"。格子的计算走 `calendarView.ts` 的纯函数
 *   （`weekDaysOf` / `monthGridOf` / `calendarCellSignal`），本组件不自己算日期，
 *   也不自己判断「算不算截止 / 算不算有计划」。
 *
 * ## 格子上的两件事
 *
 * - **截止**：`isTaskDueOnDay` 的条数。周格写「N 个截止」，月格是实心点。
 * - **计划**：该日有当日计划项（`GET /plans?from=&to=`，与单日计划同一信号）。
 *   周格写「有计划」，月格是空心点。两件事可以同时出现。
 * - **不画**法定期限 / `UpcomingDeadlines`。没有日视图。
 *
 * ## 不许在这里做判定
 *
 * 「哪天算今天」「是不是同一格」用 `format.ts#sameDay`；截止条数用
 * `calendarCellSignal`（内部只有 `isTaskDueOnDay`）；计划成员口径在
 * `shared/dailyPlanPolicy.ts#dailyPlanHasSignal`。
 *
 * ## ⚠️ 两个"看起来多余"的写法，别顺手改
 *
 * 1. `cal` 由容器传进来（里面是 `useCalendarView` 的两个 state）。**不要**在这里
 *    `useState`：视图在 `{view === 'calendar' && …}` 里，切页签即卸载，"切走再切回"
 *    会把月份与周/月模式重置 —— 那是没人要求的行为回归（H4 plan §3）。
 *    计划标记的请求可以住在这里：它不是游标，卸掉再拉一次没有行为回归。
 * 2. 空态的「AI 智能排序」直接调 `dayPanelProps.onSort()`：它的实现就是
 *    `startAISession('plan', null, dayPanel.day)`，与拆分前那一行**逐字同义**。
 *    另起一个回调等于给同一件事开第二个入口。
 */
import { DayPanel, type DayPanelProps } from './DayPanel.js'
import { sameDay, localDateString } from '../format.js'
import {
  CALENDAR_MONTH_LEGEND, CALENDAR_WEEK_PLAN_LABEL, calendarCellSignal, overlayPickedPlanDate,
  useVisiblePlanDates, weekDueLabel, type CalendarCellSignal, type CalendarCursor,
} from '../calendarView.js'

export interface CalendarPlanMarks {
  dates: ReadonlySet<string>
  failed: boolean
  retry?: () => void
}

export interface CalendarViewProps {
  /** 今天（高亮"今天"那一格 + 「今天」按钮的落点）。 */
  now: Date
  /** 当前选中的那一天（与「今日」视图共用同一份 state）。 */
  picked: Date
  /** 选中某一天（容器负责把时间归一到当天 00:00 —— 那是 `picked` 的不变量）。 */
  onPickDay: (day: Date) => void
  /** 游标与周/月模式（容器持有）。 */
  cal: CalendarCursor
  /** 日期面板的共装配（今日与日历同一份）。 */
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  /** 计划保存后递增，用来重拉格子上的计划标记。 */
  planRefreshKey?: number
  /**
   * 给定时不再请求区间（验证脚手架注入固定集合）。
   * `failed` 为真时格子不假装这些天都没有计划。
   */
  planMarks?: CalendarPlanMarks
}

export function CalendarView({
  now, picked, onPickDay, cal, dayPanelProps, planRefreshKey = 0, planMarks,
}: CalendarViewProps): JSX.Element {
  const tasks = dayPanelProps.tasks
  const visibleDays = cal.mode === 'week' ? cal.weekDays : cal.monthGrid
  const remote = useVisiblePlanDates(visibleDays, planRefreshKey, planMarks?.dates)
  const baseDates = planMarks?.dates ?? remote.dates
  const marksFailed = planMarks !== undefined ? planMarks.failed : remote.failed
  const retryMarks = planMarks?.retry ?? remote.retry
  const planDates = overlayPickedPlanDate(baseDates, {
    day: dayPanelProps.day,
    phase: dayPanelProps.planRequest,
    plan: dayPanelProps.plan,
  })
  const signalOf = (day: Date): CalendarCellSignal => calendarCellSignal(tasks, day, planDates)

  return (
    <>
      <div className="wb-cal-nav">
        <button className="wb-btn" onClick={() => cal.shift(-1)}>◀</button>
        <button className="wb-btn" onClick={() => cal.jumpToToday()}>今天</button>
        <button className="wb-btn" onClick={() => cal.shift(1)}>▶</button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
          {cal.mode === 'week'
            ? `${cal.cursor.getFullYear()}/${cal.cursor.getMonth() + 1}/${cal.cursor.getDate()} 周`
            : `${cal.cursor.getFullYear()}年${cal.cursor.getMonth() + 1}月`}
        </div>
        <div className="wb-segmented wb-sub-segmented">
          <button className={`wb-seg ${cal.mode === 'week' ? 'on' : ''}`} onClick={() => cal.setMode('week')}>周</button>
          <button className={`wb-seg ${cal.mode === 'month' ? 'on' : ''}`} onClick={() => cal.setMode('month')}>月</button>
        </div>
      </div>
      {cal.mode === 'month' && <div className="wb-cal-legend">{CALENDAR_MONTH_LEGEND}</div>}
      {marksFailed && (
        <div className="wb-cal-plan-error" role="alert">
          <span>日历计划标记加载失败</span>
          <button type="button" className="wb-btn" onClick={() => { retryMarks() }}>重试</button>
        </div>
      )}

      {cal.mode === 'week' && (
        <div className="wb-week">
          {cal.weekDays.map((day) => {
            const signal = signalOf(day)
            const dueLabel = weekDueLabel(signal.dueCount)
            return (
              <div
                key={day.toISOString()}
                {...cellAttrs(day, signal)}
                className={`wb-day ${sameDay(day, now) ? 'today' : ''} ${sameDay(day, picked) ? 'selected' : ''}`}
                onClick={() => onPickDay(day)}
              >
                <div className="wb-day-date" style={{ fontSize: 12, color: '#999' }}>{day.getMonth() + 1}/{day.getDate()}</div>
                {dueLabel !== null && <div className="wb-chip wb-due-mark" style={{ background: '#4f8ef7', marginTop: 4 }}>{dueLabel}</div>}
                {signal.hasPlan && <div className="wb-plan-mark">{CALENDAR_WEEK_PLAN_LABEL}</div>}
              </div>
            )
          })}
        </div>
      )}
      {cal.mode === 'month' && (
        <div className="wb-month">
          {cal.monthGrid.map((day) => {
            const signal = signalOf(day)
            return (
              <div
                key={day.toISOString()}
                {...cellAttrs(day, signal)}
                className={`wb-mday ${day.getMonth() !== cal.cursor.getMonth() ? 'other' : ''} ${sameDay(day, now) ? 'today' : ''} ${sameDay(day, picked) ? 'selected' : ''}`}
                onClick={() => onPickDay(day)}
              >
                <div className="wb-mday-date" style={{ fontSize: 12 }}>{day.getDate()}</div>
                {(signal.dueCount > 0 || signal.hasPlan) && (
                  <div className="wb-mday-marks">
                    {signal.dueCount > 0 && <div className="wb-chip wb-due-mark" style={{ background: '#4f8ef7', marginTop: 2 }} title="截止">●</div>}
                    {signal.hasPlan && <span className="wb-plan-dot" title="计划">○</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/**
        * 日历选中某天 = **同一个** 日期面板（ADR0001 / D15）。
        * 页签（计划/逾期/未排期/已完成）、计划面板、任务树都来自它 ——
        * 原来的两份装配（口径还不一致）已经删掉。
        */}
      <DayPanel
        {...dayPanelProps}
        emptyPlanAction={dayPanelProps.readOnly ? undefined : (
          <>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{dayPanelProps.day} 没有计划任务</div>
            <button className="wb-btn primary" style={{ marginTop: 8 }} onClick={() => dayPanelProps.onSort()}>AI 智能排序</button>
          </>
        )}
      />
    </>
  )
}

function cellAttrs(day: Date, signal: CalendarCellSignal): { 'data-cal-day': string; 'data-due': string; 'data-plan': string } {
  return {
    'data-cal-day': localDateString(day),
    'data-due': signal.dueCount > 0 ? '1' : '0',
    'data-plan': signal.hasPlan ? '1' : '0',
  }
}
