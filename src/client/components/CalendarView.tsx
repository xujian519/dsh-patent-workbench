/**
 * 日历视图（H4-1）：周 / 月两种形态 + 选中那一日的**同一个**日期面板。
 *
 * ## 边界（为什么这么切）
 *
 * - **传进来的**：游标与模式（`cal`，state 挂在容器上 —— 视图随页签卸载，见下方注释）、
 *   选中日（`picked`，与「今日」视图共用一份 state）、以及日期面板的**整份 props**
 *   （`dayPanelProps`：今日与日历共用一份装配，两份清单迟早漂移，见 `index.tsx` 的注释）。
 * - **留在这里的**：只有"怎么画格子"。格子的计算走 `calendarView.ts` 的纯函数
 *   （`weekDaysOf` / `monthGridOf`），本组件不自己算日期。
 *
 * ## 不许在这里做判定
 *
 * 「哪天算今天」「是不是同一格」用 `format.ts#sameDay`；某天有几个任务用
 * `taskFilterSort.ts#isTaskDueOnDay`；计划成员口径在 `shared/dailyPlanPolicy.ts`。
 *
 * ## ⚠️ 两个"看起来多余"的写法，别顺手改
 *
 * 1. `cal` 由容器传进来（里面是 `useCalendarView` 的两个 state）。**不要**在这里
 *    `useState`：视图在 `{view === 'calendar' && …}` 里，切页签即卸载，"切走再切回"
 *    会把月份与周/月模式重置 —— 那是没人要求的行为回归（H4 plan §3）。
 * 2. 空态的「AI 智能排序」直接调 `dayPanelProps.onSort()`：它的实现就是
 *    `startAISession('plan', null, dayPanel.day)`，与拆分前那一行**逐字同义**。
 *    另起一个回调等于给同一件事开第二个入口。
 */
import { DayPanel, type DayPanelProps } from './DayPanel.js'
import { isTaskDueOnDay } from '../taskFilterSort.js'
import { sameDay } from '../format.js'
import type { CalendarCursor } from '../calendarView.js'

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
}

export function CalendarView({ now, picked, onPickDay, cal, dayPanelProps }: CalendarViewProps): JSX.Element {
  const tasks = dayPanelProps.tasks
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

      {cal.mode === 'week' && (
        <div className="wb-week">
          {cal.weekDays.map((d) => {
            const n = tasks.filter((t) => isTaskDueOnDay(t, d)).length
            return (
              <div key={d.toISOString()} className={`wb-day ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => onPickDay(d)}>
                <div className="wb-day-date" style={{ fontSize: 12, color: '#999' }}>{d.getMonth() + 1}/{d.getDate()}</div>
                {n > 0 && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 4 }}>{n} 个任务</div>}
              </div>
            )
          })}
        </div>
      )}
      {cal.mode === 'month' && (
        <div className="wb-month">
          {cal.monthGrid.map((d) => (
            <div key={d.toISOString()} className={`wb-mday ${d.getMonth() !== cal.cursor.getMonth() ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => onPickDay(d)}>
              <div className="wb-mday-date" style={{ fontSize: 12 }}>{d.getDate()}</div>
              {tasks.some((t) => isTaskDueOnDay(t, d)) && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 2 }}>•</div>}
            </div>
          ))}
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
