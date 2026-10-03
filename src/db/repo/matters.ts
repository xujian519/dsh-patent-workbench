/**
 * 案卷域（专利工作台阶段 2）。
 *
 * 从 repo.ts 抽出（新域）。对外符号由 repo.ts 再导出，调用方 import 路径不变。
 *
 * ## 为什么案卷是一等实体而不是"顶层任务 + extra"
 *
 * 决策 1（docs/design/2026-10-03-patent-workbench-redesign.md）：任务语义（今日 /
 * 优先级 / 重复 / 子任务树）不适配案卷；案卷有大量专属字段（申请号 / 公开号 /
 * 申请日 / 优先权 / 技术领域 / IPC / 代理师…），且期限与官文都挂在案卷上。
 *
 * ## 两条契约（都为了"不静默丢件 / 不静默改写"）
 *
 * 1. **枚举逐字对齐专利内核**：`stage_code` 对齐 patent-matter 技能的六态
 *    （open/retrieving/analyzing/drafting/review/closed，对应 L1–L5）；
 *    `patent_kind` / `notice_kind` / `delivery_mode` 逐字对齐
 *    `@deepseek-ai/dsh-patent-deadline` 的 `PatentKind` / `NoticeKind` / `DeliveryMode`。
 *    这样阶段 3 把官文喂给期限引擎时**不需要翻译层**（翻译层就是"同一语义两处实现"）。
 * 2. **非法输入当场抛中文错误**（路由回 400），不夹取、不猜测、不 `continue` 跳过。
 *    日期必须是 `YYYY-MM-DD` 且真实存在（`2026-02-30` 拒绝）。
 *
 * ## 只有一件事会被"有变才写"
 *
 * `replaceMatterDeadlines` 重算期限时**保留用户已确认的状态**（done/waived）——
 * 期限重算不该把用户点过的"已办理"悄悄刷回 pending。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './shared.js'

/** 案卷阶段：逐字对齐 patent-matter 技能的六态（L1–L5）。 */
export const MATTER_STAGE_CODES = ['open', 'retrieving', 'analyzing', 'drafting', 'review', 'closed'] as const
export type MatterStageCode = (typeof MATTER_STAGE_CODES)[number]

/** 专利类型：逐字对齐 patent-deadline 的 `PatentKind`。 */
export const PATENT_KINDS = ['invention', 'utility-model', 'design'] as const
export type PatentKind = (typeof PATENT_KINDS)[number]

