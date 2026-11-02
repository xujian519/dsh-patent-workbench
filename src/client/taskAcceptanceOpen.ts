/**
 * 从任务闭环的「验收」打开**原来的确认链**。
 *
 * 只决定「唤回暂存」还是「重新打开待确认弹框」，这两条都是容器里已有的动作
 * （`resumeDeferredDraft` / `resumePendingDraft` → DraftBanner）。
 * 这里不确认、不驳回、不把任务标完成。
 */
import type { DraftView } from '../shared/contracts.js'

export interface PendingAcceptanceItem {
  taskId: string
  draftId: string
  deferred: boolean
}

export type OpenAcceptancePlan =
  | { kind: 'resume-pending'; draft: DraftView }
  | { kind: 'resume-deferred'; draftId: string }
  | { kind: 'fetch'; draftId: string }
  | { kind: 'missing' }

function completionTaskId(draft: DraftView): string {
  const taskId = draft.payload.taskId
  return typeof taskId === 'string' ? taskId : ''
}

/**
 * 本地清单优先（轮询已经拿到的草稿），其次才是待验收投影里的 draftId。
 * 投影说「有」但本地清单没有这份全文时，计划是 `fetch`，取回来仍交给原来的打开动作。
 */
export function planOpenAcceptance(input: {
  taskId: string
  drafts: readonly DraftView[]
  pendingItems: readonly PendingAcceptanceItem[]
}): OpenAcceptancePlan {
  if (input.taskId === '') return { kind: 'missing' }
  const local = input.drafts.find((draft) => draft.kindCode === 'completion' && completionTaskId(draft) === input.taskId)
  if (local !== undefined) {
    return local.deferredAt !== null
      ? { kind: 'resume-deferred', draftId: local.id }
      : { kind: 'resume-pending', draft: local }
  }
  const item = input.pendingItems.find((entry) => entry.taskId === input.taskId && entry.draftId !== '')
  if (item === undefined) return { kind: 'missing' }
  return item.deferred ? { kind: 'resume-deferred', draftId: item.draftId } : { kind: 'fetch', draftId: item.draftId }
}

export interface OpenAcceptanceDeps {
  drafts: readonly DraftView[]
  pendingItems: readonly PendingAcceptanceItem[]
  resumePending: (draft: DraftView) => void | Promise<void>
  resumeDeferred: (draftId: string) => void | Promise<void>
  fetchDraft: (draftId: string) => Promise<DraftView>
  notify: (message: string) => void
  fail: (message: string) => void
}

const MISSING_NOTICE = '当前没有这份任务的验收申请。请从右上角「待处理」打开原来的确认。'
const WRONG_KIND_NOTICE = '找到的不是验收申请。请从「待处理」打开原来的确认。'

/** 执行 `planOpenAcceptance`。失败只交给调用方的 `fail`，不另写一条确认。 */
export async function openTaskAcceptance(taskId: string, deps: OpenAcceptanceDeps): Promise<void> {
  const plan = planOpenAcceptance({ taskId, drafts: deps.drafts, pendingItems: deps.pendingItems })
  switch (plan.kind) {
    case 'missing':
      deps.notify(MISSING_NOTICE)
      return
    case 'resume-pending':
      await deps.resumePending(plan.draft)
      return
    case 'resume-deferred':
      await deps.resumeDeferred(plan.draftId)
      return
    case 'fetch':
      try {
        const draft = await deps.fetchDraft(plan.draftId)
        if (draft.kindCode !== 'completion') {
          deps.notify(WRONG_KIND_NOTICE)
          return
        }
        if (draft.deferredAt !== null) await deps.resumeDeferred(draft.id)
        else await deps.resumePending(draft)
      } catch (error) {
        deps.fail(error instanceof Error ? error.message : String(error))
      }
      return
    default: {
      const unreachable: never = plan
      return unreachable
    }
  }
}
