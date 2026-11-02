/**
 * 日历视图的**状态与派生**（H4-1：从 `index.tsx` 的 `WorkbenchApp` 里搬出来）。
 *
 * ## 为什么单独成模块
 *
 * 周/月两种形态的格子计算原先散在 `WorkbenchApp` 里（`weekDays` / `monthGrid` /
 * `moveWeek` / `moveMonth` 四段内联表达式），而那个函数有 4000 行 —— 谁也没法单独测
 * "月视图到底几天一格"。这里把判定收成**纯函数**（`weekDaysOf` 等，可单测），
 * 把两个 state 收进一个 hook。
 *
 * ## 游标的不变量：**永远是本地 00:00**
 *
 * 三条产出路径都归零：初值 `startOfWeek(now)`、翻页 `shiftCalendarDate`、`calendarTodayDate`。
 * 格子照抄游标的时间（不自己归一），所以格子也在 00:00 —— 这是 `sameDay` 比较与
 * "点格选中"两端都不漂的前提（容器在 `onPickDay` 里还会再归一次，双保险）。
 *
 * ## ⚠️ 为什么 state 挂在容器上（不是让 CalendarView 自己 useState）
 *
 * 视图在 `{view === 'calendar' && …}` 里渲染，切到别的页签就**卸载**。state 若住在视图内，
 * "切走再切回"会把月份与周/月模式重置 —— 那是一次没人要求的行为回归。
 * 所以 hook 由容器调用（state 存在容器实例里），视图只收 props。见
 * `docs/tasks/h4-split-workbench-app/plan.md` §3 那条规则。
 */
import { useCallback, useEffect, useState } from 'react'
import { dailyPlanHasSignal } from '../shared/dailyPlanPolicy.js'
import { api } from './api.js'
import { localDateString, startOfWeek } from './format.js'
import { isTaskDueOnDay, type TaskLike } from './taskFilterSort.js'

export type CalendarMode = 'week' | 'month'

/** 周视图 7 格。 */
export const CALENDAR_WEEK_CELLS = 7
/** 月视图 42 格（6 周 × 7 天）：格数固定，翻月时高度才不会跳。 */
export const CALENDAR_MONTH_CELLS = 42

/** 周视图的 7 格：从 `cursor` 起连续 7 天。 */
export function weekDaysOf(cursor: Date): Date[] {
  return Array.from({ length: CALENDAR_WEEK_CELLS }, (_, i) => {
    const d = new Date(cursor)
    d.setDate(d.getDate() + i)
    return d
  })
}

/** 月视图的 42 格：从 `cursor` 所在月的 1 号那一周的**周一**（`startOfWeek` 是周一制）起。 */
export function monthGridOf(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const start = startOfWeek(first)
  return Array.from({ length: CALENDAR_MONTH_CELLS }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return d
  })
}

/**
 * 左右翻页的落点。
 *
 * 两种形态的落点**刻意不同**，与拆分前逐字一致，不许"顺手统一"：
 * - 周视图归一到**周首**（`startOfWeek`）：否则连续翻页会逐次累积天数偏移；
 * - 月视图落在**当月 1 号**：不保留"当月第几天"，所以从 1 号点 ▶ 得到的是下月 1 号。
 */
export function shiftCalendarDate(cursor: Date, mode: CalendarMode, delta: number): Date {
  if (mode === 'week') {
    const d = new Date(cursor)
    d.setDate(d.getDate() + delta * 7)
    return startOfWeek(d)
  }
  return new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1)
}

/** 「今天」按钮的落点（同 `shiftCalendarDate` 的两形态差异）。 */
export function calendarTodayDate(now: Date, mode: CalendarMode): Date {
  return mode === 'week' ? startOfWeek(now) : new Date(now.getFullYear(), now.getMonth(), 1)
}

/** 日历游标（容器持有）。 */
export interface CalendarCursor {
  /** 当前游标日（周视图=周首；月视图=当月某天）。 */
  cursor: Date
  mode: CalendarMode
  /** 周视图 7 格（按 mode 渲染，两份派生都算好，视图不做判断以外的事）。 */
  weekDays: Date[]
  /** 月视图 42 格。 */
  monthGrid: Date[]
  setMode: (mode: CalendarMode) => void
  /** 前后翻页（周 ±7 天 / 月 ±1 月）。 */
  shift: (delta: number) => void
  /** 回到"今天"（周 → 本周周首；月 → 本月 1 号）。 */
  jumpToToday: () => void
}

/** 周格上「有计划」的短文案。 */
export const CALENDAR_WEEK_PLAN_LABEL = '有计划'
/** 月格图例（实心 = 截止，空心 = 计划）。 */
export const CALENDAR_MONTH_LEGEND = '● 截止  ○ 计划'

/** 选中日计划请求处在哪一步。失败必须停在 `error`，不许收成 `ready` + 空计划。 */
export type PlanLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface CalendarCellSignal {
  /** `isTaskDueOnDay` 命中的条数（已取消不计）。0 = 这一格没有截止信号。 */
  dueCount: number
  /** 这一天有当日计划项（与计划 API / DayPanel 同一信号）。 */
  hasPlan: boolean
}