/** 官文种类：逐字对齐 patent-deadline 的 `NoticeKind`。 */
export const NOTICE_KINDS = [
  'office-action-first',
  'office-action-subsequent',
  'substantive-exam-notice',
  'rejection-decision',
  'grant-notice',
  'reexamination-notice',
  'invalidation-transfer',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/**
 * 一案可收多份的官文种类（每份各起算一条期限）。
 * 与 patent-deadline 的 `REPEATABLE_NOTICE_KINDS` 同口径；其余种类一案只应有一份，
 * 重复登记**当场拒绝**（静默覆盖会把先收到的那份藏起来 → 期限算错）。
 */
export const REPEATABLE_NOTICE_KINDS: ReadonlySet<string> = new Set<string>([
  'office-action-subsequent',
  'reexamination-notice',
])

/** 送达方式：逐字对齐 patent-deadline 的 `DeliveryMode`。 */
export const DELIVERY_MODES = ['electronic', 'postal', 'personal', 'publication'] as const
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

export interface MatterInput {
  caseNumber: string
  title: string
  clientId?: string | null
  matterType: string
  patentKind?: PatentKind | null
  stageCode?: MatterStageCode
  applicationNo?: string | null
  publicationNo?: string | null
  patentNo?: string | null
  filingDate?: string | null
  priorityDate?: string | null
  claimsPriority?: boolean
  isPctNationalPhase?: boolean
  ipc?: string | null
  techField?: string | null
  inventors?: string | null
  applicant?: string | null
  attorney?: string | null
  workspacePath?: string | null
  extra?: Record<string, unknown>
}

export interface MatterPatch {
  caseNumber?: string
  title?: string
  clientId?: string | null
  matterType?: string
  patentKind?: PatentKind | null
  stageCode?: MatterStageCode
  applicationNo?: string | null
  publicationNo?: string | null
  patentNo?: string | null
  filingDate?: string | null
  priorityDate?: string | null
  claimsPriority?: boolean
  isPctNationalPhase?: boolean
  ipc?: string | null
  techField?: string | null
  inventors?: string | null
  applicant?: string | null
  attorney?: string | null
  workspacePath?: string | null
  closedAt?: string | null
  extra?: Record<string, unknown>
}

export interface MatterRow {
  id: string
  caseNumber: string
  title: string
  clientId: string | null
  matterType: string
  patentKind: PatentKind | null
  stageCode: MatterStageCode
  applicationNo: string | null
  publicationNo: string | null
  patentNo: string | null
  filingDate: string | null
  priorityDate: string | null
  claimsPriority: boolean
  isPctNationalPhase: boolean
  ipc: string | null
  techField: string | null
  inventors: string | null
  applicant: string | null
  attorney: string | null
  workspacePath: string | null
  closedAt: string | null
  extra: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface MatterNoticeInput {
  matterId: string
  noticeKind: NoticeKind
  dispatchDate: string
  deliveryMode?: DeliveryMode
  deliveryDate?: string | null
  designatedMonths?: number | null
  fileLink?: string | null
  note?: string | null
}

export interface MatterNoticeRow {
  id: string
  matterId: string
  noticeKind: NoticeKind
  dispatchDate: string
  deliveryMode: DeliveryMode
  deliveryDate: string | null
  designatedMonths: number | null
  fileLink: string | null
  note: string | null
  createdAt: string
}

export interface MatterDeadlineInput {
  deadlineKey: string
  label: string
  dueDate: string
  dueDateRaw: string
  basis?: string | null
  status?: string | null
  computedFrom?: Record<string, unknown>
}

export interface MatterDeadlineRow {
  id: string
  matterId: string
  deadlineKey: string
  label: string
  dueDate: string
  dueDateRaw: string
  basis: string | null
  status: string
  computedAt: string
  computedFrom: Record<string, unknown>
}

export interface MatterEventRow {
  id: string
  matterId: string
  action: string
  artifact: string | null
  approver: string | null
  note: string | null
  at: string
}

interface RawMatterRow {
  id: string
  case_number: string
  title: string
  client_id: string | null
  matter_type: string
  patent_kind: string | null
  stage_code: string
  application_no: string | null
  publication_no: string | null
  patent_no: string | null
  filing_date: string | null
  priority_date: string | null
  claims_priority: number
  is_pct_national: number
  ipc: string | null
  tech_field: string | null
  inventors: string | null
  applicant: string | null
  attorney: string | null
  workspace_path: string | null
  closed_at: string | null
  extra: string
  created_at: string
  updated_at: string
}

/** `YYYY-MM-DD` 且真实存在（`2026-02-30` 不通过）。返回规范化串或 null。 */
export function normalizeCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  const [y, m, d] = trimmed.split('-').map(Number) as [number, number, number]
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null
  return trimmed
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 不能为空`)
  return value.trim()
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串或 null`)
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') return null
  const normalized = normalizeCalendarDate(value)
  if (normalized === null) throw new Error(`${field} 必须是 YYYY-MM-DD 的真实日期：${String(value)}`)
  return normalized
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${field} 非法，合法值：${allowed.join(' / ')}`)
}

function optionalMember<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  if (value === undefined || value === null) return null
  return requireMember(value, allowed, field)
}

function optionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值（true/false）`)
  return value
}

