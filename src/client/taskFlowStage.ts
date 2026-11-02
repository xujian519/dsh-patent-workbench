/**
 * 任务闭环「澄清 → 执行 → 验收 → 复盘」的阶段投影（纯函数，零 React）。
 *
 * 详情页只消费这里的结果：高亮哪一步、哪一步能点、点了对应哪个既有动作。
 * 不在这里发请求，也不把「完成任务」和「验收确认」合成一条新路径。
 */
export const TASK_FLOW_ORDER = ['clarify', 'execute', 'accept', 'review'] as const

export type TaskFlowStepId = typeof TASK_FLOW_ORDER[number]

export type TaskFlowAction = 'execute' | 'accept' | 'review'

const STEP_LABEL: Record<TaskFlowStepId, string> = {
  clarify: '澄清',
  execute: '执行',
  accept: '验收',
  review: '复盘',
}

export interface TaskFlowFacts {
  statusCode: string
  archived: boolean
  aiPolicyCode: string
  busy: boolean
  /**
   * 有待验收草稿才传。
   * 不传 = 没有（或服务端不支持这份投影）—— 不许当成「没有待验收」以外的任何态。
   */
  pending?: { deferred: boolean }
  hasChildren: boolean
  hasExecuteSession: boolean
  hasReviewSession: boolean
}

export interface TaskFlowStepView {
  id: TaskFlowStepId
  /** 闭环上的阶段名（澄清 / 执行 / 验收 / 复盘）。 */
  label: string
  /** 按钮或纯文本上要画的字。可点时带上既有动作的原文案。 */
  text: string
  done: boolean
  current: boolean
  /** `null` = 纯展示，不绑定动作。 */
  action: TaskFlowAction | null
  disabled: boolean
  title: string
}

/** 当前应高亮的一步。已完成 / 已取消 → 复盘；待验收 → 验收；其余未完成 → 执行。 */
export function taskFlowCurrent(input: TaskFlowFacts): TaskFlowStepId {
  if (input.statusCode === 'done' || input.statusCode === 'cancelled') return 'review'
  if (input.pending !== undefined) return 'accept'
  return 'execute'
}

function actionOf(id: TaskFlowStepId, input: TaskFlowFacts): TaskFlowAction | null {
  const terminal = input.statusCode === 'done' || input.statusCode === 'cancelled'
  switch (id) {
    case 'clarify':
      return null
    case 'execute':
      return terminal ? null : 'execute'
    case 'accept':
      return !terminal && input.pending !== undefined ? 'accept' : null
    case 'review':
      return terminal ? 'review' : null
    default: {
      const unreachable: never = id
      return unreachable
    }
  }
}

function disabledOf(action: TaskFlowAction | null, input: TaskFlowFacts): boolean {
  if (action === null || action === 'accept') return false
  if (input.archived || input.busy) return true
  return action === 'execute' && input.aiPolicyCode !== 'execute'
}

function textOf(id: TaskFlowStepId, action: TaskFlowAction | null, input: TaskFlowFacts): string {
  if (action === 'execute') return input.hasChildren ? 'AI 执行（父任务）' : 'AI 执行'
  if (action === 'review') return input.hasReviewSession ? '进入复盘会话' : 'AI 复盘'
  return STEP_LABEL[id]
}

function titleOf(id: TaskFlowStepId, action: TaskFlowAction | null, input: TaskFlowFacts): string {
  if (action === 'execute') {
    if (input.archived) return '已归档的任务请先恢复，再执行'
    if (input.aiPolicyCode !== 'execute') return '请先在“AI 策略”里开启「可执行」'
    if (input.busy) return '正在处理，请稍候'
    if (input.hasChildren) return '执行父任务：验收通过后未完成子任务会级联完成；所有子节点完成后父节点也会自动完成'
    if (input.hasExecuteSession) return '新建执行会话并携带此前会话提示'
    return '开始执行'
  }
  if (action === 'accept') {
    return input.pending?.deferred === true
      ? '这份验收申请已暂存。点此走原来的唤回，再打开确认（通过 / 驳回 / 暂存），不会在这里直接标完成。'
      : '打开原来的验收确认（通过 / 驳回 / 暂存），不会在这里直接标完成。'
  }
  if (action === 'review') {
    if (input.archived) return '已归档的任务请先恢复，再复盘'
    if (input.busy) return '正在处理，请稍候'
    return input.hasReviewSession ? '进入已有的复盘会话' : '开始 AI 复盘'
  }
  switch (id) {
    case 'clarify':
      return '澄清发生在录入时。任务已经在这里，这一步不再另开跳转。'
    case 'execute':
      return '这一步已经过去'
    case 'accept':
      return '执行完成并提交验收申请后，在这里打开原来的确认'
    case 'review':
      return '任务完成后在这里复盘'
    default: {
      const unreachable: never = id
      return unreachable
    }
  }
}

export function taskFlowSteps(input: TaskFlowFacts): TaskFlowStepView[] {
  const current = taskFlowCurrent(input)
  const currentIndex = TASK_FLOW_ORDER.indexOf(current)
  return TASK_FLOW_ORDER.map((id, index) => {
    const action = actionOf(id, input)
    return {
      id,
      label: STEP_LABEL[id],
      text: textOf(id, action, input),
      done: index < currentIndex,
      current: id === current,
      action,
      disabled: disabledOf(action, input),
      title: titleOf(id, action, input),
    }
  })
}
