/**
 * H4-6 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-tasks.mjs` 现打包）。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * 筛选 / 排序 / 类型 Tab 条数三条派生**全部用生产函数现算**：
 * `createTaskSorter` → `buildTaskTree` → `filterTaskTree(matchesTaskFilter)`、
 * `countTasksByType` + `buildTabs` —— 也就是容器里那两个 `useMemo` 的逐字复刻。
 * 所以"改筛选 → 树怎么变"、"Tab 徽标几条"在浏览器里跑的是产品实现，不是手搓的假派生。
 *
 * 退化成记录器/固定夹具的只有"意图 → 请求"那几处（容器的活）：
 * - `onToggleArchived`：真容器会打 `GET /tasks?archived=true`，这里直接换成归档夹具；
 * - `onKeyword` / `onStatusCodes` / `onPriorityCodes` / `onClearFilter` / `onSelectType`：
 *   容器侧就是 setState，这里逐字照抄（含 `toggleTab` 的写法），否则测的就不是真实语义。
 *
 * 容器侧状态（筛选 / 排序 / 归档模式 / 展开集 / 选中 id / 待验收投影）在这里用 `useState`
 * 复刻，因为真容器是 `index.tsx`（跑不起来）。它复刻的是**数据流向**，不是画法。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TasksView } from '../../../src/client/components/views/TasksView.js'
import {
  buildTaskTree, countTasksByType, createTaskSorter, filterTaskTree, isTaskFilterEmpty,
  matchesTaskFilter, type TaskFilterState, type TaskSortDir, type TaskSortKey,
} from '../../../src/client/taskFilterSort.js'
import { ALL, buildTabs, toggleTab } from '../../../src/client/components/TabBar.js'
import type { PendingMap } from '../../../src/client/components/TaskList.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { Dict, Task } from '../../../src/client/viewTypes.js'

/** 字典照 `src/db/seed.ts` 的出厂值取（类型 9 条 / 状态 6 条 / 优先级 4 条，含 weight）。 */
function dict(kind: string, code: string, name: string, config: Record<string, unknown> = {}): Dict {
  return { kind, code, name, config }
}
const DICTS: Dict[] = [
  dict('type', 'client_meeting', '客户交流', { color: '#4F86F7' }),
  dict('type', 'code_impl', '代码实现', { color: '#2E9B7B' }),
  dict('type', 'feature_opt', '功能优化', { color: '#6C5CE7' }),
  dict('type', 'solution_design', '方案设计', { color: '#F39C12' }),
  dict('type', 'boss_request', '老板要求', { color: '#E74C3C' }),
  dict('type', 'team_mgmt', '团队管理', { color: '#16A085' }),
  dict('type', 'project_delivery', '项目交付', { color: '#2980B9' }),
  dict('type', 'personal', '个人生活', { color: '#95A5A6' }),
  dict('type', 'training', '培训学习', { color: '#8E44AD' }),
  dict('status', 'backlog', '待规划', { category: 'open', color: '#95A5A6' }),
  dict('status', 'todo', '待办', { category: 'open', color: '#3498DB' }),
  dict('status', 'doing', '进行中', { category: 'active', color: '#F39C12' }),
  dict('status', 'blocked', '被阻塞', { category: 'active', color: '#E74C3C' }),
  dict('status', 'done', '已完成', { category: 'terminal', color: '#2E9B7B' }),
  dict('status', 'cancelled', '已取消', { category: 'terminal', color: '#7F8C8D' }),
  dict('priority', 'p0', '紧急', { weight: 0, color: '#E74C3C' }),
  dict('priority', 'p1', '高', { weight: 1, color: '#F39C12' }),
  dict('priority', 'p2', '普通', { weight: 2, color: '#3498DB' }),
  dict('priority', 'p3', '低', { weight: 3, color: '#95A5A6' }),
]

function task(over: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    parentId: null, description: '', typeCode: 'feature_opt', statusCode: 'todo', priorityCode: 'p2',
    aiPolicyCode: 'consult', dueAt: null, effectiveDueAt: null, allDay: false, estimatedMinutes: null,
    source: 'manual', workspacePath: null, effectiveWorkspacePath: null,
    archived: false, extra: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null, cancelledAt: null,
    ...over,
  }
}

/**
 * 四棵种子任务，覆盖：父子的树、四种类型、三种状态、四档优先级、有/无截止时间。
 *
 * ⚠️ 排序期望值按 `compareTasks` 的语义手算：
 * - `dueAt` 升序 = 早的在前、**没有截止时间的排最后**（t4）；
 * - `priority` 升序 = weight 小的在前（p0 → p3）；`title` 用 `zh-Hans-CN` 拼音序。
 */
const TASKS: Task[] = [
  task({ id: 't1', title: '撰写检索报告', typeCode: 'feature_opt', statusCode: 'doing', priorityCode: 'p1', dueAt: '2026-10-05T09:00:00.000Z', effectiveDueAt: '2026-10-05T09:00:00.000Z', progressPercent: 40 }),
  task({ id: 't2', title: '补充权利要求', typeCode: 'code_impl', statusCode: 'todo', priorityCode: 'p0', parentId: 't1', dueAt: '2026-10-03T10:00:00.000Z', effectiveDueAt: '2026-10-03T10:00:00.000Z' }),
  task({ id: 't3', title: '客户沟通会', typeCode: 'client_meeting', statusCode: 'done', priorityCode: 'p2', dueAt: '2026-09-28T14:00:00.000Z', effectiveDueAt: '2026-09-28T14:00:00.000Z', completedAt: '2026-09-28T15:00:00.000Z' }),
  task({ id: 't4', title: '团队周会', typeCode: 'team_mgmt', statusCode: 'todo', priorityCode: 'p3' }),
]

