/**
 * 日历选中日的计划请求。
 *
 * 容器只调用这一次：`picked` 仍由容器持有，这里只负责「这一天的计划到了没有」。
 * 失败停在 `error` —— 以前的 `.catch(() => setPickedPlan(null))` 会把失败画成「没有计划」。
 */
import { useCallback, useEffect, useState } from 'react'
import type { PlanLoadPhase } from './calendarView.js'
import { api } from './api.js'
import type { DailyPlanView } from './viewTypes.js'

export interface PickedPlanSnapshot {
  anchor: string
  refreshKey: number
  retryKey: number
  phase: 'ready' | 'error'
  plan: DailyPlanView | null
  session: { sessionId: string } | null
}

export function resolvePickedPlanView(input: {
  enabled: boolean
  anchor: string
  refreshKey: number
  retryKey: number
  snapshot: PickedPlanSnapshot | null
}): { phase: PlanLoadPhase; plan: DailyPlanView | null } {
  if (!input.enabled) return { phase: 'idle', plan: null }
  const snapshot = input.snapshot
  if (
    snapshot === null
    || snapshot.anchor !== input.anchor
    || snapshot.refreshKey !== input.refreshKey
    || snapshot.retryKey !== input.retryKey
  ) {
    return { phase: 'loading', plan: null }
  }
  if (snapshot.phase === 'error') return { phase: 'error', plan: null }
  return { phase: 'ready', plan: snapshot.plan }
}

/**
 * `enabled` 为假（不在日历、或不在计划页签）时计划为 null，与原先的 effect 闸门一致。
 * 锚点或刷新代次对不上的那一帧就是 `loading`，不会先亮出「没有计划」。
 */
export function usePickedDayPlan(input: {
  enabled: boolean
  anchor: string
  refreshKey: number
}): { plan: DailyPlanView | null; phase: PlanLoadPhase; retry: () => void } {
  const { enabled, anchor, refreshKey } = input
  const [retryKey, setRetryKey] = useState(0)
  const [snapshot, setSnapshot] = useState<PickedPlanSnapshot | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const ticket = { anchor, refreshKey, retryKey }
    void (async () => {
      try {
        const planRes = await api<{ plan: DailyPlanView | null }>(`/api/workbench/plans?date=${anchor}`)
        // 会话登记原先和计划一起拉。登记失败不把已经拿到的计划画成失败。
        const sessionRes = await api<{ session: { sessionId: string } | null }>(
          `/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${anchor}`,
        ).catch(() => ({ session: null }))
        if (cancelled) return
        setSnapshot({ ...ticket, phase: 'ready', plan: planRes.plan, session: sessionRes.session })
      } catch {
        if (cancelled) return
        setSnapshot({ ...ticket, phase: 'error', plan: null, session: null })
      }
    })()
    return () => { cancelled = true }
  }, [enabled, anchor, refreshKey, retryKey])

  const view = resolvePickedPlanView({ enabled, anchor, refreshKey, retryKey, snapshot })
  const retry = useCallback(() => { setRetryKey((value) => value + 1) }, [])
  return { plan: view.plan, phase: view.phase, retry }
}
