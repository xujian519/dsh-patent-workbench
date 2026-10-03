/**
 * 知识库域（V2.5：个人知识库 / 错题集）。
 *
 * ## `matter_id`（阶段 5 · 决策 5.2.1）
 *
 * 列在迁移 20 就加了（可空、老条目 `NULL`、行为不变），但当时**没有任何读写方** ——
 * 阶段 5 才接上。语义与 `source_task_id` **并存**，两者回答不同问题：
 *
 * - `source_task_id` = "这条经验是哪次干活沉淀的"（自动写入，人不管）；
 * - `matter_id` = "这条经验属于哪个案卷"（**用户/AI 显式归入**，可改可清）。
 *
 * 于是召回可以做"本案卷优先"（`knowledge-recall.ts#candidates`），
 * 而"来源任务"的溯源链一点不受影响。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出，调用方无需改 import。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, withDraftConfirm, type DraftRow } from '../repo.js'
import { parseDraft, safeJsonParse, type RawDraftRow } from './shared.js'
import { knowledgeDraftRejection, normalizeKnowledgeDraftPayload } from '../../shared/knowledgeDraftPayload.js'


export interface KnowledgeInput {
  kindCode?: string
  title: string
  contentMd?: string
  tags?: string[]
  sourceTaskId?: string | null
  sourceSessionId?: string | null
  sourceReviewId?: string | null
  /** 归入的案卷（`matters.id`；null = 未归入）。与 `sourceTaskId` 并存，语义不同（见文件头）。 */
  matterId?: string | null
  fileLink?: string | null
  /** 本条已被哪条取代（非空即在召回时压制，见 schema v18）。 */
  supersededById?: string | null
  /** 有效期截止（ISO 时间；到点后压制）。 */
  validUntil?: string | null
}

export interface KnowledgeRow {
  id: string
  kindCode: string
  title: string
  contentMd: string
  tags: string[]
  sourceTaskId: string | null
  sourceSessionId: string | null
  sourceReviewId: string | null
  /** 归入的案卷（`matters.id`；null = 未归入）。 */
  matterId: string | null
  fileLink: string | null
  /** 已被哪条取代（null = 仍然有效）。 */
  supersededById: string | null
  /** 有效期截止（null = 不过期）。 */
  validUntil: string | null
  createdAt: string
  updatedAt: string
}

interface RawKnowledgeRow {
  id: string
  kind_code: string
  title: string
  content_md: string
  tags_json: string
  source_task_id: string | null
  source_session_id: string | null
  source_review_id: string | null
  matter_id?: string | null
  file_link: string | null
  superseded_by_id?: string | null
  valid_until?: string | null
  created_at: string
  updated_at: string
}

