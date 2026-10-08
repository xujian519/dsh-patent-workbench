/**
 * repo 层共享原语：时间、草稿行类型与读取、草稿确认骨架。
 *
 * 从 repo.ts 原样抽出（行为不变）。各领域模块依赖本文件；repo.ts 再导出以保持对外 API。
 * 本文件不依赖任何其他 repo 模块，避免循环依赖。
 */
import type { DatabaseSync } from 'node:sqlite'

/**
 * 事务句柄：交给 `fn` 的**唯一**控制手段。
 *
 * 为什么需要 `rollback()`：本仓有一批"先读、发现不该写就返回"的函数
 * （`addDailyPlanItem` / `updateDailyPlanItem` 最典型），历史上它们的写法是
 * `db.exec('ROLLBACK'); return { ok: false, … }`。收敛到本原语后若没有显式回滚口，
 * 这些分支只能变成"COMMIT 一个什么都没写的事务" —— 当下等价，但**下一个人在那个
 * 分支前加一句写入，就会被静默提交**。留着显式回滚口，意图与安全性一起保住。
 */
export interface TxHandle {
  /** 请求回滚：`fn` 正常返回后由本原语执行 `ROLLBACK`（而不是 `COMMIT`）。 */
  rollback(): void
}

/**
 * 在事务里跑 `fn`；**已经在事务里时直接执行**。
 *
 * 为什么必须嵌套感知：`createTask` 之类的写入既被直接调用，也会在 `withDraftConfirm`
 * 的事务里被调用（确认草稿 → 建任务）。无条件 `BEGIN` 会让后者抛
 * "cannot start a transaction within a transaction"（node:sqlite 实测）。
 *
 * 存在理由：实体写入与配套的 `task_events` 审计事件必须同生共死 ——
 * 原先各处裸写，第二条失败就留下"事件与实体不一致"的库。
 *
 * ## `immediate`（2026-10-05 补，替代各处的裸 `BEGIN IMMEDIATE`）
 *
 * 默认 `BEGIN` 是**延迟**事务：先只拿读锁，等第一条写入再升级成写锁。
 * "先读后写"的事务（读快照 → 按快照改 JSON 列）若两个连接同时这样做，
 * 后升级的那个会拿到 `SQLITE_BUSY`（且 sqlite 为了防死锁**不重试**这个升级），
 * 于是一次读-改-写会平白失败。`immediate: true` 一进来就拿写锁，
 * 配合 `busy_timeout`（见 `database.ts`）就是"排队等"而不是"当场失败"。
 *
 * 所以口径是：**只要事务里有写入，就该用 `immediate: true`**；
 * 纯读事务用默认值即可。
 */
