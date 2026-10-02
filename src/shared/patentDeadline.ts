/**
 * 案卷 → 期限引擎 的**适配层**（唯一一处）。
 *
 * 为什么单独成文件：期限的**规则**（起算日、法定/指定期间、细则第5条顺延）只有一份，
 * 在 DSH Patent 的 `@deepseek-ai/dsh-patent-deadline`，经 `patentDeadline` 服务暴露。
 * 本文件只做两件事，不含任何期限判断：
 * 1. 把工作台的案卷/官文记录翻译成引擎的入参形状（`buildDeadlineQuery`）；
 * 2. 把引擎的报告翻译成 `matter_deadlines` 的行（`reportToDeadlineRows`）。
 * 起算日或期间要改，只改 DSH Patent 一处。
 *
 * 服务是**软探测**：未安装或未在 profile 根域注册时拿不到。拿不到时路由**明确降级**
 * （返回"期限引擎不可用"，提示手工录入），绝不在这里兜底重算——那会造出第二份期限口径。
 *
 * 跨仓库边界：引擎的 `CalendarDate` 是 `{ year, month, day }`，本仓不依赖它的类型包，
 * 因此在 `PatentDeadlineService` 里镜像它的公开形状。镜像只在**形状**上重复，
 * 不重复任何规则；引擎改形状时这里要同步（以 DSH Patent 的 README 为准）。
 */
import type { MatterDeadlineInput, MatterNoticeRow, MatterRow } from '../db/repo/matters.js'
import { normalizeCalendarDate } from '../db/repo/matters.js'

/** 引擎跨边界传的日历日期（与 DSH Patent 的 `CalendarDate` 同形，JSON 友好）。 */
export interface CalendarDateLike {
  year: number
  /** 月，1–12。 */
  month: number
  /** 日，1–31。 */
  day: number
}

/** 官文送达方式：与 `matter_notices.delivery_mode` 同值域。 */
export type PatentDeadlineDeliveryMode = 'electronic' | 'postal' | 'personal' | 'publication'

/** 引擎的 `NoticeInput` 形状：官文 + 送达方式。 */
export interface PatentDeadlineNoticeInput {
  /** 官文种类：与 `matter_notices.notice_kind` 同值域（对齐引擎的 `NoticeKind`）。 */
  kind: string
  delivery: {
    mode: PatentDeadlineDeliveryMode
    /** 发文日（电子送达与邮寄）。 */
    dispatchDate?: CalendarDateLike
    /** 文件进入电子系统的日期（电子送达，有证据时）。 */
    enteredDate?: CalendarDateLike
    /** 实际收到日（邮寄，有证据时）。 */
    actualReceiptDate?: CalendarDateLike
    /** 直接送交的交接日。 */
    handedOverDate?: CalendarDateLike
    /** 公告送达的公告日。 */
    publicationDate?: CalendarDateLike
  }
  /** 官文自身指定的期间（月），覆盖通常的指定长度。 */
  designatedMonths?: number
}

/** 引擎的 `DeadlineQuery` 形状。 */
export interface PatentDeadlineQuery {
  /** 专利类型：与 `matters.patent_kind` 同值域（对齐引擎的 `PatentKind`）。 */
  kind: string
  /** 申请日（PCT 案为国际申请日）。 */
  filingDate: CalendarDateLike
  /**
   * 是否要求优先权：**显式输入**，不由"填了优先权日"推断——
   * 否则半填的记录会悄悄改变后续期间的口径（引擎的既定契约）。
   */
  claimsPriority: boolean
  /** 最早优先权日；`claimsPriority` 为真时必填。 */
  priorityDate?: CalendarDateLike
  /** 是否为 PCT 进入中国国家阶段的申请。 */
  isPctNationalPhase?: boolean
  /** 授权公告日。 */
  authorizationPublicationDate?: CalendarDateLike
  /** 新药上市许可日。 */
  marketingApprovalDate?: CalendarDateLike
  /** 本案已收到的、会起算期间的官文。 */
  notices?: PatentDeadlineNoticeInput[]
  /** 细则第5条顺延口径；缺省 `apply`。 */
  restDayRule?: 'apply' | 'omit'
  /** 出报告的当天：由调用方给定，保证报告可复现（引擎从不读宿主时钟）。 */
  today: CalendarDateLike
}

/** 引擎的 `ComputedDeadline` 形状。 */
export interface PatentDeadlineComputed {
  id: string
  label: string
  legalBasis: string
  /** 顺延前的自身届满日。 */
  rawDueDate: string
  /** 所报届满日（`apply` 下为顺延后，`omit` 下同 rawDueDate）。 */
  dueDate: string
  daysRemaining: number
  status: string
  rolledForward: boolean
  /** 所载节假日安排未覆盖届满年时给出，提醒"顺延未经核实"。 */
  calendarCaveat?: string
  /** 产生起算日的送达/触发规则。 */
  triggerBasis?: string
}

