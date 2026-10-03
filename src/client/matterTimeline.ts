/**
 * 案卷时间线（阶段 5 · 5B）——**纯函数**，把三份数据合成一条时间线。
 *
 * ## 为什么要有这一层
 *
 * 案卷的时间线来自三个地方，它们的"日期"字段名、粒度、缺失形态都不一样：
 *
 * | 来源 | 表 | 日期字段 | 形态 |
 * |---|---|---|---|
 * | 案卷事件 | `matter_events` | `at` | **ISO 日期时间**（带时分秒与 Z） |
 * | 官文 | `matter_notices` | `dispatch_date` | `YYYY-MM-DD`（纯日期） |
 * | 期限 | `matter_deadlines` | `due_date` | `YYYY-MM-DD`（纯日期） |
 *
 * 把它们混在一列里排序，第一件事就是**统一粒度**（否则"2026-09-30T10:00Z" 与
 * "2026-09-30" 的字符串比较结果毫无意义）。这类"同一语义两处实现"的判定按本仓纪律
 * 必须搬进纯模块并单测，不许写在组件的 `useMemo` 里。
 *
 * ## 两条口径
 *
 * 1. **排序**：日期降序（最近的在上）→ 同日按 kind（事件 → 官文 → 期限，即"先发生事、
 *    再收文、最后到期"）→ 最后按 id 兜底，保证**结果稳定**（同一天多条不会每次刷都换位置）。
 * 2. **码 → 中文**由调用方给（`labelOf`）：字典在 SQLite 里，纯模块不碰库。
 *    **查不到就原样显示码** —— 不猜、更不留空（留空会让"这是哪类官文"直接消失）。
 *
 * 没有日期的条目不参与排序（也不静默丢弃：调用方拿到的是 `undated` 那一份，
 * 界面必须把它们单独列出来并说明原因）。
 */

/** 事件源（`matter_events` 行）。 */
export interface MatterTimelineEvent {
  id: string
  action: string
  artifact?: string | null
  approver?: string | null
  note?: string | null
  at: string
}

/** 官文源（`matter_notices` 行）。 */
export interface MatterTimelineNotice {
  id: string
  noticeKind: string
  dispatchDate: string
  deliveryMode?: string | null
  deliveryDate?: string | null
  designatedMonths?: number | null
  fileLink?: string | null
  note?: string | null
}

/** 期限源（`matter_deadlines` 行）。 */
export interface MatterTimelineDeadline {
  id: string
  label: string
  dueDate: string
  dueDateRaw?: string | null
  basis?: string | null
  status?: string | null
}

export type MatterTimelineKind = 'event' | 'notice' | 'deadline'

export interface MatterTimelineEntry {
  id: string
  kind: MatterTimelineKind
  /** 统一成 `YYYY-MM-DD`（排序与显示同用一份，见文件头）。 */
  date: string
  /** 已可显示的一句话标题（码已翻成中文）。 */
  title: string
  /** 补充说明（可能为空串；界面据此决定要不要渲染第二行）。 */
  detail: string
}

export interface MatterTimeline {
  /** 有日期的条目，降序。 */
  entries: MatterTimelineEntry[]
  /** 日期缺失或无法解析的条目（**不丢弃**，界面上要单独说明）。 */
  undated: MatterTimelineEntry[]
}

/** 同日次序：先发生的事、再收文、最后到期。 */
const KIND_ORDER: Record<MatterTimelineKind, number> = { event: 0, notice: 1, deadline: 2 }

/**
 * 取日期部分（`YYYY-MM-DD`）。
 *
 * 只认两种输入：`YYYY-MM-DD`（纯日期）与可被 `Date` 解析的 ISO 串（取**本地日**）。
 * 解析不出来返回 null —— 调用方把这种条目放进 `undated`，**不编一个今天**。
 *
 * ⚠️ 为什么 ISO 串要取本地日而不是 UTC 日：`at` 是本机时间戳，用户在 UTC+8 看到
 * "10:00Z" 的那件事，他心里的日期是本地那个日子。取 UTC 日会让临近午夜的事件
 * 出现在前一天的格子里（"我明明是 30 号做的"）。
 */
