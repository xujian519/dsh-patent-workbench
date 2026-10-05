/**
 * 任务列表页筛选/排序纯函数。
 * 与 React 解耦，便于单元测试；浏览器端由 client bundle 引入。
 */

export type TaskSortKey = 'dueAt' | 'priority' | 'createdAt' | 'title'
export type TaskSortDir = 'asc' | 'desc'

export interface TaskFilterState {
  keyword: string
  statusCodes: string[]
  priorityCodes: string[]
  typeCodes: string[]
}

export const EMPTY_TASK_FILTER: TaskFilterState = Object.freeze({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })

export function isTaskFilterEmpty(filter: TaskFilterState): boolean {
  return filter.keyword.trim() === '' && filter.statusCodes.length === 0 && filter.priorityCodes.length === 0 && filter.typeCodes.length === 0
}

export interface TaskLike {
  id: string
  parentId: string | null
  title: string
  description: string
  statusCode: string
  priorityCode: string
  typeCode: string
  dueAt: string | null
  /** 动态有效截止时间：未设置 own dueAt 时由后端继承最近祖先的 dueAt。 */
  effectiveDueAt?: string | null
  completedAt: string | null
  createdAt: string
}

export interface TaskTreeNode<T> {
  task: T
  children: TaskTreeNode<T>[]
}