/** 归档夹具：只有一条（用来验"归档模式换数据源"与"归档为空"两种态）。 */
const ARCHIVED: Task[] = [
  task({ id: 'a1', title: '去年的旧任务', typeCode: 'personal', statusCode: 'done', priorityCode: 'p3', archived: true, completedAt: '2025-12-31T00:00:00.000Z' }),
]

const calls: Array<{ name: string; args: unknown[] }> = []

function Harness(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>(TASKS)
  const [archivedTasks, setArchivedTasks] = useState<Task[]>(ARCHIVED)
  const [archivedMode, setArchivedMode] = useState(false)
  const [filter, setFilter] = useState<TaskFilterState>({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })
  const [sortKey, setSortKey] = useState<TaskSortKey>('dueAt')
  const [sortDir, setSortDir] = useState<TaskSortDir>('asc')
  const [openFilter, setOpenFilter] = useState<'status' | 'priority' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const [pendingOn, setPendingOn] = useState(false)

  /** 与容器同一处的三个派生（逐字照抄，含依赖口径）。 */
  const dictOf = useCallback((kind: string) => DICTS.filter((entry) => entry.kind === kind), [])
  const priorityWeights = useMemo(() => new Map(dictOf('priority').map((d) => [d.code, Number(d.config.weight ?? 99)])), [dictOf])
  const taskSorter = useMemo(() => createTaskSorter<Task>(sortKey, sortDir, priorityWeights), [sortKey, sortDir, priorityWeights])
  const visibleTaskTree = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    return filterTaskTree(buildTaskTree(source, undefined, taskSorter), (t) => matchesTaskFilter(t, filter))
  }, [archivedMode, archivedTasks, tasks, taskSorter, filter])
  const taskTypeDicts = useMemo(() => dictOf('type'), [dictOf])
  const taskTypeTabs = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    const { byType, all } = countTasksByType(buildTaskTree(source, undefined, taskSorter), filter, taskTypeDicts.map((d) => d.code))
    return buildTabs(taskTypeDicts, { ...byType, all }, { includeOther: false })
  }, [archivedMode, archivedTasks, tasks, taskSorter, filter, taskTypeDicts])

  const childrenIndex = useMemo(() => {
    const index = new Map<string, Task[]>()
    for (const item of tasks) {
      if (item.parentId === null) continue
      const bucket = index.get(item.parentId)
      if (bucket === undefined) index.set(item.parentId, [item])
      else bucket.push(item)
    }
    return index
  }, [tasks])
  const childrenOf = useCallback((taskId: string) => childrenIndex.get(taskId), [childrenIndex])

  const toggleExpanded = (id: string): void => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      state: () => ({ filter, sortKey, sortDir, archivedMode, openFilter, expanded: [...expanded], selectedId: selectedTaskId ?? null }),
      setTasks: (list: Task[]) => setTasks(list),
      setArchived: (list: Task[]) => setArchivedTasks(list),
      setPending: setPendingOn,
    }
  })

  const pending: PendingMap = useMemo(() => (pendingOn ? new Map([['t1', { deferred: false }]]) : null), [pendingOn])

  return (
    <div className="wb-body" style={{ display: 'flex', height: '100vh' }}>
      <div className="wb-nav" style={{ width: '62%', overflow: 'auto' }}>
        <TasksView
          filter={filter}
          filterEmpty={isTaskFilterEmpty(filter)}
          statusOptions={dictOf('status')}
          priorityOptions={dictOf('priority')}
          openFilter={openFilter}
          onToggleFilter={(name) => setOpenFilter((prev) => prev === name ? null : name)}
          onCloseFilter={() => setOpenFilter(null)}
          onKeyword={(keyword) => setFilter((prev) => ({ ...prev, keyword }))}
          onStatusCodes={(codes) => setFilter((prev) => ({ ...prev, statusCodes: codes }))}
          onPriorityCodes={(codes) => setFilter((prev) => ({ ...prev, priorityCodes: codes }))}
          typeTabs={taskTypeTabs}
          onSelectType={(code, multi) => setFilter((prev) => {
            const next = toggleTab(prev.typeCodes.length === 0 ? [ALL] : prev.typeCodes, code, multi)
            return { ...prev, typeCodes: next.includes(ALL) ? [] : next }
          })}
          sortKey={sortKey}
          onSortKey={setSortKey}
          sortDir={sortDir}
          onToggleSortDir={() => setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')}
          tree={visibleTaskTree}
          onClearFilter={() => setFilter({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })}
          archivedMode={archivedMode}
          onToggleArchived={() => {
            // 真容器在这里打 GET /tasks?archived=true；脚手架直接换夹具（记录 + 切模式语义一致）。
            const next = !archivedMode
            calls.push({ name: 'toggleArchived', args: [next] })
            setArchivedMode(next)
          }}
          taskCount={tasks.length}
          archivedCount={archivedTasks.length}
          expanded={expanded}
          toggleExpanded={toggleExpanded}
          dicts={DICTS}
          onOpenTask={(item) => { calls.push({ name: 'open', args: [item.id] }); setSelectedTaskId(item.id) }}
          selectedTaskId={selectedTaskId}
          pending={pending}
          childrenOf={childrenOf}
        />
      </div>
      <div className="wb-detail" style={{ width: '38%' }} />
    </div>
  )
}

const style = document.createElement('style')
style.textContent = WORKBENCH_CSS
document.head.appendChild(style)
const host = document.createElement('div')
host.id = 'root'
document.body.appendChild(host)
createRoot(host).render(<Harness />)
