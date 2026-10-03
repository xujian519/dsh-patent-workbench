/**
 * 「当日候选」的客户端接线层（唯一权威算法在 `src/shared/dailyPlanPolicy.ts`）。
 *
 * ## 这里只做三件事
 *
 * 1. 把"某一个本地日"折成共享函数要的 epoch 区间（`planDayRange`）；
 * 2. 给出一个稳定的"今天"键，供 `useMemo` 依赖数组使用（`planDayKey`，跨天才变）；
 * 3. 把客户端的 `Task` 快照折成共享函数的入参（`toPlanCandidateTask`）。
 *
 * **过滤 / 排序 / 求和一律不许写在这里**：候选判定同时被服务端（工具、路由）与客户端
 * 使用（需求 §5.1/§5.2），真正的实现在共享模块 —— `test/planCandidatesWiring.test.mjs`
 * 用源码扫描钉住这条。
 *
 * ⚠️ 这里**不许**再出现 `estimatedMinutes ?? 30`、「今天到期」判定或 `slice(0, 30)`
 * —— 那些都属于共享模块。
 *
 * ## 文件名历史
 *
 * 本文件原叫 `capacity.ts`：上游工作台的「今日容量账本」曾与「当日候选」共用这一层
 * （「已排 = 该日计划项 minutes 之和」要调用同一份候选判定）。容量功能已于
 * 2026-10-03 按决策 4 整体删除，剩下的内容全是候选接线，故随之一并改名 ——
 * 否则"文件叫容量、内容不是容量"会成为下一任读者的绊脚石。
 */
import {
  DEFAULT_PLAN_MINUTES,
  MAX_PLAN_MINUTES,
  planCandidates,
  type PlanCandidateResult,
  type PlanCandidateTask,
} from '../shared/dailyPlanPolicy.js'

/** 没填耗时时的兜底分钟数（与设置项 `defaultEstimateMinutes` 的缺省一致）。 */
export const DEFAULT_ESTIMATE_MINUTES = DEFAULT_PLAN_MINUTES
/**
 * 预计耗时 / 默认投入的合法下界。
 *
 * T2/D09 实测修正：原先这里写的是 **5**，而服务端 `api/routes/helpers.ts#clampEstimateForStorage`
 * 用的是 **1** —— 两把尺子不一致，跨模块等价性断言（`test/routes.test.mjs`）当场变红，
 * 且 1–4 分钟的合法估时会被客户端悄悄当成"没填"。现在两侧都是 1，与
 * `shared/dailyPlanPolicy.ts#MIN_PLAN_MINUTES`（计划投入下界）也一致。
 */
export const MIN_ESTIMATE_MINUTES = 1
/** `estimatedMinutes` 与默认耗时的上界（与 `shared/dailyPlanPolicy.ts#MAX_PLAN_MINUTES` 同值）。 */
export const MAX_ESTIMATE_MINUTES = MAX_PLAN_MINUTES

/**
 * 候选计算需要的最小任务形状。
 *
 * 与共享层的 `PlanCandidateTask` 同构：这里显式继承它，是为了让"客户端多传了字段"
 * 也不能悄悄改变判定（多出来的字段不参与任何判定）。`estimatedMinutes` 在这里收紧成
 * 必填，因为客户端的 `Task` 一定有这个字段（可能是 `null`）。
 */
export interface PlanTaskView extends PlanCandidateTask {
  /** 用户手填的预计耗时（未归一化）；`null` 表示没填。 */
  estimatedMinutes: number | null
}

/** 该日计划项里**参与候选判定**的字段（计划视图的其余字段一律不参与）。 */
export interface PlanItemView {
  taskId: string
  order: number
  minutes?: number
}

/**
 * 把「用户输入的预计耗时」归一化成可落库/可参与计算的值。
 *
 * - 有限整数且 ≥1 → `min(1440, 值)`；
 * - `0` / 负数 / 非有限（NaN、Infinity）/ 小数 / 非数字 → `null`（= 没填）。
 *
 * ⚠️ **服务端 PATCH（`src/api/routes/helpers.ts#clampEstimateForStorage`）必须与这里同口径**，
 * 否则会出现"库里 99999、界面按默认 30 算"的双口径。为什么没有直接共享这一份：客户端与宿主
 * 是两个编译容器（客户端不进宿主产物，反之亦然）。所以服务端写了一份同构夹取，并用
 * `test/routes.test.mjs` 里一条**跨模块等价性断言**（同一批输入两份实现必须给同一个结果）
 * 钉住它们不许漂移。
 */
export function clampEstimatedMinutes(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  if (value < MIN_ESTIMATE_MINUTES) return null
  return Math.min(MAX_ESTIMATE_MINUTES, value)
}

/** 本地日 D 的起止 epoch（显式传入共享函数：不读系统时钟，便于午夜/DST 测试）。 */
export function planDayRange(now: Date): { dayStartMs: number; dayEndMs: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return { dayStartMs: start.getTime(), dayEndMs: end.getTime() }
}

/**
 * 稳定排序用的"今天"键（YYYY-MM-DD 本地日）。
 *
 * 存在的理由：`index.tsx` 里的 `now` 是**渲染体内每帧新建的对象**，
 * 放进 `useMemo` 依赖数组等于 memo 每帧失效。依赖这个字符串则跨天才变一次。
 */
export function planDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 客户端的 Task 快照 → 共享候选判定要的形状（不做任何过滤）。 */
export function toPlanCandidateTask(task: PlanTaskView): PlanCandidateTask {
  return {
    id: task.id,
    parentId: task.parentId,
    title: task.title,
    statusCode: task.statusCode,
    priorityCode: task.priorityCode,
    effectiveDueAt: task.effectiveDueAt,
    estimatedMinutes: task.estimatedMinutes,
    archived: task.archived === true ? true : false,
    createdAt: task.createdAt,
  }
}

/** 当日候选全集（客户端入口）：AI 排序、手动池、未排入区共用同一份输出。 */
export function todayPlanCandidates(input: {
  tasks: readonly PlanTaskView[]
  plan: { items: readonly PlanItemView[] } | null
  includeOverdue: boolean
  defaultEstimateMinutes: number
  now: Date
}): PlanCandidateResult {
  const { dayStartMs, dayEndMs } = planDayRange(input.now)
  return planCandidates({
    tasks: input.tasks.map(toPlanCandidateTask),
    planItems: (input.plan?.items ?? []).map((item) => ({ taskId: item.taskId, order: item.order, minutes: item.minutes })),
    dayStartMs,
    dayEndMs,
    includeOverdue: input.includeOverdue,
    defaultEstimateMinutes: input.defaultEstimateMinutes,
  })
}
