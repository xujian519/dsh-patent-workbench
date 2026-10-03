/**
 * H4-1：日历视图的**纯判定**（周/月格子与翻页落点）。
 *
 * ## 为什么这些要有单测（而行为走真浏览器）
 *
 * 这批函数是从 `WorkbenchApp` 里搬出来的内联表达式，语义有两条**容易被"顺手统一"改掉**的
 * 不对称（周视图归一到周首、月视图落到 1 号）。它们是纯函数，所以在这里用**独立算出的期望值**
 * 钉住；真实交互（点击翻页、切页签不丢模式）由 `scripts/repro/verify-h4-calendar.mjs`
 * 在真浏览器里断言 —— 两层各自负责自己能把关的部分。
 *
 * 期望值全部**手写**（不调用被测函数推导），否则就是自己证明自己。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CALENDAR_MONTH_CELLS, CALENDAR_WEEK_CELLS, calendarTodayDate, monthGridOf, shiftCalendarDate, weekDaysOf,
} from '../lib/client/calendarView.js'
import { startOfWeek } from '../lib/client/format.js'

/** 本地日期串（断言用，不引入被测模块的任何函数）。 */
function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const days = (list) => list.map(localDay)

// 2026-10-03 是周六；`startOfWeek` 是**周一**制，所以那一周从 2026-09-28（周一）起。
const SAT_OCT_3 = new Date(2026, 9, 3, 10, 30)
const MON_SEP_28 = new Date(2026, 8, 28)

test('weekDaysOf：7 格、连续，且**照抄游标的时间**（不自己归一）', () => {
  const week = weekDaysOf(new Date(2026, 8, 28, 10, 30))
  assert.equal(week.length, CALENDAR_WEEK_CELLS)
  assert.deepEqual(days(week), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  for (const day of week) {
    assert.equal(day.getHours(), 10, '格子照抄游标的时间 —— 归一由"游标从哪来"负责（见下一条）')
  }
  assert.equal(SAT_OCT_3.getTime(), new Date(2026, 9, 3, 10, 30).getTime(), '入参不许被改')
})

test('生产路径上格子都在本地 00:00（游标由 startOfWeek / 翻页 / 今天 三条路径产出，都归零）', () => {
  const fromToday = weekDaysOf(startOfWeek(SAT_OCT_3))
  assert.deepEqual(days(fromToday), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  for (const list of [fromToday, monthGridOf(startOfWeek(SAT_OCT_3))]) {
    for (const day of list) {
      assert.equal(day.getHours() + day.getMinutes() + day.getSeconds(), 0, `${localDay(day)} 必须归零（格子靠 sameDay 比较，带时间会漂）`)
    }
  }
})

test('monthGridOf：42 格、从"含本月 1 号那一周的周一"起，覆盖到 1 号所在月之后', () => {
  const grid = monthGridOf(MON_SEP_28)
  assert.equal(grid.length, CALENDAR_MONTH_CELLS)
  // 2026-09-01 是周二 → 它所在周的周一是 2026-08-31
  assert.equal(localDay(grid[0]), '2026-08-31')
  assert.equal(localDay(grid[grid.length - 1]), '2026-10-11')
  const labels = days(grid)
  assert.ok(labels.includes('2026-09-01'), '必须含本月 1 号')
  assert.ok(labels.includes('2026-09-30'), '必须含本月最后一天')
  assert.ok(labels.includes('2026-10-03'), '今天（10/3）必须落在格子里，否则"今天"高亮会消失')
})

test('shiftCalendarDate：周视图 ±7 天并归一到**周一**（连续翻页不累积偏移）', () => {
  assert.equal(localDay(shiftCalendarDate(MON_SEP_28, 'week', 1)), '2026-10-05')
  assert.equal(localDay(shiftCalendarDate(MON_SEP_28, 'week', -1)), '2026-09-21')
  // 从周三起算：+1 周必须落到下周一，而不是下周三
  assert.equal(localDay(shiftCalendarDate(new Date(2026, 8, 30), 'week', 1)), '2026-10-05')
  assert.equal(localDay(shiftCalendarDate(MON_SEP_28, 'week', 0)), '2026-09-28')
})

test('shiftCalendarDate：月视图**落在 1 号**（刻意不保留"本月第几天"）', () => {
  // 游标 9/28（9 月）→ ▶ 得到 **10 月 1 号**，不是 10/28
  assert.equal(localDay(shiftCalendarDate(MON_SEP_28, 'month', 1)), '2026-10-01')
  assert.equal(localDay(shiftCalendarDate(MON_SEP_28, 'month', -1)), '2026-08-01')
  // 从 1 号再 ▶ = 下月 1 号（不会跳过月份）
  assert.equal(localDay(shiftCalendarDate(new Date(2026, 9, 1), 'month', 1)), '2026-11-01')
  // 跨年
  assert.equal(localDay(shiftCalendarDate(new Date(2026, 11, 15), 'month', 1)), '2027-01-01')
  assert.equal(localDay(shiftCalendarDate(new Date(2026, 0, 15), 'month', -1)), '2025-12-01')
})

test('calendarTodayDate：周 → 本周周一；月 → 今天所在月的 1 号', () => {
  assert.equal(localDay(calendarTodayDate(SAT_OCT_3, 'week')), '2026-09-28')
  assert.equal(localDay(calendarTodayDate(SAT_OCT_3, 'month')), '2026-10-01')
  assert.equal(calendarTodayDate(SAT_OCT_3, 'week').getHours(), 0, '「今天」也要归零，否则格子的 sameDay 判定会错')
})

test('shiftCalendarDate 不改游标本身（纯函数）', () => {
  const cursor = new Date(2026, 8, 28, 15, 45)
  const before = cursor.getTime()
  shiftCalendarDate(cursor, 'week', 3)
  shiftCalendarDate(cursor, 'month', -2)
  assert.equal(cursor.getTime(), before)
})