function datePartOf(value: string): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  if (trimmed === '') return null
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

export function buildMatterTimeline(input: {
  events: readonly MatterTimelineEvent[]
  notices: readonly MatterTimelineNotice[]
  deadlines: readonly MatterTimelineDeadline[]
  /** 码 → 中文名（字典在调用方；查不到**必须原样返回 code**，不许返回空串）。 */
  labelOf: (kind: 'notice_kind' | 'delivery_mode' | 'deadline_status', code: string) => string
}): MatterTimeline {
  const entries: MatterTimelineEntry[] = []
  const undated: MatterTimelineEntry[] = []

  const push = (entry: Omit<MatterTimelineEntry, 'date'> & { date: string | null }): void => {
    const { date, ...rest } = entry
    if (date === null) undated.push({ ...rest, date: '' })
    else entries.push({ ...rest, date })
  }

  for (const event of input.events) {
    push({
      id: `event:${event.id}`,
      kind: 'event',
      date: datePartOf(event.at),
      title: event.action === '' ? '（未标注动作）' : event.action,
      detail: [
        event.note ?? '',
        event.artifact === null || event.artifact === undefined || event.artifact === '' ? '' : `产出：${event.artifact}`,
        event.approver === null || event.approver === undefined || event.approver === '' ? '' : `确认人：${event.approver}`,
      ].filter((part) => part !== '').join(' · '),
    })
  }

  for (const notice of input.notices) {
    const mode = notice.deliveryMode === null || notice.deliveryMode === undefined || notice.deliveryMode === ''
      ? ''
      : input.labelOf('delivery_mode', notice.deliveryMode)
    push({
      id: `notice:${notice.id}`,
      kind: 'notice',
      // 时间线用**发文日**：它是这份官文"出现"的那一天；送达日是期限起算的口径，
      // 放在 detail 里（两者都要看得见，判据在 `shared/patentDeadline.ts`）。
      date: datePartOf(notice.dispatchDate),
      title: `官文：${input.labelOf('notice_kind', notice.noticeKind)}`,
      detail: [
        mode === '' ? '' : `送达方式：${mode}`,
        notice.deliveryDate === null || notice.deliveryDate === undefined || notice.deliveryDate === '' ? '' : `送达日：${notice.deliveryDate}`,
        notice.designatedMonths === null || notice.designatedMonths === undefined ? '' : `指定期限：${notice.designatedMonths} 个月`,
        notice.fileLink === null || notice.fileLink === undefined || notice.fileLink === '' ? '' : `文件：${notice.fileLink}`,
        notice.note ?? '',
      ].filter((part) => part !== '').join(' · '),
    })
  }

  for (const deadline of input.deadlines) {
    const status = deadline.status === null || deadline.status === undefined || deadline.status === ''
      ? ''
      : input.labelOf('deadline_status', deadline.status)
    push({
      id: `deadline:${deadline.id}`,
      kind: 'deadline',
      date: datePartOf(deadline.dueDate),
      title: `期限：${deadline.label}`,
      detail: [
        status,
        deadline.basis === null || deadline.basis === undefined || deadline.basis === '' ? '' : deadline.basis,
        // 顺延口径：届满日与"期限自身届满日"不同时必须两个都写（否则用户会觉得算错了）
        deadline.dueDateRaw === null || deadline.dueDateRaw === undefined || deadline.dueDateRaw === '' || deadline.dueDateRaw === deadline.dueDate
          ? ''
          : `不顺延届满：${deadline.dueDateRaw}`,
      ].filter((part) => part !== '').join(' · '),
    })
  }

  entries.sort((a, b) =>
    b.date.localeCompare(a.date)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.id.localeCompare(b.id))
  return { entries, undated }
}
