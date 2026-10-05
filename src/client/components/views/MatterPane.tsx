/**
 * 案卷视图（H4-5）：案卷条 + 列表 + 详情三块从 `WorkbenchApp` 里搬出来。
 *
 * ## 边界
 *
 * - **传进来的**：案卷列表、字典、选中 id 与选中的那个案卷、时间线（容器里由
 *   `matterTimeline.ts` 算好）、官文 / 期限两份明细、引擎可用性与两条回执说明，
 *   以及八个入口（选中 / 新建 / 编辑 / 登记官文 / 删官文 / 重算期限 / 改期限状态 / 同步事件）。
 * - **留在这里的**：只有"怎么排这三块"。**没有一处 `useState`** —— 选中 id 与三份明细
 *   都由容器持有（plan §3：详情是"选中谁就拉谁"，切页签卸载不该把它重置成"没选"）。
 * - **不发请求**：八个入口都是回调解意图，容器负责落库与刷新。
 *
 * ## 命名
 *
 * 文件叫 `MatterPane.tsx` 而不是 plan 里写的 `MattersView.tsx`：`components/MattersView.tsx`
 * 已经占着这个名字（它是列表/详情两个**部件**，不是视图；H4 非目标禁止重命名既有组件）。
 * 两个同名不同目录的文件只差一层 `views/` 的话，将来改导入必然拿错 —— 这里直接叫 `MatterPane`。
 *
 * ## 判定都不在这里
 *
 * 时间线合成与排序在 `matterTimeline.ts`（有单测）；字典中文名在 `MattersView.tsx#dictLabel`；
 * 详情字段区与官方期限渲染在 `MattersView.tsx#MatterDetail`。本组件只把结果画出来 + 转发点击。
 */
import { Icon } from '../Icon.js'
import { MatterDetail, MatterList } from '../MattersView.js'
import type { MatterDeadlineView, MatterNoticeView, MatterView } from '../MattersView.js'
import type { MatterTimeline } from '../../matterTimeline.js'
import type { Dict } from '../../viewTypes.js'

export interface MatterPaneProps {
  matters: readonly MatterView[]
  dicts: readonly Dict[]
  /** 选中案卷 id（列表据此高亮；`null` = 还没选）。 */
  selectedMatterId: string | null
  /** 选中的案卷对象（容器从列表里查出来，不另存一份）。 */
  selectedMatter: MatterView | null
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
  /** 点一行即选中（容器把自己的 `selectedMatterId` 换掉）。 */
  onOpen: (matter: MatterView) => void
  /** 「新建案卷」：容器摊开一份空草稿（草稿形状只有容器知道）。 */
  onCreate: () => void
  /** 「扫描导入」：容器打开导入弹窗（扫描根、候选、勾选与落库都由它管）。 */
  onImport: () => void
  onEdit: (matter: MatterView) => void
  onAddNotice: () => void
  onDeleteNotice: (noticeId: string) => void
  onRecompute: (matterId: string) => void
  onSetDeadlineStatus: (deadlineId: string, status: string) => void
  onSyncEvents: (matterId: string) => void
}

export function MatterPane({
  matters, dicts, selectedMatterId, selectedMatter, timeline, notices, deadlines,
  engineAvailable, recomputeNote, syncNote, busy,
  onOpen, onCreate, onImport, onEdit, onAddNotice, onDeleteNotice, onRecompute, onSetDeadlineStatus, onSyncEvents,
}: MatterPaneProps): JSX.Element {
  return (
    <>
      <div className="wb-matter-bar">
        <span className="wb-matter-bar-note">案卷 {matters.length} 个{selectedMatterId === null ? '' : '（已选 1 个）'}</span>
        <button className="wb-btn" disabled={busy} onClick={onImport} data-matter-import><Icon name="folder" />扫描导入</button>
        <button className="wb-btn primary" disabled={busy} onClick={onCreate} data-matter-create><Icon name="plus" />新建案卷</button>
      </div>
      {/**
        * 列表在上、详情在下（与知识库同一条布局判断）：面板是**窄栏**，
        * 左右分栏会把两边都挤到读不出东西。点一行即选中，详情跟着换。
        */}
      <MatterList matters={matters} dicts={dicts} selectedId={selectedMatterId} onOpen={onOpen} />
      {selectedMatter === null
        ? (matters.length === 0 ? null : <div className="wb-empty">选一个案卷看详情与时间线。</div>)
        : (
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
        )}
    </>
  )
}
