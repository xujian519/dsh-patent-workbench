/**
 * 案卷详情（右栏）：`view === 'matters'` 时 `.wb-detail` 里的全部内容 —— 选中案卷的
 * 字段区 / 官文登记 / 期限 / 时间线，以及"还没选案卷"的占位。
 *
 * ## 为什么与左栏分成两个组件
 *
 * 左栏（`.wb-nav`）与右栏（`.wb-detail`）是 `.wb-body` 下的**两个兄弟容器**，
 * 一个组件盖不住两块 DOM（与 `KnowledgeDetailPane.tsx` 同一条理由）。于是「案卷视图」
 * 就是这一对：`MatterPane.tsx`（左：案卷条 + 列表）+ 本文件（右：详情）。
 * 详情那四张卡本就在既有部件库 `components/MattersView.tsx#MatterDetail` 里，这里只**挂**它 ——
 * 不复制一份画法（同一语义两处实现是本仓第一大 bug 类别），也不在这里做任何判定。
 *
 * ## 占位与空态（两种"没选中"要分开）
 *
 * - 库里有案卷、只是还没点：给占位「← 从左侧选择一个案卷查看详情」（与任务/知识详情同一措辞）；
 * - **库里一条案卷都没有**：右栏什么都不画。此时左栏列表自己的空态已经写着
 *   「还没有案卷。点「新建案卷」建档…」，右栏再喊一句"从左侧选一个"是句做不到的话。
 *   所以 `matterCount` 是必需入参（只用在这一条判断上，不为它把整份列表递进来）。
 *
 * ## 只发意图，取数留在容器
 *
 * 编辑 / 登记官文 / 删官文 / 重算期限 / 改期限状态 / 同步事件都只是回调解意图；
 * 发不发请求、打哪个端点由 `index.tsx` 决定。选中 id 与官文/期限/事件三份明细也住在容器 ——
 * 它们活得比本组件久（切页签卸载不该把选中重置成"没选"，见 H4 plan §3）。
 */
import { MatterDetail } from '../MattersView.js'
import type { MatterDeadlineView, MatterNoticeView, MatterView } from '../MattersView.js'
import type { MatterTimeline } from '../../matterTimeline.js'
import type { Dict } from '../../viewTypes.js'

export interface MatterDetailPaneProps {
  /** 选中的案卷（容器从列表里查出来递进来）；`null` = 还没选。 */
  selectedMatter: MatterView | null
  /** 库里案卷总条数：只为区分"还没选"与"根本没得选"（见文件头）。 */
  matterCount: number
  dicts: readonly Dict[]
  timeline: MatterTimeline
  notices: readonly MatterNoticeView[]
  deadlines: readonly MatterDeadlineView[]
  /** 引擎软探测结果：不可用时说明降级原因，不给"看起来像没期限"的空看板。 */
  engineAvailable: boolean
  /** 上次重算的结果说明（含引擎给的 `pending` 与日历覆盖提示）。 */
  recomputeNote: string
  /** 上次同步 `_matter-log.md` 的回执（含"没解析出来的行"）。 */
  syncNote: string
  busy: boolean
  onEdit: (matter: MatterView) => void
  onAddNotice: () => void
  onDeleteNotice: (noticeId: string) => void
  onRecompute: (matterId: string) => void
  onSetDeadlineStatus: (deadlineId: string, status: string) => void
  onSyncEvents: (matterId: string) => void
}

export function MatterDetailPane({
  selectedMatter, matterCount, dicts, timeline, notices, deadlines,
  engineAvailable, recomputeNote, syncNote, busy,
  onEdit, onAddNotice, onDeleteNotice, onRecompute, onSetDeadlineStatus, onSyncEvents,
}: MatterDetailPaneProps): JSX.Element | null {
  if (selectedMatter === null) {
    return matterCount === 0
      ? null
      : <div className="wb-empty" data-matter-detail-empty>← 从左侧选择一个案卷查看详情</div>
  }
  return (
    <MatterDetail
      matter={selectedMatter}
      dicts={dicts}
      timeline={timeline}
      notices={notices}
      onEdit={() => onEdit(selectedMatter)}
      onAddNotice={onAddNotice}
      onDeleteNotice={onDeleteNotice}
      deadlines={deadlines}
      engineAvailable={engineAvailable}
      recomputeNote={recomputeNote}
      onRecompute={() => onRecompute(selectedMatter.id)}
      onSetDeadlineStatus={onSetDeadlineStatus}
      onSyncEvents={() => onSyncEvents(selectedMatter.id)}
      syncNote={syncNote}
      busy={busy}
    />
  )
}
