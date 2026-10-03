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
import { useState } from 'react'
import { startOfWeek } from './format.js'

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
