/**
 * 今日视图（H4-2）：统计卡 + 跨案卷期限看板 + 日期面板的 **today 实例**。
 *
 * ## 边界（为什么这么切）
 *
 * - **传进来的**：统计数字（来自 bootstrap）、期限看板的数据与口径、
 *   日期面板的**整份 props**（`dayPanelProps`：今日与日历共用一份装配，
 *   两份清单迟早漂移，见 `index.tsx` 的注释）。
 * - **留在这里的**：只有"怎么排这三块"。**没有一处 `useState`** ——
 *   这个视图自己没有任何状态，读者不必怀疑"切页签会不会丢"。
 *
 * ## 不许在这里做判定
 *
 * 「哪一天」由 `dayPanelProps.day` 给出（容器里的 `useDayPanelModel` 算的，ADR0001 唯一口径）；
 * 期限的"是否已过期"由服务端给的 `overdue` 决定（见 `MattersView.tsx` 的看板）；
 * 统计数字由 bootstrap 提供，这里只做 `?? 0` 的缺省显示。
 *
 * ## 空态的「快速录入 / 新建任务」
 *
 * 两个按钮调的是**容器传进来的**同一个入口（`onQuickEntry` / `onNewTask`），
 * 与拆分前那两行逐字同义 —— 不在这里另开构造入口。
 */
import { DayPanel, type DayPanelProps } from '../DayPanel.js'
import { UpcomingDeadlines, type UpcomingDeadlineView } from '../MattersView.js'
import { Icon } from '../Icon.js'
import type { Bootstrap } from '../../viewTypes.js'

export interface TodayViewProps {
  /** bootstrap 里的四张统计卡数字；bootstrap 还没回来时为 undefined（显示 0）。 */
  stats: Bootstrap['stats'] | undefined
  /** 近 `days` 天内到期的期限（服务端聚合端点给的，客户端不算日期）。 */
  deadlines: readonly UpcomingDeadlineView[]
  upcomingDays: number
  /** 期限引擎是否可用（服务端软探测结果）。 */
  engineAvailable: boolean
  /** 「重算全部」：逐案卷重算，再重新拉看板。 */
  onRecomputeAll: () => void
  busy: boolean
  /** 日期面板的共装配（今日与日历同一份）；空态由本视图自己给。 */
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  /** 空态里的两个入口（容器的构造入口）。 */
  onQuickEntry: () => void
  onNewTask: () => void
}

export function TodayView({
  stats, deadlines, upcomingDays, engineAvailable, onRecomputeAll, busy,
  dayPanelProps, onQuickEntry, onNewTask,
}: TodayViewProps): JSX.Element {
  return (
    <>
      <div className="wb-stats wb-stats-sticky">
        <div className="wb-stat"><b>{stats?.overdue ?? 0}</b><span>逾期</span></div>
        <div className="wb-stat"><b>{stats?.todayDue ?? 0}</b><span>今天到期</span></div>
        <div className="wb-stat"><b>{stats?.doing ?? 0}</b><span>进行中</span></div>
        <div className="wb-stat"><b>{stats?.total ?? 0}</b><span>总数</span></div>
      </div>

      {/**
        * 期限看板（阶段 5 · 5C）：跨案卷的"近 7 天到期"，放在今日视图的日期面板之前。
        *
        * 为什么放这：期限是"今天要办的事"里**最难自己想起来**的那类（答复期限、年费），
        * 而日期面板只看任务。另开一个顶级页签会变成"要记得去看"的另一处（决策 D5-3 的推荐口径）。
        * 引擎不可用时这张卡会明确说明原因 —— 空看板必须能自证是"真的没有"还是"没装引擎"。
        */}
      <UpcomingDeadlines
        deadlines={deadlines}
        days={upcomingDays}
        engineAvailable={engineAvailable}
        onRecomputeAll={onRecomputeAll}
        busy={busy}
      />

      {/**
        * 今日 = 日期面板的 **today 实例**（ADR0001 口径冻结 / D15）。
        * 上面那张统计卡是今日视图独有的，面板本身与日历共用一份。
        */}
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
    </>
  )
}