/** 校验并规整知识条目本地文件链接：支持 file:// URL 或绝对路径，拒绝相对路径/空值。 */
export function normalizeFileLink(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function assertValidFileLink(value: string | null | undefined): string | null {
  const link = normalizeFileLink(value)
  if (link === null) return null
  if (!/^file:/i.test(link) && !/^[A-Za-z]:[\\/]/.test(link) && !link.startsWith('/')) {
    throw new Error('fileLink must be a file:// URL or an absolute path')
  }
  return link
}

function parseKnowledge(row: RawKnowledgeRow | undefined): KnowledgeRow | undefined {
  if (row === undefined) return undefined
  const tags = safeJsonParse<unknown>(row.tags_json, [])
  return {
    id: row.id,
    kindCode: row.kind_code,
    title: row.title,
    contentMd: row.content_md,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    sourceReviewId: row.source_review_id,
    matterId: row.matter_id ?? null,
    fileLink: row.file_link ?? null,
    supersededById: row.superseded_by_id ?? null,
    validUntil: row.valid_until ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 案卷 id 的存在性校验：给一个不存在的 `matter_id` 就报错，**不静默写 NULL**。
 *
 * 为什么必须有：`matter_id` 是纯 TEXT 列（SQLite 的 `ALTER TABLE ADD COLUMN` 加不了外键，
 * 而且我们只前向迁移），所以库里会出现悬空引用。悬空引用的后果是**召回悄悄少东西**：
 * 知识归入了一个不存在的案卷 → "本案卷优先"永远命中不到它 → 用户只会觉得"它怎么不出现"。
 * 静默改写/静默丢件是本仓明令禁止的，所以这里显式抛错（调用方是 HTTP 路由 → 400 中文原因）。
 */
function assertKnownMatter(db: DatabaseSync, matterId: string | null | undefined): string | null {
  if (matterId === undefined || matterId === null || matterId === '') return null
  const row = db.prepare('SELECT id FROM matters WHERE id = ?').get(matterId)
  if (row === undefined) throw new Error(`案卷不存在：${matterId}`)
  return matterId
}

export function createKnowledge(db: DatabaseSync, input: KnowledgeInput, at = nowIso()): KnowledgeRow {
  const id = randomUUID()
  const fileLink = assertValidFileLink(input.fileLink)
  db.prepare(`
    INSERT INTO knowledge_entries (id, kind_code, title, content_md, tags_json, source_task_id, source_session_id, source_review_id, matter_id, file_link, superseded_by_id, valid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.kindCode ?? 'note', input.title, input.contentMd ?? '', JSON.stringify(input.tags ?? []), input.sourceTaskId ?? null, input.sourceSessionId ?? null, input.sourceReviewId ?? null, assertKnownMatter(db, input.matterId), fileLink, input.supersededById ?? null, input.validUntil ?? null, at, at)
  return getKnowledge(db, id)!
}

export function getKnowledge(db: DatabaseSync, id: string): KnowledgeRow | undefined {
  return parseKnowledge(db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as RawKnowledgeRow | undefined)
}

export function listKnowledge(db: DatabaseSync, opts: { q?: string; kindCode?: string; sourceTaskId?: string; sourceReviewId?: string; matterId?: string; limit?: number } = {}): KnowledgeRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.kindCode !== undefined) { conditions.push('kind_code = ?'); params.push(opts.kindCode) }
  if (opts.sourceTaskId !== undefined) { conditions.push('source_task_id = ?'); params.push(opts.sourceTaskId) }
  if (opts.sourceReviewId !== undefined) { conditions.push('source_review_id = ?'); params.push(opts.sourceReviewId) }
  if (opts.matterId !== undefined) { conditions.push('matter_id = ?'); params.push(opts.matterId) }
  if (typeof opts.q === 'string' && opts.q.trim() !== '') {
    const like = `%${opts.q.trim()}%`
    conditions.push('(title LIKE ? OR content_md LIKE ? OR tags_json LIKE ? OR file_link LIKE ?)')
    params.push(like, like, like, like)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  /**
   * 上限 5000（v1.15.4 从 500 提上来）：知识库自动召回需要**全量**候选，
   * 500 会让第 501 条起永远召不回来（实测 523 条时静默少 23 条）。
   * 没有调用方传过 >500，所以这次放宽不改变既有行为。
   */
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000))
  const rows = db.prepare(`SELECT * FROM knowledge_entries ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params, limit) as unknown as RawKnowledgeRow[]
  return rows.map((row) => parseKnowledge(row)).filter((entry): entry is KnowledgeRow => entry !== undefined)
}

export function updateKnowledge(db: DatabaseSync, id: string, patch: Partial<KnowledgeInput>, at = nowIso()): KnowledgeRow | undefined {
  const before = getKnowledge(db, id)
  if (before === undefined) return undefined
  const next: KnowledgeRow = {
    ...before,
    kindCode: patch.kindCode ?? before.kindCode,
    title: patch.title ?? before.title,
    contentMd: patch.contentMd ?? before.contentMd,
    tags: patch.tags ?? before.tags,
    sourceTaskId: patch.sourceTaskId === undefined ? before.sourceTaskId : patch.sourceTaskId,
    sourceSessionId: patch.sourceSessionId === undefined ? before.sourceSessionId : patch.sourceSessionId,
    sourceReviewId: patch.sourceReviewId === undefined ? before.sourceReviewId : patch.sourceReviewId,
    matterId: patch.matterId === undefined ? before.matterId : assertKnownMatter(db, patch.matterId),
    fileLink: patch.fileLink === undefined ? before.fileLink : assertValidFileLink(patch.fileLink),
    supersededById: patch.supersededById === undefined ? before.supersededById : patch.supersededById,
    validUntil: patch.validUntil === undefined ? before.validUntil : patch.validUntil,
    updatedAt: at,
  }
  db.prepare(`
    UPDATE knowledge_entries SET kind_code = ?, title = ?, content_md = ?, tags_json = ?, source_task_id = ?, source_session_id = ?, source_review_id = ?, matter_id = ?, file_link = ?, superseded_by_id = ?, valid_until = ?, updated_at = ?
    WHERE id = ?
  `).run(next.kindCode, next.title, next.contentMd, JSON.stringify(next.tags), next.sourceTaskId, next.sourceSessionId, next.sourceReviewId, next.matterId, next.fileLink, next.supersededById, next.validUntil, next.updatedAt, id)
  return next
}

/**
 * 删除一条知识条目。
 *
 * ⚠️ **必须顺带清掉指向它的取代引用**（P2，独立审查抓到的中危缺陷）。
 *
 * `superseded_by_id` 是纯 TEXT 列，没有外键（SQLite 的 `ALTER TABLE ADD COLUMN`
 * 加不了 `REFERENCES`，而且我们只前向迁移），所以"目标被删"不会自动置空。
 * 后果很隐蔽：删掉那条**修正条**之后，被它取代的旧条目会**永久静默压制** ——
 * 召回里再也看不到它，日志只说"1 条已被取代/已过期"，**没有任何地方指出那个 id 已不存在**；
 * 按 id 直读还会打印"⚠️ 本条已被 [死 id] 取代"。
 *
 * 所以删除必须在**同一个事务**里：先把指向它的引用置空（旧条目随之恢复为有效），再删。
 * 返回值里的 `clearedRefs` 让调用方（HTTP 路由）能把这件事**回显给用户** ——
 * 静默改写字段是本仓禁止的，这里也一样：用户需要知道"删这条会连带恢复 N 条"。
 */
export function deleteKnowledgeWithRefs(db: DatabaseSync, id: string): { deleted: boolean; clearedRefs: number } {
  db.exec('BEGIN')
  try {
    // 先看有哪些行会被牵连（要在 UPDATE 之前数，UPDATE 之后条件已不成立）
    const rows = db.prepare('SELECT id FROM knowledge_entries WHERE superseded_by_id = ?').all(id) as unknown as Array<{ id: string }>
    const clearedRefs = rows.length
    if (clearedRefs > 0) db.prepare('UPDATE knowledge_entries SET superseded_by_id = NULL, updated_at = updated_at WHERE superseded_by_id = ?').run(id)
    const deleted = db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0
    db.exec('COMMIT')
    return { deleted, clearedRefs }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function deleteKnowledge(db: DatabaseSync, id: string): boolean {
  return deleteKnowledgeWithRefs(db, id).deleted
}

/**
 * 确认一份知识草稿 → 落库成知识条目。
 *
 * 字段名走**唯一口径** `shared/knowledgeDraftPayload.ts`：既认工具参数名的 snake_case
 * 别名（`content_md` / `source_task_id` / `file_link` …），也在缺标题/正文时给出可读的
 * 中文原因（并列出本次 payload 的键）。
 *
 * 为什么读侧也要归一（而不是只在校验入口收干净）：本次缺陷（2026-10-03）里那条草稿
 * **已经躺在库里**（1668 字正文写在 `content_md` 下）。读侧归一让它不用改数据、不用迁移
 * 就能显示、能入库 —— 用户点一次「确认入库」就能把内容救回来。
 */
export function confirmKnowledgeDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): KnowledgeRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'knowledge') return undefined
  const payload = draft.payload as { sourceSessionId?: string; supersededById?: string | null; validUntil?: string | null }
  const rejection = knowledgeDraftRejection(draft.payload)
  if (rejection !== null) throw new Error(rejection)
  const { payload: fields } = normalizeKnowledgeDraftPayload(draft.payload)
  return withDraftConfirm(db, draftId, 'knowledge', () => createKnowledge(db, {
    kindCode: fields.kindCode,
    // 标题照旧 trim（与 `workbench_submit_knowledge`、`POST /knowledge` 两条建入路径同口径）。
    title: fields.title.trim(),
    contentMd: fields.contentMd,
    tags: fields.tags,
    sourceTaskId: fields.sourceTaskId,
    sourceSessionId: typeof payload.sourceSessionId === 'string' ? payload.sourceSessionId : draft.sessionId,
    sourceReviewId: fields.sourceReviewId,
    /**
     * 归入的案卷：草稿里写了就照写（`createKnowledge` 会校验存在性，不存在 → 中文 400）。
     * 以前这里**根本不传** `matterId`，草稿上写了案卷也会被静默丢掉 —— 与
     * 「归入案卷」在条目建入路径上的语义（可显式归入）不一致，索性一并接上。
     */
    matterId: fields.matterId,
    fileLink: fields.fileLink,
    supersededById: typeof payload.supersededById === 'string' ? payload.supersededById : null,
    validUntil: typeof payload.validUntil === 'string' ? payload.validUntil : null,
  }, at), { at })
}

export function getPendingKnowledgeDraft(db: DatabaseSync, sessionId: string | null): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'knowledge' ORDER BY created_at DESC").all() as unknown as Array<{
    id: string
    kind_code: string
    session_id: string | null
    payload_json: string
    status_code: string
    created_at: string
    updated_at: string
  }>
  for (const row of rows) {
    if (row.session_id !== sessionId) continue
    // 统一走 parseDraft，避免新增草稿字段时各处手写映射漏字段。
    return parseDraft(row as unknown as RawDraftRow)
  }
  return undefined
}