function parseMatter(row: RawMatterRow | undefined): MatterRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    caseNumber: row.case_number,
    title: row.title,
    clientId: row.client_id,
    matterType: row.matter_type,
    patentKind: (row.patent_kind ?? null) as PatentKind | null,
    stageCode: row.stage_code as MatterStageCode,
    applicationNo: row.application_no,
    publicationNo: row.publication_no,
    patentNo: row.patent_no,
    filingDate: row.filing_date,
    priorityDate: row.priority_date,
    claimsPriority: row.claims_priority === 1,
    isPctNationalPhase: row.is_pct_national === 1,
    ipc: row.ipc,
    techField: row.tech_field,
    inventors: row.inventors,
    applicant: row.applicant,
    attorney: row.attorney,
    workspacePath: row.workspace_path,
    closedAt: row.closed_at,
    extra: JSON.parse(row.extra) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 按案号取案卷（幂等建案/查重用）。 */
export function getMatterByCaseNumber(db: DatabaseSync, caseNumber: string): MatterRow | undefined {
  return parseMatter(db.prepare('SELECT * FROM matters WHERE case_number = ?').get(caseNumber) as RawMatterRow | undefined)
}

export function getMatter(db: DatabaseSync, id: string): MatterRow | undefined {
  return parseMatter(db.prepare('SELECT * FROM matters WHERE id = ?').get(id) as RawMatterRow | undefined)
}

export interface MatterListFilter {
  stageCode?: MatterStageCode
  matterType?: string
  clientId?: string
  q?: string
}

