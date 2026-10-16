/**
 * 案卷视图左栏（H4-5）：案卷条 + 案卷列表。
 *
 * ## 边界
 *
 * - **传进来的**：案卷列表、字典、选中 id、忙状态，以及四个入口（选中 / 新建 / 扫描导入 / 刷新）。
 * - **留在这里的**：只有"怎么排这两块"。**没有一处 `useState`** —— 选中 id 由容器持有
 *   （plan §3：切页签卸载不该把它重置成"没选"）。
 * - **不发请求**：四个入口都是回调解意图，容器负责落库与刷新。
 * - **详情不在这里**：左栏（`.wb-nav`）与右栏（`.wb-detail`）是 `.wb-body` 下的两个
 *   **兄弟容器**，一个组件盖不住两块 DOM —— 详情那一半在 `MatterDetailPane.tsx`（右栏）；
 *   "详情该摆在左还是右"的布局口径也写在那份文件头里。
 *
 * ## 命名
 *
 * 文件叫 `MatterPane.tsx` 而不是 plan 里写的 `MattersView.tsx`：`components/MattersView.tsx`
 * 已经占着这个名字（它是列表/详情两个**部件**，不是视图；H4 非目标禁止重命名既有组件）。
 * 两个同名不同目录的文件只差一层 `views/` 的话，将来改导入必然拿错 —— 这里直接叫 `MatterPane`。
 *
 * ## 判定都不在这里
 *
 * 字典中文名与阶段徽标在 `MattersView.tsx`（`dictLabel` / `StageBadge`）；
 * 详情字段区与官方期限渲染同样在 `MattersView.tsx#MatterDetail`。本组件只把结果画出来 + 转发点击。
 */
import { Icon } from '../Icon.js'
import { MatterList } from '../MattersView.js'
import type { MatterView } from '../MattersView.js'
import type { Dict } from '../../viewTypes.js'

export interface MatterPaneProps {
  matters: readonly MatterView[]
  dicts: readonly Dict[]
  /** 选中案卷 id（列表据此高亮；`null` = 还没选）。 */
  selectedMatterId: string | null
  busy: boolean
  /** 点一行即选中（容器把自己的 `selectedMatterId` 换掉）。 */
  onOpen: (matter: MatterView) => void
  /** 「新建案卷」：容器摊开一份空草稿（草稿形状只有容器知道）。 */
  onCreate: () => void
  /** 「扫描导入」：容器打开导入弹窗（扫描根、候选、勾选与落库都由它管）。 */
  onImport: () => void
  /** 「刷新」：重新拉案卷列表（容器在进入案卷视图时也会重拉一次；别处写入的案卷只靠这两处才看得见）。 */
  onRefresh: () => void
}

export function MatterPane({ matters, dicts, selectedMatterId, busy, onOpen, onCreate, onImport, onRefresh }: MatterPaneProps): JSX.Element {
  return (
    <>
      <div className="wb-matter-bar">
        <span className="wb-matter-bar-note">案卷 {matters.length} 个{selectedMatterId === null ? '' : '（已选 1 个）'}</span>
        <button className="wb-btn" disabled={busy} onClick={onRefresh} data-matter-refresh><Icon name="refresh" />刷新</button>
        <button className="wb-btn" disabled={busy} onClick={onImport} data-matter-import><Icon name="folder" />扫描导入</button>
        <button className="wb-btn primary" disabled={busy} onClick={onCreate} data-matter-create><Icon name="plus" />新建案卷</button>
      </div>
      <MatterList matters={matters} dicts={dicts} selectedId={selectedMatterId} onOpen={onOpen} />
    </>
  )
}
