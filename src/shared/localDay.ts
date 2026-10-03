/**
 * 「本地日」的**唯一实现**（服务端与客户端共用）。
 *
 * ## 为什么必须有这个文件
 *
 * 同一条「本地时区 YYYY-MM-DD」公式曾在 5 处各写一遍：
 * `db/repo.ts`、`api/routes/plans.ts`（注释自承"与仓储层同口径，这里不 import"）、
 * `review-memory.ts`、`client/format.ts`、`client/dailyPlanCandidates.ts#planDayKey`。
 * 「当天 00:00」另在 `client/format.ts`、`api/routes/helpers.ts`、`reminder/*` 各写一份。
 *
 * 后果是跨午夜 / DST / 用户时区调整时，"到期、逾期、计划日、汇总时刻"会互相错位，
 * 且没有单点可修 —— 归一到本模块后，口径只有一份。
 *
 * ## 边界
 *
 * 纯函数，不 import `node:*`、不读 `process`（客户端也依赖本模块）。
 * "本地"由传入 `Date` 的本地方法决定。
 */

/** 本地时区的 `YYYY-MM-DD`。 */
export function localDateString(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本地日 00:00:00.000。不改动入参，返回新 `Date`。 */
export function startOfLocalDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}