/** 引擎的 `PendingDeadline` 形状：算不出来、缺哪个输入。 */
export interface PatentDeadlinePending {
  id: string
  label: string
  legalBasis: string
  /** 缺少的输入名。 */
  requiredInput: string
  reason: string
}

/** 引擎的 `DeadlineReport` 形状。 */
export interface PatentDeadlineReport {
  computed: PatentDeadlineComputed[]
  pending: PatentDeadlinePending[]
  restDayRule: 'apply' | 'omit'
}

/**
 * DSH Patent `patentDeadline` 服务的**结构镜像**。
 *
 * 只声明本仓用到的两个方法；服务由宿主根域提供（见
 * `deepseek-harness/packages/patent/patent-deadline`），拿不到即降级。
 */
export interface PatentDeadlineService {
  /**
   * 计算一件案卷的期限集合。
   * @param query - 案卷输入，含 `today`。
   * @param options - 本次调用的提醒提前量覆盖（部署策略，非法定期限）。
   * @returns 已算出与待补输入的期限。
   */
  evaluate(query: PatentDeadlineQuery, options?: { reminderLeadDays?: number }): PatentDeadlineReport
  /**
   * 所载节假日安排覆盖的年份；界面据此标注"该年日历未覆盖"。
   * @returns 升序年份列表。
   */
  calendarCoverage(): { years: number[] }
}

/**
 * `YYYY-MM-DD` → 引擎的日历日期。
 *
 * 真实性判定**复用工作台既有实现**（`normalizeCalendarDate`，它拒绝 `2026-02-30` 这类假日期），
 * 不在这里重写一份日期校验——同一语义两处实现正是本仓的禁区。
 * @param text - `YYYY-MM-DD`。
 * @returns 拆解后的日历日期；格式或真实性不合法时为 null。
 */