export function listMatters(db: DatabaseSync, filter: MatterListFilter = {}): MatterRow[] {
  const where: string[] = []
  const params: string[] = []
  if (filter.stageCode !== undefined) { where.push('stage_code = ?'); params.push(filter.stageCode) }
  if (filter.matterType !== undefined) { where.push('matter_type = ?'); params.push(filter.matterType) }
  if (filter.clientId !== undefined) { where.push('client_id = ?'); params.push(filter.clientId) }
  if (filter.q !== undefined && filter.q.trim() !== '') {
    where.push('(title LIKE ? OR case_number LIKE ? OR application_no LIKE ? OR publication_no LIKE ? OR patent_no LIKE ?)')
    const like = `%${filter.q.trim()}%`
    params.push(like, like, like, like, like)
  }
  const sql = `SELECT * FROM matters ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
  return (db.prepare(sql).all(...params) as unknown as RawMatterRow[]).map((row) => parseMatter(row) as MatterRow)
}

export function createMatter(db: DatabaseSync, input: MatterInput): MatterRow {
  const caseNumber = requireText(input.caseNumber, '案号')
  const title = requireText(input.title, '发明名称')
  const matterType = requireText(input.matterType, '案型')
  const patentKind = optionalMember(input.patentKind, PATENT_KINDS, '专利类型')
  const stageCode = input.stageCode === undefined ? 'open' : requireMember(input.stageCode, MATTER_STAGE_CODES, '阶段')
  const claimsPriority = optionalBool(input.claimsPriority, '是否主张优先权') ?? false
  const isPctNationalPhase = optionalBool(input.isPctNationalPhase, '是否 PCT 进入中国国家阶段') ?? false
  const filingDate = optionalDate(input.filingDate, '申请日')
  const priorityDate = optionalDate(input.priorityDate, '优先权日')
  /**
   * 半填的优先权是**当场拒绝**而不是存下来等阶段 3 报错：
   * patent-deadline 明确"优先权是声明而非推导"，它只接受两者齐备或两者都无。
   * 库里存一个自相矛盾的组合，等于把"这份期限算不出来"藏到某次计算时才炸。
   */
  if (claimsPriority && priorityDate === null) throw new Error('主张优先权但没填优先权日：请补优先权日，或取消「主张优先权」')
  if (!claimsPriority && priorityDate !== null) throw new Error('填了优先权日但未声明「主张优先权」：请勾选，或清空优先权日')

  if (getMatterByCaseNumber(db, caseNumber) !== undefined) throw new Error(`案号「${caseNumber}」已存在`)

  const id = randomUUID()
  const at = nowIso()
  db.prepare(`
    INSERT INTO matters (
      id, case_number, title, client_id, matter_type, patent_kind, stage_code,
      application_no, publication_no, patent_no, filing_date, priority_date,
      claims_priority, is_pct_national, ipc, tech_field, inventors, applicant, attorney,
      workspace_path, closed_at, extra, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(
    id, caseNumber, title,
    optionalText(input.clientId, '客户'), matterType, patentKind, stageCode,
    optionalText(input.applicationNo, '申请号'), optionalText(input.publicationNo, '公开号'), optionalText(input.patentNo, '专利号'),
    filingDate, priorityDate,
    claimsPriority ? 1 : 0, isPctNationalPhase ? 1 : 0,
    optionalText(input.ipc, 'IPC 分类号'), optionalText(input.techField, '技术领域'),
    optionalText(input.inventors, '发明人'), optionalText(input.applicant, '申请人'), optionalText(input.attorney, '代理师'),
    optionalText(input.workspacePath, '案卷目录'),
    JSON.stringify(input.extra ?? {}), at, at,
  )
  return getMatter(db, id) as MatterRow
}

export function updateMatter(db: DatabaseSync, id: string, patch: MatterPatch): MatterRow {
  const existing = getMatter(db, id)
  if (existing === undefined) throw new Error(`案卷不存在：${id}`)
  const sets: string[] = []
  const params: Array<string | number | null> = []
  const push = (column: string, value: string | number | null): void => { sets.push(`${column} = ?`); params.push(value) }

  if (patch.caseNumber !== undefined) {
    const caseNumber = requireText(patch.caseNumber, '案号')
    const clash = getMatterByCaseNumber(db, caseNumber)
    if (clash !== undefined && clash.id !== id) throw new Error(`案号「${caseNumber}」已被另一案卷占用`)
    push('case_number', caseNumber)
  }
  if (patch.title !== undefined) push('title', requireText(patch.title, '发明名称'))
  if (patch.clientId !== undefined) push('client_id', optionalText(patch.clientId, '客户'))
  if (patch.matterType !== undefined) push('matter_type', requireText(patch.matterType, '案型'))
  if (patch.patentKind !== undefined) push('patent_kind', optionalMember(patch.patentKind, PATENT_KINDS, '专利类型'))
  if (patch.stageCode !== undefined) push('stage_code', requireMember(patch.stageCode, MATTER_STAGE_CODES, '阶段'))
  if (patch.applicationNo !== undefined) push('application_no', optionalText(patch.applicationNo, '申请号'))
  if (patch.publicationNo !== undefined) push('publication_no', optionalText(patch.publicationNo, '公开号'))
  if (patch.patentNo !== undefined) push('patent_no', optionalText(patch.patentNo, '专利号'))
  if (patch.filingDate !== undefined) push('filing_date', optionalDate(patch.filingDate, '申请日'))
  if (patch.priorityDate !== undefined) push('priority_date', optionalDate(patch.priorityDate, '优先权日'))
  if (patch.claimsPriority !== undefined) push('claims_priority', (optionalBool(patch.claimsPriority, '是否主张优先权') ?? false) ? 1 : 0)
  if (patch.isPctNationalPhase !== undefined) push('is_pct_national', (optionalBool(patch.isPctNationalPhase, '是否 PCT 进入中国国家阶段') ?? false) ? 1 : 0)
  if (patch.ipc !== undefined) push('ipc', optionalText(patch.ipc, 'IPC 分类号'))
  if (patch.techField !== undefined) push('tech_field', optionalText(patch.techField, '技术领域'))
  if (patch.inventors !== undefined) push('inventors', optionalText(patch.inventors, '发明人'))
  if (patch.applicant !== undefined) push('applicant', optionalText(patch.applicant, '申请人'))
  if (patch.attorney !== undefined) push('attorney', optionalText(patch.attorney, '代理师'))
  if (patch.workspacePath !== undefined) push('workspace_path', optionalText(patch.workspacePath, '案卷目录'))
  if (patch.closedAt !== undefined) {
    if (patch.closedAt === null) push('closed_at', null)
    else {
      const closedAt = optionalDate(patch.closedAt, '归档日期')
      push('closed_at', closedAt)
    }
  }
  if (patch.extra !== undefined) push('extra', JSON.stringify(patch.extra))

  if (sets.length === 0) return existing

  // 归档时自动补归档日（只在 stage 变成 closed 且未显式给日期时），保持"归档有痕"。
  if (patch.stageCode === 'closed' && patch.closedAt === undefined) {
    sets.push('closed_at = ?')
    params.push(existing.closedAt ?? nowIso().slice(0, 10))
  }
  // 离开 closed 时清掉归档日，避免"重新打开却仍显示已归档"。
  if (patch.stageCode !== undefined && patch.stageCode !== 'closed' && patch.closedAt === undefined) {
    sets.push('closed_at = ?')
    params.push(null)
  }

  sets.push('updated_at = ?')
  params.push(nowIso())
  params.push(id)
  db.prepare(`UPDATE matters SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getMatter(db, id) as MatterRow
}

/**
 * 删除案卷。连带清除引用它的知识条目上的 `matter_id`（不留悬空指针），
 * 官文/期限/事件由外键级联删除（`PRAGMA foreign_keys = ON`）。
 */
/**
 * 会话的工作目录 → 案卷 id（阶段 5 · 决策 5.2.3「本案卷优先」的判定键）。
 *
 * ## 为什么用目录当键
 *
 * 案卷与任务/会话之间**没有**别的连接点：`matters` 是一等实体（D1），任务不承载案卷；
 * 而 `matters.workspace_path` 与会话的 `cwd` 是同一个东西 —— `patent-workspace/<案号>/`。
 * 这也是本仓已有的做法：`knowledge-recall.ts#resolveTaskId` 在没有 `task_sessions` 关联时
 * 就退到"按工作目录命名"反查任务。零新表、零新状态。
 *
 * ## 匹配规则（顺序即优先级）
 *
 * 1. **路径归一化**：分隔符统一成 `/`、去尾斜杠、转小写 ——
 *    与客户端 `client/workspacePath.ts` 的去重口径一致（Windows/macOS 都可能大小写不敏感）；
 * 2. **最长者优先**：`/a/案1` 与 `/a/案1/子` 都登记时，会话在子目录里要认**更具体**的那个；
 *    同长度按 `updated_at` 新的在前（SQL 里排好，取第一条即返回）；
 * 3. 只认**目录边界**（`target === base` 或以 `base + '/'` 开头），不做子串匹配 ——
 *    `/a/案1` 不许匹配到 `/a/案10`。
 *
 * 未登记 `workspace_path` 的案卷不参与匹配（没有可比的东西，不猜）。
 */
export function findMatterIdByWorkspacePath(db: DatabaseSync, cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') return null
  const target = normalizeWorkspacePath(cwd)
  if (target === '') return null
  const rows = db.prepare(`SELECT id, workspace_path FROM matters
    WHERE workspace_path IS NOT NULL AND workspace_path <> ''
    ORDER BY length(workspace_path) DESC, updated_at DESC`).all() as unknown as Array<{ id: string; workspace_path: string }>
  for (const row of rows) {
    const base = normalizeWorkspacePath(row.workspace_path)
    if (base === '') continue
    if (target === base || target.startsWith(`${base}/`)) return row.id
  }
  return null
}

/** 路径比较用的归一化（分隔符、尾斜杠、大小写）。只用于**比较**，不用于落库。 */
function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase()
}

export function deleteMatter(db: DatabaseSync, id: string): { deleted: boolean; detachedKnowledge: number } {
  const existing = getMatter(db, id)
  if (existing === undefined) return { deleted: false, detachedKnowledge: 0 }
  db.exec('BEGIN')
  try {
    const detached = db.prepare('UPDATE knowledge_entries SET matter_id = NULL, updated_at = ? WHERE matter_id = ?').run(nowIso(), id)
    db.prepare('DELETE FROM matters WHERE id = ?').run(id)
    db.exec('COMMIT')
    return { deleted: true, detachedKnowledge: Number(detached.changes) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function parseNotice(row: Record<string, unknown>): MatterNoticeRow {
  return {
    id: row.id as string,
    matterId: row.matter_id as string,
    noticeKind: row.notice_kind as NoticeKind,
    dispatchDate: row.dispatch_date as string,
    deliveryMode: row.delivery_mode as DeliveryMode,
    deliveryDate: (row.delivery_date ?? null) as string | null,
    designatedMonths: (row.designated_months ?? null) as number | null,
    fileLink: (row.file_link ?? null) as string | null,
    note: (row.note ?? null) as string | null,
    createdAt: row.created_at as string,
  }
}

export function listMatterNotices(db: DatabaseSync, matterId: string): MatterNoticeRow[] {
  const rows = db.prepare('SELECT * FROM matter_notices WHERE matter_id = ? ORDER BY dispatch_date DESC, created_at DESC').all(matterId) as unknown as Array<Record<string, unknown>>
  return rows.map(parseNotice)
}

export function createMatterNotice(db: DatabaseSync, input: MatterNoticeInput): MatterNoticeRow {
  if (getMatter(db, input.matterId) === undefined) throw new Error(`案卷不存在：${input.matterId}`)
  const noticeKind = requireMember(input.noticeKind, NOTICE_KINDS, '官文种类')
  const dispatchDate = optionalDate(input.dispatchDate, '发文日')
  if (dispatchDate === null) throw new Error('发文日不能为空')
  const deliveryMode = input.deliveryMode === undefined ? 'electronic' : requireMember(input.deliveryMode, DELIVERY_MODES, '送达方式')
  const deliveryDate = optionalDate(input.deliveryDate, '送达日')
  let designatedMonths: number | null = null
  if (input.designatedMonths !== undefined && input.designatedMonths !== null) {
    const months = input.designatedMonths
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('指定期限月数必须是 1–120 的整数')
    designatedMonths = months
  }
  /**
   * 一案只有一份的官文重复登记 → 当场拒绝。
   * 静默接受会让"先收到的那份"被忽略，而期限按后登记的那份算 —— 期限算错是最贵的错。
   * 与 patent-deadline 的 REPEATABLE_NOTICE_KINDS 同口径。
   */
  if (!REPEATABLE_NOTICE_KINDS.has(noticeKind)) {
    const dup = db.prepare('SELECT id FROM matter_notices WHERE matter_id = ? AND notice_kind = ?').get(input.matterId, noticeKind)
    if (dup !== undefined) throw new Error(`该案已登记过「${noticeKind}」；一案只有一份的官文不能重复登记（发错请先删除原记录）`)
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO matter_notices (id, matter_id, notice_kind, dispatch_date, delivery_mode, delivery_date, designated_months, file_link, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.matterId, noticeKind, dispatchDate, deliveryMode, deliveryDate, designatedMonths,
    optionalText(input.fileLink, '官文文件链接'), optionalText(input.note, '备注'), nowIso())
  return parseNotice(db.prepare('SELECT * FROM matter_notices WHERE id = ?').get(id) as Record<string, unknown>)
}

export function deleteMatterNotice(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM matter_notices WHERE id = ?').run(id).changes) > 0
}

function parseDeadline(row: Record<string, unknown>): MatterDeadlineRow {
  return {
    id: row.id as string,
    matterId: row.matter_id as string,
    deadlineKey: row.deadline_key as string,
    label: row.label as string,
    dueDate: row.due_date as string,
    dueDateRaw: row.due_date_raw as string,
    basis: (row.basis ?? null) as string | null,
    status: row.status as string,
    computedAt: row.computed_at as string,
    computedFrom: JSON.parse(row.computed_from as string) as Record<string, unknown>,
  }
}

export function listMatterDeadlines(db: DatabaseSync, matterId: string): MatterDeadlineRow[] {
  const rows = db.prepare('SELECT * FROM matter_deadlines WHERE matter_id = ? ORDER BY due_date ASC, deadline_key ASC').all(matterId) as unknown as Array<Record<string, unknown>>
  return rows.map(parseDeadline)
}

/**
 * 重算期限的落库入口（阶段 3 由 patent-deadline 服务的结果调用）。
 *
 * **保留用户已确认的状态**：同一个 `deadlineKey` 已存在时沿用其 `status`
 * （用户点过的「已办理」不因一次重算被刷回 pending）；新出现的 key 用传入值。
 * 其余字段（届满日/依据/计算输入快照）一律按新结果覆盖 —— 它们本来就是算出来的。
 */
export function replaceMatterDeadlines(db: DatabaseSync, matterId: string, rows: ReadonlyArray<MatterDeadlineInput>): MatterDeadlineRow[] {
  if (getMatter(db, matterId) === undefined) throw new Error(`案卷不存在：${matterId}`)
  const existing = new Map(listMatterDeadlines(db, matterId).map((row) => [row.deadlineKey, row.status]))
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.deadlineKey.trim() === '') throw new Error('期限标识（deadlineKey）不能为空')
    if (seen.has(row.deadlineKey)) throw new Error(`期限标识重复：${row.deadlineKey}`)
    seen.add(row.deadlineKey)
    if (normalizeCalendarDate(row.dueDate) === null) throw new Error(`届满日必须是 YYYY-MM-DD 的真实日期：${row.dueDate}`)
    if (normalizeCalendarDate(row.dueDateRaw) === null) throw new Error(`期限自身届满日必须是 YYYY-MM-DD 的真实日期：${row.dueDateRaw}`)
  }

  const at = nowIso()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM matter_deadlines WHERE matter_id = ?').run(matterId)
    const insert = db.prepare(`
      INSERT INTO matter_deadlines (id, matter_id, deadline_key, label, due_date, due_date_raw, basis, status, computed_at, computed_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of rows) {
      insert.run(randomUUID(), matterId, row.deadlineKey, row.label, row.dueDate, row.dueDateRaw,
        row.basis ?? null, existing.get(row.deadlineKey) ?? row.status ?? 'pending', at, JSON.stringify(row.computedFrom ?? {}))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return listMatterDeadlines(db, matterId)
}

/** 单条期限的状态更新（用户「已办理 / 已豁免」）。只认 pending/done/waived/overdue。 */
export function setMatterDeadlineStatus(db: DatabaseSync, id: string, status: string): MatterDeadlineRow {
  const allowed = ['pending', 'done', 'waived', 'overdue']
  if (!allowed.includes(status)) throw new Error(`期限状态非法，合法值：${allowed.join(' / ')}`)
  const changed = db.prepare('UPDATE matter_deadlines SET status = ? WHERE id = ?').run(status, id)
  if (Number(changed.changes) === 0) throw new Error(`期限记录不存在：${id}`)
  return parseDeadline(db.prepare('SELECT * FROM matter_deadlines WHERE id = ?').get(id) as Record<string, unknown>)
}

export interface MatterEventInput {
  matterId: string
  action: string
  artifact?: string | null
  approver?: string | null
  note?: string | null
  at?: string
}

export function listMatterEvents(db: DatabaseSync, matterId: string): MatterEventRow[] {
  const rows = db.prepare('SELECT * FROM matter_events WHERE matter_id = ? ORDER BY at ASC, id ASC').all(matterId) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as string,
    matterId: row.matter_id as string,
    action: row.action as string,
    artifact: (row.artifact ?? null) as string | null,
    approver: (row.approver ?? null) as string | null,
    note: (row.note ?? null) as string | null,
    at: row.at as string,
  }))
}

/**
 * 追加一条案卷事件（`_matter-log.md` 的只读投影）。
 * 只追加、不覆写 —— 这是案件审计链的投影方向，唯一事实源始终是 `_matter-log.md`。
 */
export function appendMatterEvent(db: DatabaseSync, input: MatterEventInput): MatterEventRow {
  if (getMatter(db, input.matterId) === undefined) throw new Error(`案卷不存在：${input.matterId}`)
  const action = requireText(input.action, '动作')
  const id = randomUUID()
  const at = input.at ?? nowIso()
  db.prepare('INSERT INTO matter_events (id, matter_id, action, artifact, approver, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.matterId, action, optionalText(input.artifact, '产物'), optionalText(input.approver, '审批人'), optionalText(input.note, '备注'), at)
  return listMatterEvents(db, input.matterId).find((event) => event.id === id) as MatterEventRow
}
