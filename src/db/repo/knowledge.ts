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
import { draftConfirmActorProblem, parseDraft, recordDraftRejection, safeJsonParse, withTransaction, type RawDraftRow } from './shared.js'
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

/**
 * 知识条目的**前像**（`knowledge_entry_revisions`，2026-10-07 灵枢调研 §7 第一步③）。
 *
 * ## 为什么需要它
 *
 * `updateKnowledge` 是**纯覆写**：`UPDATE ... SET content_md = ?` 一句下去，
 * 改之前那版正文**在库里就永远没有了**。知识条目是"攒下来的资产"，
 * 一次误改/一次 AI 自动归并写错，损失不可逆 —— 灵枢把这类"改前留一份"当基础设施做，
 * 这里也一样：改之前先把整行照抄一份进前像表。
 *
 * ## 字段命名（容易看错，特意点出来）
 *
 * ⚠️ `id` 是**前像自己的 id**（恢复时按它取）；`entryId` 才是知识条目的 id。
 * 其余字段与 `KnowledgeRow` 同义，且 `createdAt` / `updatedAt` 记的是**条目当时**的时间戳，
 * 不是前像的生成时间 —— 前像生成时间看 `archivedAt`。
 */
export interface KnowledgeRevisionRow extends KnowledgeRow {
  /** 这条前像属于哪个知识条目。 */
  entryId: string
  /** 条目内自 1 递增的版本号（同一条目被改 N 次就有 1..N 号前像）。 */
  revisionNo: number
  /** 前像生成时间：这一版是**什么时候被换掉**的。 */
  archivedAt: string
}