export function toCalendarDate(text: string): CalendarDateLike | null {
  const normalized = normalizeCalendarDate(text)
  if (normalized === null) return null
  const [year, month, day] = normalized.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

/** 与 `toCalendarDate` 同理，但缺值/非法值一律抛中文错误（调用方转 400）。 */
function requireCalendarDate(text: string | null | undefined, label: string): CalendarDateLike {
  if (text === null || text === undefined || text === '') throw new Error(`${label}必填`)
  const parsed = toCalendarDate(text)
  if (parsed === null) throw new Error(`${label}必须是 YYYY-MM-DD 的真实日期：${text}`)
  return parsed
}

/**
 * 官文已确认的送达日 → 引擎的"有证据日期"字段。
 *
 * 引擎自己会按送达方式算一个默认送达日；工作台存的 `delivery_date` 是**用户确认过**的日期，
 * 必须作为证据传给引擎，否则界面显示的送达日与期限起算日会不一致。
 * 直接送交/公告送达没有"证据日"概念之外的字段，分别映射为交接日/公告日。
 */
function evidencedDate(
  mode: PatentDeadlineDeliveryMode,
  deliveryDate: CalendarDateLike,
): Pick<PatentDeadlineNoticeInput['delivery'], 'enteredDate' | 'actualReceiptDate' | 'handedOverDate' | 'publicationDate'> {
  switch (mode) {
    case 'electronic': return { enteredDate: deliveryDate }
    case 'postal': return { actualReceiptDate: deliveryDate }
    case 'personal': return { handedOverDate: deliveryDate }
    case 'publication': return { publicationDate: deliveryDate }
  }
}

/** `buildDeadlineQuery` 的入参：工作台侧的案卷与官文。 */
export interface BuildDeadlineQueryInput {
  /** 案卷（只用期限相关的字段）。 */
  matter: Pick<MatterRow, 'patentKind' | 'filingDate' | 'priorityDate' | 'claimsPriority' | 'isPctNationalPhase' | 'extra'>
  /** 本案已登记的官文。 */
  notices: ReadonlyArray<Pick<MatterNoticeRow, 'noticeKind' | 'dispatchDate' | 'deliveryMode' | 'deliveryDate' | 'designatedMonths'>>
  /** 出报告的当天 `YYYY-MM-DD`；由调用方给定以保证可复现。 */
  today: string
  /** 细则第5条顺延口径覆盖；缺省交给引擎（`apply`）。 */
  restDayRule?: 'apply' | 'omit'
}

/** 从 `matters.extra` 读一个可选的日历日期；缺值返回 undefined，非法值抛错。 */
function optionalExtraDate(extra: Record<string, unknown>, key: string): CalendarDateLike | undefined {
  const raw = extra[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new Error(`案卷扩展字段 ${key} 必须是 YYYY-MM-DD 字符串`)
  return requireCalendarDate(raw, `案卷扩展字段 ${key}`)
}

/**
 * 把案卷与官文翻译成引擎的 `DeadlineQuery`。
 *
 * 必填缺失（专利类型 / 申请日 / 优先权声明与优先权日成对 / `today`）一律抛中文错误，
 * 由路由转成 400——**不静默丢字段**。`authorizationPublicationDate` 与
 * `marketingApprovalDate` 从 `matters.extra` 读；缺了引擎会把相关期限列为"待补输入"，
 * 这正是想要的行为（宁可 pending，也不拿申请日去近似）。
 * @param input - 案卷、官文与出报告日。
 * @returns 引擎入参。
 */
export function buildDeadlineQuery(input: BuildDeadlineQueryInput): PatentDeadlineQuery {
  const { matter, notices } = input
  if (matter.patentKind === null) {
    throw new Error('案卷缺少专利类型（发明 / 实用新型 / 外观设计），期限无法起算——请先在案件详情里补全')
  }
  const query: PatentDeadlineQuery = {
    kind: matter.patentKind,
    filingDate: requireCalendarDate(matter.filingDate, '申请日'),
    claimsPriority: matter.claimsPriority,
    today: requireCalendarDate(input.today, '出报告日'),
  }
  if (matter.claimsPriority) {
    query.priorityDate = requireCalendarDate(matter.priorityDate, '要求优先权时必须填优先权日')
  } else if (matter.priorityDate !== null) {
    query.priorityDate = requireCalendarDate(matter.priorityDate, '优先权日')
  }
  if (matter.isPctNationalPhase) query.isPctNationalPhase = true
  const authorizationPublicationDate = optionalExtraDate(matter.extra, 'authorizationPublicationDate')
  if (authorizationPublicationDate !== undefined) query.authorizationPublicationDate = authorizationPublicationDate
  const marketingApprovalDate = optionalExtraDate(matter.extra, 'marketingApprovalDate')
  if (marketingApprovalDate !== undefined) query.marketingApprovalDate = marketingApprovalDate
  if (input.restDayRule !== undefined) query.restDayRule = input.restDayRule

  const noticeInputs = notices.map((notice): PatentDeadlineNoticeInput => {
    const mode = notice.deliveryMode as PatentDeadlineDeliveryMode
    const delivery: PatentDeadlineNoticeInput['delivery'] = {
      mode,
      dispatchDate: requireCalendarDate(notice.dispatchDate, `官文（${notice.noticeKind}）发文日`),
    }
    if (notice.deliveryDate !== null) Object.assign(delivery, evidencedDate(mode, requireCalendarDate(notice.deliveryDate, `官文（${notice.noticeKind}）送达日`)))
    const entry: PatentDeadlineNoticeInput = { kind: notice.noticeKind, delivery }
    if (notice.designatedMonths !== null) entry.designatedMonths = notice.designatedMonths
    return entry
  })
  if (noticeInputs.length > 0) query.notices = noticeInputs
  return query
}

/**
 * 把引擎报告里**已算出**的期限翻成 `matter_deadlines` 的行。
 *
 * 只翻 `computed`：`pending` 没有届满日，而 `matter_deadlines.due_date` 是真日期列，
 * 塞空串会把"还没起算"伪装成"已起算"。待补输入由调用方随响应返回，供界面提示补录。
 *
 * `computed_from` 记来源（起算依据、是否顺延、节假日覆盖告警、顺延口径、出报告日），
 * **不记** `daysRemaining`——它是"相对今天"的派生值，存下来第二天就自相矛盾。
 * @param report - 引擎报告。
 * @param meta - 本次计算的出处信息（`today` 与引擎标识）。
 * @returns 可直接交给 `replaceMatterDeadlines` 的行。
 */
export function reportToDeadlineRows(report: PatentDeadlineReport, meta: { today: string; engine: string }): MatterDeadlineInput[] {
  return report.computed.map((deadline): MatterDeadlineInput => ({
    deadlineKey: deadline.id,
    label: deadline.label,
    dueDate: deadline.dueDate,
    dueDateRaw: deadline.rawDueDate,
    basis: deadline.legalBasis,
    computedFrom: {
      engine: meta.engine,
      today: meta.today,
      restDayRule: report.restDayRule,
      rolledForward: deadline.rolledForward,
      ...(deadline.triggerBasis === undefined ? {} : { triggerBasis: deadline.triggerBasis }),
      ...(deadline.calendarCaveat === undefined ? {} : { calendarCaveat: deadline.calendarCaveat }),
    },
  }))
}