/** 周格截止文案。口径是截止条数，不是「格子里任何任务」。 */
export function weekDueLabel(dueCount: number): string | null {
  if (dueCount <= 0) return null
  return `${dueCount} 个截止`
}

/**
 * 一格上的两个信号。截止只走 `isTaskDueOnDay`；计划只看调用方给的日期集合
 *（那份集合必须来自计划 API 或其等价派生，不许用截止日期冒充）。
 */
export function calendarCellSignal<T extends TaskLike>(
  tasks: readonly T[],
  day: Date,
  planDates: ReadonlySet<string>,
): CalendarCellSignal {
  let dueCount = 0
  for (const task of tasks) {
    if (isTaskDueOnDay(task, day)) dueCount += 1
  }
  return { dueCount, hasPlan: planDates.has(localDateString(day)) }
}

/** 可见格子覆盖的本地日闭区间。空列表没有可请求的范围。 */
export function planDateSpan(days: readonly Date[]): { from: string; to: string } | null {
  const first = days[0]
  if (first === undefined) return null
  let from = localDateString(first)
  let to = from
  for (const day of days) {
    const key = localDateString(day)
    if (key < from) from = key
    if (key > to) to = key
  }
  return { from, to }
}

export interface PickedPlanOverlay {
  day: string
  /** 缺省表示这一天的计划请求还没接到面板上（测试夹具）。 */
  phase?: PlanLoadPhase
  plan: { planDate: string; items?: readonly unknown[]; readable?: boolean } | null
}

/**
 * 把「这一天的计划请求已经成功」叠到区间结果上。
 *
 * 加载中 / 失败 / 还没请求：**不删**区间里已有的点 —— 删掉就会把失败画成「没有计划」。
 * 只有 `ready` 才以这一天的 `GET /plans?date=` 为准（有信号就点上，没有就拿掉）。
 */
export function overlayPickedPlanDate(fetched: ReadonlySet<string>, picked: PickedPlanOverlay): Set<string> {
  const next = new Set(fetched)
  const phase = picked.phase
  switch (phase) {
    case undefined:
    case 'idle':
    case 'loading':
    case 'error':
      return next
    case 'ready': {
      if (picked.plan !== null && picked.plan.planDate !== picked.day) return next
      if (dailyPlanHasSignal(picked.plan)) next.add(picked.day)
      else next.delete(picked.day)
      return next
    }
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

function planDateList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const dates: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    dates.push(item)
  }
  return dates
}

export interface VisiblePlanDates {
  dates: ReadonlySet<string>
  /** 区间请求失败。此时 `dates` 为空，调用方必须把失败说出来，不许当成「这些天都没计划」。 */
  failed: boolean
  retry: () => void
}

/**
 * 可见格子上哪些天有计划。`override` 给定时不发请求（验证脚手架注入固定集合）。
 *
 * 挂在日历视图里，而不是 `WorkbenchApp`：容器的 hook 预算不加这一条。
 */
export function useVisiblePlanDates(
  days: readonly Date[],
  refreshKey: number,
  override?: ReadonlySet<string>,
): VisiblePlanDates {
  const [attempt, setAttempt] = useState(0)
  const span = planDateSpan(days)
  const from = span?.from ?? ''
  const to = span?.to ?? ''
  const requestKey = override !== undefined || span === null ? '' : `${from}|${to}|${refreshKey}|${attempt}`
  const [loaded, setLoaded] = useState<{ requestKey: string; dates: string[]; failed: boolean } | null>(null)

  useEffect(() => {
    if (requestKey === '' || from === '' || to === '') return
    let cancelled = false
    void api<{ dates?: unknown }>(`/api/workbench/plans?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((body) => {
        if (cancelled) return
        const dates = planDateList(body.dates)
        if (dates === null) {
          setLoaded({ requestKey, dates: [], failed: true })
          return
        }
        setLoaded({ requestKey, dates, failed: false })
      })
      .catch(() => {
        if (cancelled) return
        setLoaded({ requestKey, dates: [], failed: true })
      })
    return () => { cancelled = true }
  }, [requestKey, from, to])

  const retry = useCallback(() => { setAttempt((value) => value + 1) }, [])
  if (override !== undefined) return { dates: override, failed: false, retry }
  if (loaded === null || loaded.requestKey !== requestKey) return { dates: new Set<string>(), failed: false, retry }
  return { dates: new Set(loaded.dates), failed: loaded.failed, retry }
}

export function useCalendarView(now: Date): CalendarCursor {
  const [cursor, setCursor] = useState<Date>(() => startOfWeek(now))
  const [mode, setMode] = useState<CalendarMode>('week')
  return {
    cursor,
    mode,
    weekDays: weekDaysOf(cursor),
    monthGrid: monthGridOf(cursor),
    setMode,
    shift: (delta) => setCursor(shiftCalendarDate(cursor, mode, delta)),
    jumpToToday: () => setCursor(calendarTodayDate(now, mode)),
  }
}
