/**
 * 今日期限看板的分组（方案 A）。
 *
 * 纯函数，不读时钟：
 * - 「已过期」只看服务端给的 `overdue`（时区口径只在服务端算一次）；
 * - 「今日届满」是 `dueDate === todayKey`。`todayKey` 必须与日期面板是同一份日键
 *   （今日视图传 `dayPanelProps.day`，ADR0001），这里不另造一个「今天」；
 * - 其余是近 N 天窗口里既没过期、也不是今日届满的行，看板默认折叠。
 *
 * 服务端把某条标成过期时，即使届满日碰巧等于面板日键，也只进「已过期」——
 * 不在客户端用日期再判一次过期。组内保持入参顺序（聚合端点已按届满日排好）。
 */

export interface DeadlineDayFields {
  overdue: boolean
  dueDate: string
}

export interface DeadlineBoardGroups<T> {
  overdue: T[]
  dueToday: T[]
  rest: T[]
}

export function groupUpcomingDeadlines<T extends DeadlineDayFields>(
  deadlines: readonly T[],
  todayKey: string,
): DeadlineBoardGroups<T> {
  const overdue: T[] = []
  const dueToday: T[] = []
  const rest: T[] = []
  for (const deadline of deadlines) {
    if (deadline.overdue) overdue.push(deadline)
    else if (deadline.dueDate === todayKey) dueToday.push(deadline)
    else rest.push(deadline)
  }
  return { overdue, dueToday, rest }
}

/** 期限紧迫 = 已过期 ∪ 今日届满。两组互斥，同一条不会算两次。 */
export function deadlineUrgencyCount(groups: Pick<DeadlineBoardGroups<unknown>, 'overdue' | 'dueToday'>): number {
  return groups.overdue.length + groups.dueToday.length
}
