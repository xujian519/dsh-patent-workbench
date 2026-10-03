/**
 * 任务视图（H4-6）：左栏任务块 —— 筛选（搜索 + 状态/优先级多选下拉 + 类型 Tab）+ 排序行
 *（排序键 / 方向 / 命中数 / 清空 / 归档切换）+ 任务树与三处空态。
 *
 * 右栏的任务详情已在 H4-3 搬去 `TaskDetailPane.tsx`，所以这里只管左栏。
 *
 * ## 边界
 *
 * - **传进来的**：筛选与排序的**当前值**、类型 Tab 项（容器用 `buildTabs` 拼好，条数按
 *   "搜索 + 状态 + 优先级"算）、已过滤排序的树（容器的 `visibleTaskTree`）、
 *   展开集与切换、三处空态的判据、待验收投影。
 * - **留在这里的**：只有"怎么排这一块"。**没有一处 `useState`** —— 筛选 / 排序 / 归档模式 /
 *   展开集都住在容器：前三个喂给容器的 `visibleTaskTree` 与 `taskTypeTabs` 两个派生，
 *   `expanded` 还被顶栏的「收起全部」一起复位（`index.tsx#collapseAll`）。
 * - **不发请求**：「查看归档」的拉取、清空、Tab 点选都只是回调解意图。
 *
 * ## 判定不在这里
 *
 * 命中条数用 `countTaskTree`（`TaskList.tsx` 里那份唯一实现）；「筛选是不是空的」由容器算好
 * 传 `filterEmpty`（它同时管着「清空」的禁用与第三条空态，判定只此一处）；
 * Tab 的多选规则在 `TabBar.tsx#toggleTab`（容器拿它写回 `typeCodes`）。
 */
import { Icon } from '../Icon.js'
import { MultiSelectDropdown, TaskTreeRows, countTaskTree, type PendingMap } from '../TaskList.js'
import { ALL, TabBar, type TabItem } from '../TabBar.js'
import type { TaskFilterState, TaskSortDir, TaskSortKey, TaskTreeNode } from '../../taskFilterSort.js'
import type { Dict, Task } from '../../viewTypes.js'

/** 两个多选下拉的表头（同一时刻只开一个；类型已升为 Tab，不在此列）。 */
export type TaskFilterDropdown = 'status' | 'priority'

export interface TasksViewProps {
  /** 筛选当前值（容器持有；类型 Tab 的选中集合也从这里推）。 */
  filter: TaskFilterState
  /** 筛选是否为"空"（容器用 `isTaskFilterEmpty` 算好；只管禁用按钮与第三条空态）。 */
  filterEmpty: boolean
  statusOptions: Dict[]
  priorityOptions: Dict[]
  /** 当前展开的下拉。 */
  openFilter: TaskFilterDropdown | null
  onToggleFilter: (name: TaskFilterDropdown) => void
  onCloseFilter: () => void
  onKeyword: (keyword: string) => void
  onStatusCodes: (codes: string[]) => void
  onPriorityCodes: (codes: string[]) => void
  /** 类型 Tab（含「全部」与条数徽标，容器拼好）。 */
  typeTabs: readonly TabItem[]
  onSelectType: (code: string, multi: boolean) => void
  sortKey: TaskSortKey
  onSortKey: (key: TaskSortKey) => void
  sortDir: TaskSortDir
  onToggleSortDir: () => void
  /** 已按筛选与排序处理好的树（容器算的；视图只画）。 */
  tree: TaskTreeNode<Task>[]
  onClearFilter: () => void
  /** 归档模式：「查看归档」的拉取在容器里。 */
  archivedMode: boolean
  onToggleArchived: () => void
  /** 当前数据源的总条数（`tasks` 或 `archivedTasks`；用来判"一条都没有"）。 */
  taskCount: number
  archivedCount: number
  expanded: Set<string>
  toggleExpanded: (id: string) => void
  dicts: Dict[]
  onOpenTask: (task: Task) => void
  selectedTaskId: string | undefined
  /** 待验收投影（服务端不支持时为 null，界面据此不显示徽标）。 */
  pending: PendingMap
  childrenOf: (taskId: string) => readonly Task[] | undefined
}

export function TasksView({
  filter, filterEmpty, statusOptions, priorityOptions, openFilter,
  onToggleFilter, onCloseFilter, onKeyword, onStatusCodes, onPriorityCodes,
  typeTabs, onSelectType, sortKey, onSortKey, sortDir, onToggleSortDir,
  tree, onClearFilter, archivedMode, onToggleArchived, taskCount, archivedCount,
  expanded, toggleExpanded, dicts, onOpenTask, selectedTaskId, pending, childrenOf,
}: TasksViewProps): JSX.Element {
  return (
    <>
      <div style={{ position: 'relative', zIndex: 25, display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ position: 'relative', zIndex: 25, flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
          placeholder="搜索标题 / 描述"
          value={filter.keyword}
          onChange={(e) => onKeyword(e.target.value)}
        />
        <MultiSelectDropdown
          label="状态"
          options={statusOptions}
          selected={filter.statusCodes}
          open={openFilter === 'status'}
          onToggle={() => onToggleFilter('status')}
          onClose={onCloseFilter}
          onChange={onStatusCodes}
        />
        <MultiSelectDropdown
          label="优先级"
          options={priorityOptions}
          selected={filter.priorityCodes}
          open={openFilter === 'priority'}
          onToggle={() => onToggleFilter('priority')}
          onClose={onCloseFilter}
          onChange={onPriorityCodes}
        />
      </div>
      {/* 类型从「多选下拉」升为 Tab（与知识库一致）；点=单选，Ctrl/Cmd+点=多选。
          状态与优先级仍保留下拉（同维度多选在那里更合适）。 */}
      <TabBar
        tabs={typeTabs}
        selected={filter.typeCodes.length === 0 ? [ALL] : filter.typeCodes}
        onSelect={onSelectType}
        ariaLabel="任务类型"
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>排序</span>
        <select
          style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
          value={sortKey}
          onChange={(e) => onSortKey(e.target.value as TaskSortKey)}
        >
          <option value="dueAt">截止时间</option>
          <option value="priority">优先级</option>
          <option value="createdAt">创建时间</option>
          <option value="title">标题</option>
        </select>
        <button className="wb-btn" onClick={onToggleSortDir} title={sortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}>
          {sortDir === 'asc' ? '↑ 升序' : '↓ 降序'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>共 {countTaskTree(tree)} 条</span>
        <div style={{ flex: 1 }} />
        <button className="wb-btn" disabled={filterEmpty} onClick={onClearFilter}><Icon name="refresh" />清空</button>
        <button className="wb-btn" onClick={onToggleArchived}>{archivedMode ? '返回任务' : '查看归档'}</button>
      </div>
      <div className="wb-list">
        <TaskTreeRows roots={tree} depth={0} expanded={expanded} toggle={toggleExpanded} dicts={dicts} onOpen={onOpenTask} selectedId={selectedTaskId} pending={pending} childrenOf={childrenOf} />
        {archivedMode && archivedCount === 0 && <div className="wb-empty">没有归档任务</div>}
        {!archivedMode && taskCount === 0 && <div className="wb-empty">还没有任务，点“快速录入”或“新建”开始</div>}
        {!filterEmpty && tree.length === 0 && <div className="wb-empty">没有符合条件的任务，点“清空”恢复完整列表</div>}
      </div>
    </>
  )
}