export function matchesTaskFilter(task: TaskLike, filter: TaskFilterState): boolean {
  const keyword = filter.keyword.trim().toLowerCase()
  if (keyword !== '') {
    const haystack = `${task.title}\n${task.description ?? ''}`.toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  if (filter.statusCodes.length > 0 && !filter.statusCodes.includes(task.statusCode)) return false
  if (filter.priorityCodes.length > 0 && !filter.priorityCodes.includes(task.priorityCode)) return false
  if (filter.typeCodes.length > 0 && !filter.typeCodes.includes(task.typeCode)) return false
  return true
}

export function compareTasks<T extends TaskLike>(
  a: T,
  b: T,
  key: TaskSortKey,
  dir: TaskSortDir,
  priorityWeight: Map<string, number> = new Map(),
): number {
  const factor = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'dueAt': {
      const at = (t: T): number | null => {
        const due = t.effectiveDueAt ?? t.dueAt
        if (due !== null) {
          const n = Date.parse(due)
          if (!Number.isNaN(n)) return n
        }
        // 已完成任务无有效截止时间时，列表右侧展示的是完成时间，排序也按它参与。
        if (t.statusCode === 'done' && t.completedAt !== null) {
          const n = Date.parse(t.completedAt)
          if (!Number.isNaN(n)) return n
        }
        return null
      }
      const av = at(a)
      const bv = at(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * factor
    }
    case 'priority': {
      const weight = (t: T): number => priorityWeight.get(t.priorityCode) ?? Number.MAX_SAFE_INTEGER
      const diff = weight(a) - weight(b)
      if (diff !== 0) return diff * factor
      break
    }
    case 'createdAt': {
      const diff = a.createdAt.localeCompare(b.createdAt)
      if (diff !== 0) return diff * factor
      break
    }
    case 'title': {
      const diff = a.title.localeCompare(b.title, 'zh-Hans-CN')
      if (diff !== 0) return diff * factor
      break
    }
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function createTaskSorter<T extends TaskLike>(
  key: TaskSortKey,
  dir: TaskSortDir,
  priorityWeight?: Map<string, number>,
): (a: T, b: T) => number {
  return (a, b) => compareTasks(a, b, key, dir, priorityWeight)
}

export function buildTaskTree<T extends TaskLike>(
  tasks: T[],
  orderOf?: Map<string, number>,
  sortFn?: (a: T, b: T) => number,
): TaskTreeNode<T>[] {
  const byParent = new Map<string | null, T[]>()
  for (const task of tasks) {
    const list = byParent.get(task.parentId) ?? []
    list.push(task)
    byParent.set(task.parentId, list)
  }
  const unlisted = Number.MAX_SAFE_INTEGER
  const walk = (id: string | null): TaskTreeNode<T>[] => {
    const siblings = byParent.get(id) ?? []
    if (sortFn !== undefined) {
      siblings.sort(sortFn)
    } else {
      siblings.sort((a, b) => (orderOf?.get(a.id) ?? unlisted) - (orderOf?.get(b.id) ?? unlisted) || a.createdAt.localeCompare(b.createdAt))
    }
    return siblings.map((task) => ({ task, children: walk(task.id) }))
  }
  return walk(null)
}

export function filterTaskTree<T>(roots: TaskTreeNode<T>[], keep: (task: T) => boolean): TaskTreeNode<T>[] {
  const walk = (nodes: TaskTreeNode<T>[]): TaskTreeNode<T>[] => {
    const out: TaskTreeNode<T>[] = []
    for (const node of nodes) {
      const children = walk(node.children)
      if (keep(node.task) || children.length > 0) out.push({ task: node.task, children })
    }
    return out
  }
  return walk(roots)
}

/** 统计树中满足 keep 的任务数量；父链上下文节点不会被计入。 */
export function countTaskTreeBy<T>(roots: TaskTreeNode<T>[], keep: (task: T) => boolean): number {
  return countByBucket(roots, keep).all
}

/**
 * 走**一遍**树，按"命中哪个桶"分别计数（v1.17.0，审计 §4.4）。
 *
 * 口径与 `countTaskTreeBy` 逐字相同：只数**命中谓词的节点**，父链上下文节点不计入。
 * 之所以把"多桶"也收进同一个走法：改动前每个类型码各走一遍整树（9 个类型码 + all = 10 遍），
 * 而它们用的是同一个谓词、同一棵树 —— 同一件事本来就只该有一处实现，
 * 否则"桶 1 的口径"和"all 的口径"迟早会分叉（本仓的头号 bug 类别）。
 */
function countByBucket<T>(
  roots: TaskTreeNode<T>[],
  keep: (task: T) => boolean,
  bucketOf?: (task: T) => string,
): { all: number; byBucket: Record<string, number> } {
  const byBucket: Record<string, number> = {}
  let all = 0
  const walk = (nodes: TaskTreeNode<T>[]): void => {
    for (const node of nodes) {
      if (keep(node.task)) {
        all += 1
        const bucket = bucketOf?.(node.task)
        if (bucket !== undefined) byBucket[bucket] = (byBucket[bucket] ?? 0) + 1
      }
      walk(node.children)
    }
  }
  walk(roots)
  return { all, byBucket }
}

/**
 * 每个任务类型各有多少条 —— 供类型 Tab 的条数徽标使用（与知识库的 `tabCounts` 同语义）。
 *
 * ## 口径：**排除类型维度自身**
 *
 * 徽标要回答的是"**切过去能看到几条**"，所以计算时套用搜索 + 状态 + 优先级，
 * 但**不能**套用当前的类型筛选 —— 否则切到某个类型后，其他 Tab 会一律显示 0。
 * 按**每一行**计数（含树里的子任务），与列表里实际渲染出的行数口径一致。
 *
 * ## 一次遍历数完（v1.17.0）
 *
 * 原来对每个类型码各调一次 `countTaskTreeBy`（10 次整树遍历），现在一次走完，
 * 由 `countByBucket` 统一计数 —— 谓词只算一次，桶与 `all` 的口径不可能分叉。
 */
export function countTasksByType<T extends TaskLike>(
  roots: TaskTreeNode<T>[],
  filter: TaskFilterState,
  typeCodes: readonly string[],
): { byType: Record<string, number>; all: number } {
  const withoutType: TaskFilterState = { ...filter, typeCodes: [] }
  const { all, byBucket } = countByBucket(roots, (t) => matchesTaskFilter(t, withoutType), (t) => t.typeCode)
  const byType: Record<string, number> = {}
  // 没命中的类型码也要**留 0**：Tab 徽标读不到 key 会显示空白而不是 0（与改动前一致）
  for (const code of typeCodes) byType[code] = byBucket[code] ?? 0
  return { byType, all }
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** 判断任务是否在某一天有有效截止时间，且未取消。日历标记统一使用该条件。 */
export function isTaskDueOnDay<T extends TaskLike>(task: T, day: Date): boolean {
  return task.effectiveDueAt != null && sameDay(new Date(task.effectiveDueAt), day) && task.statusCode !== 'cancelled'
}