interface RawKnowledgeRevisionRow extends RawKnowledgeRow {
  entry_id: string
  revision_no: number
  archived_at: string
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

function parseKnowledgeRevision(row: RawKnowledgeRevisionRow | undefined): KnowledgeRevisionRow | undefined {
  if (row === undefined) return undefined
  const base = parseKnowledge(row)
  if (base === undefined) return undefined
  return { ...base, entryId: row.entry_id, revisionNo: row.revision_no, archivedAt: row.archived_at }
}

function getKnowledgeRevision(db: DatabaseSync, revisionId: string): KnowledgeRevisionRow | undefined {
  return parseKnowledgeRevision(db.prepare('SELECT * FROM knowledge_entry_revisions WHERE id = ?').get(revisionId) as RawKnowledgeRevisionRow | undefined)
}

/**
 * 把一行的**当前状态**照抄进前像表（改之前调用）。
 *
 * 为什么叫 archive 而不是 save：它的语义是"把即将被覆盖的那一版封存起来"，
 * 而不是"保存一个新版本"。调用点只有两个 —— `overwriteKnowledge`（覆写前，
 * `updateKnowledge` 与 `restoreKnowledgeRevision` 都经它）与
 * `deleteKnowledgeWithRefs`（删除前），都是"马上就要动它了"。
 *
 * `revision_no` 由本函数自己算（同一条目内 `MAX+1`），调用方不用管。
 * 前像 id 用 `randomUUID()` —— 与 `KnowledgeRow.id` 取值域完全分开，不会撞。
 */
function archiveKnowledgeRevision(db: DatabaseSync, entry: KnowledgeRow, at: string): void {
  const nextNo = (db.prepare('SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM knowledge_entry_revisions WHERE entry_id = ?').get(entry.id) as { n: number }).n
  db.prepare(`
    INSERT INTO knowledge_entry_revisions (id, entry_id, revision_no, kind_code, title, content_md, tags_json, source_task_id, source_session_id, source_review_id, matter_id, file_link, superseded_by_id, valid_until, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), entry.id, nextNo, entry.kindCode, entry.title, entry.contentMd, JSON.stringify(entry.tags), entry.sourceTaskId, entry.sourceSessionId, entry.sourceReviewId, entry.matterId, entry.fileLink, entry.supersededById, entry.validUntil, entry.createdAt, entry.updatedAt, at)
}

/**
 * 把 `next` 写回条目行（**覆写前先存前像**），且**不做任何字段校验**。
 *
 * ## 为什么单独抽这一层
 *
 * 校验（`assertKnownMatter` / `assertValidFileLink`）是**各条调用路径自己的事**，
 * 不是"覆写"这个动作的事 —— 两条路径的口径本来就该不同：
 *
 * - `updateKnowledge`：用户在 `PATCH /knowledge/:id` 里改数据 → **校验**，
 *   指向不存在的案卷当场报错（否则召回会悄悄少东西）；
 * - `restoreKnowledgeRevision`：把**早已躺在库里的历史快照**照抄回去 → **不校验**，
 *   它是回滚不是新写，见该函数的注释。
 *
 * 抽出来之前，还原路径是"委托 `updateKnowledge`"，于是**白白继承了用户写路径的校验**，
 * 与它自己"条目已删"那个裸 INSERT 分支自相矛盾（同一份前像，条目还在时还原会报
 * "案卷不存在"，条目被删后反而能还原）。
 *
 * ## 空改动的短路
 *
 * `next` 与 `before` 逐字段相同（**不含 `updatedAt`**，它每次都不同）时直接返回 `before`，
 * 既不存前像也不 UPDATE。理由见 `sameKnowledgeFields`。
 */
function overwriteKnowledge(db: DatabaseSync, before: KnowledgeRow, next: KnowledgeRow): KnowledgeRow {
  if (sameKnowledgeFields(before, next)) return before
  archiveKnowledgeRevision(db, before, next.updatedAt)
  db.prepare(`
    UPDATE knowledge_entries SET kind_code = ?, title = ?, content_md = ?, tags_json = ?, source_task_id = ?, source_session_id = ?, source_review_id = ?, matter_id = ?, file_link = ?, superseded_by_id = ?, valid_until = ?, updated_at = ?
    WHERE id = ?
  `).run(next.kindCode, next.title, next.contentMd, JSON.stringify(next.tags), next.sourceTaskId, next.sourceSessionId, next.sourceReviewId, next.matterId, next.fileLink, next.supersededById, next.validUntil, next.updatedAt, before.id)
  return next
}

/**
 * 两条知识行**除 `updatedAt` 外**是否逐字段相同（`tags` 逐项比，数组引用不同也算相同）。
 *
 * 为什么需要它：`updateKnowledge` 过去**无条件**走"存前像 + UPDATE"。于是
 * `PATCH` 一个空 body（或把一模一样的字段原样提交一次）也会：① 在历史里塞一条
 * 与当前内容逐字相同的前像；② 把 `updated_at` 刷成现在，让这条知识在
 * "最近更新"排序里窜到最前。用户看到的是"我什么都没改，它却说改过了、还多出一版历史"，
 * 而列表排序也被这次假更新带动 —— 静默制造了不存在的变化。
 */
function sameKnowledgeFields(a: KnowledgeRow, b: KnowledgeRow): boolean {
  return a.kindCode === b.kindCode
    && a.title === b.title
    && a.contentMd === b.contentMd
    && a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index])
    && a.sourceTaskId === b.sourceTaskId
    && a.sourceSessionId === b.sourceSessionId
    && a.sourceReviewId === b.sourceReviewId
    && a.matterId === b.matterId
    && a.fileLink === b.fileLink
    && a.supersededById === b.supersededById
    && a.validUntil === b.validUntil
}

/** 某条知识条目的前像，按版本号**从新到旧**（`011` = 最近一次被换掉的那版）。 */
export function listKnowledgeRevisions(db: DatabaseSync, entryId: string, limit = 50): KnowledgeRevisionRow[] {
  const rows = db.prepare('SELECT * FROM knowledge_entry_revisions WHERE entry_id = ? ORDER BY revision_no DESC LIMIT ?').all(entryId, Math.max(1, limit)) as unknown as RawKnowledgeRevisionRow[]
  return rows.map((row) => parseKnowledgeRevision(row)).filter((revision): revision is KnowledgeRevisionRow => revision !== undefined)
}

/**
 * 把某条前像**还原成条目的当前内容**（"改坏了，退回那一版"）。
 *
 * ## 还原本身也是可还原的
 *
 * 还原走的是 `overwriteKnowledge`，它在覆写前会把**当前**这一版也存成一条新前像。
 * 所以"退回去"这个动作不会把"退之前是什么样"烧掉，可以再退回来。
 *
 * ## 条目已被删时：连同原 id 复活
 *
 * 删除前也留了前像（见 `deleteKnowledgeWithRefs`），所以这里两种都支持：
 * 条目还在 → 覆写回那一版；条目已删 → 用**原 id** 重新插入（不是建个新条目，
 * 否则指向它的引用会全部断掉）。
 *
 * ## 刻意**不做**悬空引用校验（与 `PATCH /knowledge/:id` 分道扬镳）
 *
 * 还原是"把库里已有的历史快照照抄回去"，是**回滚**不是新写，所以两个分支
 * **都不校验** `matterId` / `supersededById` 指向的目标是否还在：
 *
 * - 条目已删的分支从来没校验过（它是裸 INSERT）；
 * - 条目还在的分支过去委托 `updateKnowledge`，于是**白白继承了用户写路径的
 *   `assertKnownMatter`** —— 同一份前像、同一个动作，条目还在时还原会报
 *   「案卷不存在」（400），条目被删后反而能还原成功。自相矛盾，而且**案卷被删之后
 *   条目恰恰最需要能还原**（否则改坏的内容就锁死在那里了）。
 *
 * 原文档写过一句"`matterId` 在正常写路径（`PATCH`）上本来就不校验目标是否存在"——
 * **那句话是错的**：`PATCH` 是校验的。以本段为准。
 *
 * 注：`fileLink` 仍然过 `assertValidFileLink`（两个分支都过），因为那是**格式**校验
 * （必须是绝对路径 / `file://`），与"目标是否还存在"无关，且失败时不会丢数据。
 *
 * @returns 还原后的条目；前像不存在 / 还原失败返回 undefined
 */
export function restoreKnowledgeRevision(db: DatabaseSync, revisionId: string, at = nowIso()): KnowledgeRow | undefined {
  return withTransaction(db, () => {
    const revision = getKnowledgeRevision(db, revisionId)
    if (revision === undefined) return undefined
    const current = getKnowledge(db, revision.entryId)
    const fields = {
      kindCode: revision.kindCode,
      title: revision.title,
      contentMd: revision.contentMd,
      tags: revision.tags,
      sourceTaskId: revision.sourceTaskId,
      sourceSessionId: revision.sourceSessionId,
      sourceReviewId: revision.sourceReviewId,
      matterId: revision.matterId,
      fileLink: revision.fileLink,
      supersededById: revision.supersededById,
      validUntil: revision.validUntil,
    }
    if (current !== undefined) {
      return overwriteKnowledge(db, current, { ...current, ...fields, fileLink: assertValidFileLink(fields.fileLink), updatedAt: at })
    }
    db.prepare(`
      INSERT INTO knowledge_entries (id, kind_code, title, content_md, tags_json, source_task_id, source_session_id, source_review_id, matter_id, file_link, superseded_by_id, valid_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(revision.entryId, fields.kindCode, fields.title, fields.contentMd, JSON.stringify(fields.tags), fields.sourceTaskId, fields.sourceSessionId, fields.sourceReviewId, fields.matterId, assertValidFileLink(fields.fileLink), fields.supersededById, fields.validUntil, revision.createdAt, at)
    return getKnowledge(db, revision.entryId)
  }, { immediate: true })
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

/**
 * 改一条知识条目（**用户写路径**：`PATCH /knowledge/:id`）。
 *
 * ⚠️ 覆写前**先把旧版存成前像**（同一个事务里，见 `overwriteKnowledge`），
 * 见 `KnowledgeRevisionRow` 的文件头说明：这是全仓唯一会永久丢掉知识正文的地方。
 *
 * 为什么包在 `withTransaction` 里：前像与覆写必须同生共死。分开写的话，
 * 第二条失败就会留下一份"存了前像但其实没改"的假历史 —— 用户点还原时看到的是
 * 一个跟自己当前内容一模一样的版本，等于骗他。
 *
 * ⚠️ `matterId` 给非空值时跑 `assertKnownMatter`（不存在 → 抛「案卷不存在」）：
 * 这是**用户在改数据**，归入一个不存在的案卷会让召回悄悄少东西。
 * 还原路径（`restoreKnowledgeRevision`）刻意不走这条校验，两条路径的口径差异
 * 在 `overwriteKnowledge` 的注释里讲清了。
 *
 * `patch` 与现值逐字段相同时**不写库**：返回原行（连 `updatedAt` 都不动），
 * 见 `sameKnowledgeFields`。
 */
export function updateKnowledge(db: DatabaseSync, id: string, patch: Partial<KnowledgeInput>, at = nowIso()): KnowledgeRow | undefined {
  return withTransaction(db, () => {
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
    return overwriteKnowledge(db, before, next)
  }, { immediate: true })
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
  return withTransaction(db, () => {
    /**
     * 删除前也留一份前像（2026-10-07 灵枢调研 §7 第一步③）。
     *
     * 为什么删除也要留：这是知识域里**唯一**会让正文彻底消失的操作，
     * 比"改坏了"还严重 —— 改坏了还能靠前像退回，删了连条目本身都没有了。
     * 留一份，至少数据还在（`restoreKnowledgeRevision` 会用原 id 把它复活）。
     *
     * ⚠️ 只给**被删的那一条**留像。被牵连的邻居（`superseded_by_id` 被置空的那几条）
     * **刻意不留** —— 它们的正文一个字都没动，改的只是一个引用列；为这个动作造一份
     * 跟当前内容完全相同的前像，只会在"历史"里塞一堆没有信息量的重复版本。
     */
    const doomed = getKnowledge(db, id)
    if (doomed !== undefined) archiveKnowledgeRevision(db, doomed, nowIso())
    // 先看有哪些行会被牵连（要在 UPDATE 之前数，UPDATE 之后条件已不成立）
    const rows = db.prepare('SELECT id FROM knowledge_entries WHERE superseded_by_id = ?').all(id) as unknown as Array<{ id: string }>
    const clearedRefs = rows.length
    if (clearedRefs > 0) db.prepare('UPDATE knowledge_entries SET superseded_by_id = NULL, updated_at = updated_at WHERE superseded_by_id = ?').run(id)
    const deleted = db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0
    return { deleted, clearedRefs }
  }, { immediate: true })
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
  /**
   * 发起人守卫**必须排在"内容类留痕"前面**（独立审查抓到的缺陷）。
   *
   * `withDraftConfirm` 里有一份同样的守卫，但它要到函数末尾那次调用才跑 ——
   * 中间隔着下面这个"校验不通过就 `recordDraftRejection`"的分支。于是一个非用户 actor
   * 撞上一条**内容本身也不合法**的知识草稿时，会先把"调用方的 bug"记成一次
   * "用户驳回了这条草稿"：`rejection_count` 加一、`rejected_at` 被打上时间戳。
   * `withDraftConfirm` 的注释逐字禁止这件事（"actor 不对是调用方的 bug……不许混进
   * `rejection_count` 让统计失真"），所以判据只有一份、也必须提前：
   * `draftConfirmActorProblem`，非 `'user'` 直接在**任何写库之前**抛错。
   */
  const actorProblem = draftConfirmActorProblem(draft, actor)
  if (actorProblem !== null) throw new Error(actorProblem)
  const payload = draft.payload as { sourceSessionId?: string; supersededById?: string | null; validUntil?: string | null }
  const rejection = knowledgeDraftRejection(draft.payload)
  if (rejection !== null) {
    /**
     * 校验不通过**也要留痕**（负记忆，2026-10-07 灵枢调研 §7 第一步②）。
     *
     * 原先这里只 `throw`：错误弹一下、弹层一关，库里没有任何地方记得
     * 「这条草稿确认失败过、因为什么」—— 用户下次点确认只会看到一模一样的报错，
     * 提交草稿的 AI 也永远不知道自己的产出被卡在哪。
     *
     * 刻意**不动 `status_code`**：校验失败的知识草稿仍是 `pending`，
     * 用户改好字段后还能原地重试（`withDraftConfirm` 的守卫依赖 pending）。
     * 这里只把「被拒」这件事写进草稿行自己的三个列。
     */
    recordDraftRejection(db, draftId, rejection, at)
    throw new Error(rejection)
  }
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
  }, at), { at, actor })
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