export function withTransaction<T>(
  db: DatabaseSync,
  fn: (tx: TxHandle) => T,
  options: { immediate?: boolean } = {},
): T {
  if (db.isTransaction) {
    /**
     * 嵌套：外层事务拥有提交/回滚权，本层只借用它的原子性。
     *
     * 此时 `rollback()` 无法兑现 —— 单独回滚本层在 SQLite 里不存在这回事
     * （没有 savepoint 的话）。**响亮拒绝，不假装成功**：静默降级成"不回滚"
     * 会让调用方以为数据没写进去，是更坏的结果。
     */
    return fn({
      rollback: () => {
        throw new Error('嵌套事务里不能单独回滚：外层事务决定提交或回滚（要局部回滚请用 SAVEPOINT）')
      },
    })
  }
  db.exec(options.immediate === true ? 'BEGIN IMMEDIATE' : 'BEGIN')
  let rollbackRequested = false
  try {
    const result = fn({ rollback: () => { rollbackRequested = true } })
    db.exec(rollbackRequested ? 'ROLLBACK' : 'COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚过/broken transaction 不能掩盖原始错误 */ }
    throw error
  }
}

export const nowIso = (): string => new Date().toISOString()

export interface DraftRow {
  id: string
  kindCode: string
  sessionId: string | null
  payload: Record<string, unknown>
  statusCode: string
  /** 非空表示该草稿已「暂存」：仍是 pending，但不再自动弹窗 */
  deferredAt: string | null
  /** 累计暂存次数（用于展示"第 N 次"） */
  deferCount: number
  /**
   * 非空表示**被拒过**，内容是最近一次被拒的原因原文（用户填的驳回理由，
   * 或确认时校验失败的中文原因）。`null` = 从未被拒。
   */
  rejectionReason: string | null
  /** 最近一次被拒的时间；`null` = 从未被拒。 */
  rejectedAt: string | null
  /** 累计被拒次数（用户反复驳回 / 确认反复校验失败）。 */
  rejectionCount: number
  /**
   * 这条草稿是谁建的（迁移 v25）。`'ai'` / `'user'` / `null`。
   *
   * `null` **不是**"用户建的"，而是"**未记录**"—— v25 上线前建的行没处问去。
   * 守卫据此放行老草稿（见 `withDraftConfirm`），不许把 `null` 当成任何一种身份。
   *
   * 今天恒为 `'ai'`（全部 `createDraft` 调用点都在 AI 侧，理由与默认值取向见
   * `DraftInput.createdBy`）—— **不要**为了"让这个字段有用"而补一个 `'user'` 写入点：
   * `draftConfirmActorProblem` 正拿这个值拼**安全诊断句**（"这条草稿是 AI 提交的"），
   * 把 AI 的草稿记成"人提交的"不是少一个功能，是让那句提示说谎。
   */
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface RawDraftRow {
  id: string
  kind_code: string
  session_id: string | null
  payload_json: string
  status_code: string
  deferred_at?: string | null
  defer_count?: number | null
  rejection_reason?: string | null
  rejected_at?: string | null
  rejection_count?: number | null
  created_by?: string | null
  created_at: string
  updated_at: string
}

/**
 * 行内 JSON 列的**安全解析**：坏 JSON 不再让整批读请求失败。
 *
 * 为什么必须有：`task_drafts.payload_json` / `tasks.extra` 这类列在任何一次手改库、
 * 半截写入或旧格式残留下都可能不是合法 JSON。原先各 repo 裸 `JSON.parse`，
 * 一条脏行就让 `GET /tasks`、`GET /drafts` 整批 500，且报错里看不出是哪一行。
 * 这里降级为 `fallback`，行本身仍然返回（不丢数据、不牵连其它行）。
 *
 * ⚠️ **迁移里不使用**：迁移遇到坏 JSON 应当响亮失败，静默降级会吞掉数据损坏信号。
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function parseDraft(row: RawDraftRow | undefined): DraftRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    kindCode: row.kind_code,
    sessionId: row.session_id,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    statusCode: row.status_code,
    deferredAt: row.deferred_at ?? null,
    deferCount: row.defer_count ?? 0,
    rejectionReason: row.rejection_reason ?? null,
    rejectedAt: row.rejected_at ?? null,
    rejectionCount: row.rejection_count ?? 0,
    // 老库（列还不存在时打开的行对象）没有这个键 → `null` = 未记录，**不是** 'user'。
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 记一次「被拒」（负记忆，2026-10-07 灵枢调研 §7 第一步②）。
 *
 * ## 为什么必须有它
 *
 * 此前"草稿没被采纳"这件事**大部分时候是静默的**：
 *
 * - 用户放弃草稿时填的理由，只有在草稿**恰好带着一个存在的 `taskId`** 时，
 *   才会经由 `routes/drafts.ts#recordDraftFeedback` 写进任务事件与共享记忆；
 *   知识类草稿（`payload` 里没有 taskId）被驳回时，理由**当场丢弃**。
 * - 确认时校验不通过（`knowledge requires content` 这类）只抛一个错误给界面，
 *   弹出层一关，**库里没有任何地方记得"这条草稿确认失败过、因为什么"** ——
 *   用户下次点确认只会看到一模一样的报错，AI 也永远不知道自己的产出被卡住了。
 *
 * 灵枢（dsh-memory）的做法是把 REJECT 落进 `rejected/` 层**留痕可查**。
 * 这里落在草稿行自己身上：**只加列，不改 `status_code` 语义**——
 * `pending` 仍然可以重提（校验失败的知识草稿正是靠这一点才能改好后重试），
 * `abandoned` 仍然是被用户主动终结的终态。
 *
 * ## 口径
 *
 * 只记"最近一次"的原因与时间，累计次数单列。不存历史列表：真要看历史，
 * 任务事件（`draft_rejected` / `draft_deferred`）里本来就有，这里要的是
 * **一眼可见的当前状态**，不是审计日志。
 *
 * `reason` 为空白串时只计数、不写 `rejection_reason`（`null`）—— 用户没填理由
 * 不该被编造成有理由。
 */
export function recordDraftRejection(db: DatabaseSync, id: string, reason: string, at = nowIso()): void {
  const trimmed = reason.trim()
  db.prepare(`
    UPDATE task_drafts
       SET rejection_reason = ?, rejected_at = ?, rejection_count = rejection_count + 1, updated_at = ?
     WHERE id = ?
  `).run(trimmed === '' ? null : trimmed, at, at, id)
}

export function getDraft(db: DatabaseSync, id: string): DraftRow | undefined {
  return parseDraft(db.prepare('SELECT * FROM task_drafts WHERE id = ?').get(id) as RawDraftRow | undefined)
}

export function setDraftStatus(db: DatabaseSync, id: string, statusCode: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run(statusCode, at, id)
}

/**
 * 确认过的草稿里记住"这次确认到底建了什么"，供**重复确认**原样回放。
 *
 * ## 为什么必须有它（2026-09-13 真实事故）
 *
 * 用户报「快速录入 → AI 执行 → 验收后，待处理里多出一条同名任务」。实测根因：
 * `POST /api/workbench/drafts/:id/confirm` **不检查草稿是否已经是 confirmed**，
 * 而 `withDraftConfirm` 也没有这道守卫 ——
 * 同一条 task 草稿被确认两次就**建出两条任务**（复现见
 * `node scripts/repro/repro-routes.mjs`：第一次 200 建任务，第二次 200 又建一条）。
 *
 * 草稿确认是**幂等语义**：一条草稿 = 一次决定 = 一个产出。
 * 第二次确认不该再建，也不该 400 报错（前端并发点击、网络重试都会走到这里），
 * 而应当**回放第一次的结果**。
 *
 * ## 为什么写在 payload 里
 *
 * 与复盘草稿的 `reviewId` 回写同一个套路（见 `drafts.ts` 的 review 分支）：
 * 加字段要动 schema，而 schema **只单向前进**，不能为了一件"幂等"去冒迁移风险。
 */
export function getDraftConfirmResult<T = unknown>(draft: DraftRow): T | undefined {
  return draft.payload.confirmResult as T | undefined
}


/**
 * 「写入者不得自裁」：确认草稿的**发起人**必须是用户（迁移 v25 一并引入的守卫）。
 *
 * ## 业务判据
 *
 * 草稿确认 = 内容真正入库 = 一次决定。在专利业务里这是**执业红线**：
 * **AI 不能替代理人拍板**。所以判据不是"AI 建的草稿 AI 不能确认"这一条窄规则，
 * 而是更直白的 —— **任何非 `'user'` 的 actor 都不许确认**：
 *
 * - `'ai'` 确认自己建的草稿：最严重的那种（自裁），也是调研文档点名的形态；
 * - `'ai'` 确认用户建的草稿：同样是"AI 替用户拍板"，一样不行；
 * - `'system'`：今天不存在这条路径；将来真要做定时自动入库，**必须回来改这道断言**
 *   （fail-closed 的意义就在这里 —— 让它响亮地失败，而不是悄悄放行）。
 *
 * ## 口径：`created_by` 决定**措辞**，不决定**是否拦**
 *
 * 拦不拦只看 `actor`；`created_by` 只用来把话说清楚（"这条草稿是 AI 提交的"）。
 * 若把条件写成 `createdBy === 'ai' && actor !== 'user'`，用户建的草稿就能被 AI 确认 ——
 * 那不是"防自裁"，是给红线开了个后门。
 *
 * ## `null`（v25 之前的行）放行
 *
 * 老草稿没处问来源。拿一个它出生时还不存在的规矩去卡它，只会把用户挡在自己的数据外面。
 *
 * @returns 拒绝原因（中文，可直接抛给用户/界面）；`null` = 放行。
 */
export function draftConfirmActorProblem(draft: DraftRow, actor: string): string | null {
  if (actor === 'user') return null
  const who = draft.createdBy === 'ai'
    ? '这条草稿是 AI 提交的'
    : draft.createdBy === 'user' ? '这条草稿是人提交的' : '这条草稿未记录来源（v25 之前建的）'
  return `错误：草稿确认只能由用户执行，收到 actor=「${actor}」（${who}）。`
    + '确认即入库，属于只有用户能做的决定；若确实需要自动入库，请显式修改该判定，不要绕过。'
}

/**
 * 草稿确认的公共骨架：取草稿 → 校验 kind / 发起人 / 状态 → 开事务 → 执行业务 → 标记 confirmed → 提交/回滚。
 *
 * 抽出来的原因：7 个 confirm*Draft 曾各自重复这 6 步（连 ROLLBACK 分支都一字不差），
 * 任何一步改动都要改 7 处。现在各函数只负责"确认时具体建什么"。
 *
 * 发起人校验（`options.actor`）也放在这里：4 个确认入口共用同一点，
 * 将来新增第 5 种草稿类型时**天生带着**这道守卫，不需要记得单独加。
 *
 * ## 幂等（2026-09-13 补，针对"确认两次建两条任务"的真实事故）
 *
 * 确认成功时把产出回写进 payload（`confirmResult`）；**同一份产出落两次地**这件事
 * 从此结构上不可能：第二次确认走 `options.replay`，原样回放第一次的结果。
 *
 * 两道判断缺一不可：
 *
 * 1. 草稿已是 `confirmed` **且** payload 里有 `confirmResult` → 回放（这条是老草稿恢复路径）；
 * 2. 草稿仍是 `pending` 但 payload 里已有 `confirmResult` → 同样回放，**且把状态补成
 *    confirmed**（守卫上线前"建了东西却没标状态"的半截数据，靠这一步自愈）。
 *
 * 状态不是 `pending` 且没有可回放的产出时，**绝不执行 build** —— 直接返回 `emptyValue`。
 *
 * 为什么不是"返回 400 让调用方自己处理"：前端并发点击、网络级重试都会命中，
 * 用户想要的结果（东西建好了、弹框收起来）其实已经达成，报错只会让人以为失败了。
 *
 * @param kindCode 期望的草稿类型；不匹配返回 undefined（保持既有语义）
 * @param emptyValue kind 匹配但业务产出为空时的返回值（部分函数历史上返回 [] 而非 undefined）
 * @param actor 发起确认的人；**缺省 `'user'`**（4 个生产调用点今天都是用户点的）。
 *   非 `'user'` 一律抛错，见 `draftConfirmActorProblem`。
 */
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; actor?: string; emptyValue: T; replay?: (cached: unknown, draft: DraftRow) => T },
): T
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options?: { at?: string; actor?: string; replay?: (cached: unknown, draft: DraftRow) => T },
): T | undefined
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; actor?: string; emptyValue?: T; replay?: (cached: unknown, draft: DraftRow) => T } = {},
): T | undefined {
  const at = options.at ?? nowIso()
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== kindCode) return options.emptyValue
  /**
   * 发起人守卫放在**回放分支之前**，也放在**事务之前**：
   *
   * - 在回放之前：非用户连"读回上次的产出"都不该触发 —— 确认这个动作本身就不许他发起；
   * - 在事务之前：拒绝时**一条数据都不许落库**（守卫不是"建完再回滚"）。
   *
   * 与内容类拒绝（`recordDraftRejection`）刻意分开：actor 不对是**调用方的 bug**，
   * 不是"用户驳回了这条草稿"，不许混进 `rejection_count` 让统计失真。
   */
  const actorProblem = draftConfirmActorProblem(draft, options.actor ?? 'user')
  if (actorProblem !== null) throw new Error(actorProblem)
  /**
   * `at` 形状守卫 —— 与"actor 守卫"生来一对，治的是**同型相邻形参**这个隐患
   * （独立审查在 `confirmDailyPlanDraft` 上抓到，但 4 个确认入口的签名一模一样，
   * 所以照旧修在公共骨架上，不逐个补）。
   *
   * 每个 `confirm*Draft` 都是 `(db, draftId, actor = 'user', at = nowIso())`：
   * `actor` 与 `at` **同为 `string` 且相邻**，位置写反（`(db, id, at, actor)`）
   * TypeScript 一句都不会说。而后果**不是报错、是静默写坏数据** ——
   * 写反时 `actor` 位收到的是真 actor，守卫照常放行；`at` 位收到 `'user'`
   * 则被当成时间戳写进 `updated_at` / `created_at` / 确认时间列。
   *
   * （反过来的写反 —— 少了 actor 参数、把 `at` 顶到第 3 位 —— 会撞上上面那道
   * actor 守卫，只是那句话读起来莫名其妙。两道加在一起，两种写反都响。）
   *
   * 位置与 actor 守卫相同：**事务之前、回放之前** —— 形状不对时一条数据都不许落库。
   */
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error(`错误：确认草稿的 at 参数必须是可解析的时间串，收到「${at}」。它与相邻的 actor 参数同为 string，两个位置写反不会报类型错，所以在这里显式拦下。`)
  }
  const cached = getDraftConfirmResult(draft)
  if (cached !== undefined && options.replay !== undefined) {
    const replayed = options.replay(cached, draft)
    if (draft.statusCode === 'pending') setDraftStatus(db, draftId, 'confirmed', at)
    return replayed
  }
  /**
   * 状态守卫：不是 pending 就不再执行业务。
   *
   * 走到这里说明草稿没有可回放的产出（老数据：守卫上线前确认过、payload 里没有
   * `confirmResult`）—— 返回 `emptyValue`，由调用方给出可读结果，而不是"再建一条"。
   */
  if (draft.statusCode !== 'pending') return options.emptyValue
  return withTransaction(db, () => {
    const result = build(draft)
    // 先回写产出、再标记 confirmed：反过来 `updateDraft` 会因为状态不是 pending 而拒绝。
    const withResult = { ...draft.payload, confirmResult: result }
    db.prepare('UPDATE task_drafts SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(withResult), at, draftId)
    setDraftStatus(db, draftId, 'confirmed', at)
    return result
  }, { immediate: true })
}
