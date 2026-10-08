/**
 * 草稿域路由（查询 / 确认 / 放弃 / 复盘 / 完成申请）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { abandonDraft, addTaskMemory, appendEvent, completeTaskCascade, confirmDailyPlanDraft, confirmKnowledgeDraft, confirmSubtaskPlanDraft, confirmTaskDraft, createDraft, createTaskReview, deferDraft, getDictionary, getDraft, getDraftBySession, getDraftConfirmResult, getLatestActiveDraft, getTask, isDeferrableDraftKind, linkTaskSession, listDeferredDrafts, listRejectedDrafts, recordDraftRejection, resumeDraft, setDraftStatus, updateDraft, withTransaction } from '../../db/repo.js'
import { DRAFTS_PREFIX, errorMessage, methodNotAllowed, pathSegments, publicTask, readJsonBody, requireLoopback, writeJson } from './helpers.js'
import { writeReviewToTeamMemory, teamMemoryAvailable, type TeamMemoryService } from '../../review-memory.js'
import { canonicalizeKnowledgeDraftPayload, knowledgeDraftRejection, knowledgeDraftUnknownKeys } from '../../shared/knowledgeDraftPayload.js'

/** 草稿关联的任务 id（验收 / 复盘 / 拆解类草稿会带；任务类草稿确认后才存在）。 */
function taskIdOf(draft: { payload: Record<string, unknown> }): string | undefined {
  return typeof draft.payload.taskId === 'string' && draft.payload.taskId !== '' ? draft.payload.taskId : undefined
}

/** 确认**之前**抓的草稿快照：确认之后回看它，才知道这次点击到底有没有产生新东西。 */
interface ConfirmSnapshot {
  id: string
  /** 调用前是 `pending`（不是"已确认过又来一次""已被放弃"）。 */
  wasPending: boolean
  /** payload 里已经有上一次的产出（`confirmResult`）—— 这次走的是幂等回放。 */
  hadResult: boolean
}

/**
 * 「已受理」与「已落盘」的区分 —— `committed` 字段（2026-10-07 灵枢调研 §7 第一步①）。
 *
 * ## 为什么需要它
 *
 * 此前确认接口的每一个响应都是 `ok: true`，包括「草稿早就确认过了，这次啥也没干」
 * 这种什么都没发生的情况。2026-10-03 的 v1.16.4 缺陷（「建得出、确认不了」）里，
 * 用户点完「确认入库」拿到的是 200，可库里一个字节都没有 —— **链路上每一环都报成功**。
 * 灵枢（dsh-memory）对这个问题的答案是给写入结果加一个 `committed` 字段
 * （`{"ok": true, "committed": false, "moved_to": "review_queue"}`）：**绝不假装成功**。
 *
 * ## 口径：不看服务端怎么说，看库里的状态真的变了没有
 *
 * `committed === true` 当且仅当三条同时成立：
 * 1. 调用**前**草稿是 `pending`（否则这次压根没跑 build：回放 / 已放弃 / 已确认）；
 * 2. 调用**前** payload 里**没有** `confirmResult`（有 → 走的是回放，没重建实体）；
 * 3. 调用**后**草稿是 `confirmed`（不是的话说明 build 里请求了回滚，等于没写）。
 *
 * 放在**路由层**而不是 repo 层：repo 层的 `withDraftConfirm` 只在"真跑了 build"时才返回，
 * 区分不出"回放"与"新建"；而路由层手里同时握着调用前后的两个可观察状态，最省事也最诚实。
 */
function committedNow(db: DatabaseSync, before: ConfirmSnapshot): boolean {
  if (!before.wasPending || before.hadResult) return false
  return getDraft(db, before.id)?.statusCode === 'confirmed'
}

/**
 * 草稿被用户「暂存 / 驳回」时的留痕：写 task_events + 任务共享记忆，
 * 让后续（尤其是提交草稿的那个）会话知道自己的产出被暂存/驳回过、暂存了几次。
 *
 * 文案通用化：v1.12.0 只给验收类写留痕，措辞也写死"验收"。现在所有草稿类型都能暂存，
 * 再用"验收"就会误导（比如一份知识草稿的留痕写着"验收暂存"）。
 * `eventCode` 仍按是否验收类分流，便于界面上区分图标与措辞。
 */
function recordDraftFeedback(
  db: DatabaseSync,
  draft: { id: string; kindCode: string; payload: Record<string, unknown>; sessionId: string | null; deferCount?: number },
  action: 'rejected' | 'deferred',
  note: string,
  at: string,
): void {
  const taskId = taskIdOf(draft)
  if (taskId === undefined || getTask(db, taskId) === undefined) return
  const isCompletion = draft.kindCode === 'completion'
  const eventCode = `${isCompletion ? 'completion' : 'draft'}_${action}`
  appendEvent(db, taskId, eventCode, {
    actor: 'user',
    note: `draft:${draft.id}${note === '' ? '' : ` | ${note}`}`,
    after: { draftId: draft.id, kindCode: draft.kindCode, deferCount: draft.deferCount ?? 0 },
    at,
  })
  const label = action === 'rejected' ? '驳回' : '暂存'
  const what = isCompletion ? 'AI 提交的完成验收申请' : `AI 提交的「${draft.kindCode}」草稿`
  const content = note === ''
    ? `【草稿${label}】用户于 ${at} ${label}了${what}（草稿 ${draft.id}），未填写原因。若要重新提交，请先确认用户关心的问题。`
    : `【草稿${label}】用户于 ${at} ${label}了${what}（草稿 ${draft.id}）。用户反馈：${note}`
  addTaskMemory(db, { taskId, kind: action === 'rejected' ? 'note' : 'context', content, sourceSessionId: draft.sessionId })
}

export function makeDraftRoutes(db: DatabaseSync, deps: { teamMemory?: TeamMemoryService } = {}): WebRoute[] {
  const teamMemory = deps.teamMemory
  return [
    {
      kind: 'prefix',
      path: DRAFTS_PREFIX,
      handler: async (req, res) => {
        if (!requireLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, DRAFTS_PREFIX)
        const method = req.method ?? 'GET'
        const body = method === 'POST' ? await readJsonBody(req) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            const sessionId = url.searchParams.get('session_id') ?? undefined
            // 自动弹窗只取"未暂存"的最新草稿；暂存清单与「曾被拒」清单单独返回。
            if (sessionId === undefined) return writeJson(res, 200, { ok: true, draft: getLatestActiveDraft(db) ?? null, deferredDrafts: listDeferredDrafts(db), rejectedDrafts: listRejectedDrafts(db) })
            const draft = getDraftBySession(db, sessionId)
            return writeJson(res, 200, { ok: true, draft: draft ?? null })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            const kindCode = typeof body.kindCode === 'string' ? body.kindCode : 'task'
            if (getDictionary(db, 'draft_kind', kindCode) === undefined) return writeJson(res, 400, { error: `unknown draft_kind "${kindCode}"` })
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
            const payload = typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {}
            /**
             * 知识草稿：**建的时候就把字段名收干净、把坏草稿挡在门外**。
             *
             * 这条路由是插件自己推荐的"一个会话产出多条知识"的绕行口，此前只校验外层
             * `kindCode`：调用方按工具参数名写 `content_md` 也能拿到 201，草稿随即变成
             * **永远确认不了**的死草稿（用户点「确认入库」只看到 `knowledge requires content`，
             * 弹窗正文还是空的）。见 `shared/knowledgeDraftPayload.ts` 文件头。
             *
             * 当场做两件事：缺 title/contentMd → 400 中文原因（并列出本次 payload 的键）；
             * 否则把别名换成规范键名，**并回报换了哪些**（静默改写字段是本仓禁止的）。
             */
            if (kindCode === 'knowledge') {
              const rejection = knowledgeDraftRejection(payload)
              if (rejection !== null) return writeJson(res, 400, { error: rejection })
              const canonical = canonicalizeKnowledgeDraftPayload(payload)
              const draft = createDraft(db, { kindCode, sessionId, payload: canonical.payload })
              const unknown = knowledgeDraftUnknownKeys(canonical.payload)
              return writeJson(res, 201, {
                ok: true,
                draft,
                ...(canonical.usedAliases.length === 0 ? {} : { normalizedAliases: canonical.usedAliases }),
                ...(unknown.length === 0 ? {} : { ignoredKeys: unknown }),
              })
            }
            return writeJson(res, 201, { ok: true, draft: createDraft(db, { kindCode, sessionId, payload }) })
          }
          return methodNotAllowed(res)
        }

        const id = segments[0]
        const action = segments[1]
        if (method === 'GET' && action === undefined) {
          const draft = getDraft(db, id)
          return writeJson(res, draft === undefined ? 404 : 200, draft === undefined ? { error: 'draft not found' } : { ok: true, draft })
        }
        if (method === 'POST' && action === 'confirm') {
          /** 快照必须在**任何**业务分支之前抓 —— 后面每一支都可能把草稿推向 confirmed。 */
          let before: ConfirmSnapshot | undefined
          try {
            const draft = getDraft(db, id)
            if (draft === undefined) return writeJson(res, 404, { error: 'draft not found', committed: false })
            before = { id, wasPending: draft.statusCode === 'pending', hadResult: getDraftConfirmResult(draft) !== undefined }
            /**
             * 确认是**幂等**的（2026-09-13 真实事故的修法）。
             *
             * 已经 confirmed 过的草稿再 POST 一次，历史行为是**当成新的一次确认重新执行**
             * —— 同一条 task 草稿被点两次就建出两条同名任务（实测复现：见
             * `node scripts/repro/repro-routes.mjs`）。
             *
             * 现在分两种处理：
             * - `task` 草稿：回放当次建出来的任务（用户想要的"东西已经建好了"依然成立），
             *   响应里带 `replayed`，界面据此提示"这条已经确认过了"；
             * - 其余类型：明确 400，让调用方知道这次点击没有产生任何新东西。
             */
            if (draft.kindCode === 'task') {
              // `intent=dedupe`：用户在看到「已有同名任务」告警后，选择"就复用那一条"。
              const intent = body?.intent === 'dedupe' ? 'dedupe' : 'create'
              const result = confirmTaskDraft(db, id, 'user', new Date().toISOString(), intent)
              /**
               * `undefined` 有两种含义，**不能一律当 404**：
               * - 草稿真的不在了 → 404（并发删除）；
               * - 草稿还在，但不是 pending 且没有可回放的产出（例如已被「放弃」）→ 400。
               *   报 404 会让用户以为草稿丢了，实际它好好躺在「待处理」里。
               */
              if (result === undefined) {
                const current = getDraft(db, id)
                if (current === undefined) return writeJson(res, 404, { error: 'draft not found', committed: false })
                return writeJson(res, 400, { error: `draft is already ${current.statusCode}`, committed: false })
              }
              // problems 必须回传：界面据此标黄列出「哪几项没建、为什么」，
              // 否则就是 2026-09-12 那次「确认成功但子任务凭空少了两个」的重演。
              return writeJson(res, 200, {
                ok: true,
                committed: committedNow(db, before),
                task: publicTask(result.task),
                created: result.childCount + 1,
                problems: result.problems,
                ...(result.replayed === true ? { replayed: true } : {}),
                ...(result.reused === true ? { reused: true } : {}),
                ...(result.duplicateOf === undefined ? {} : {
                  duplicateOf: {
                    id: result.duplicateOf.task.id,
                    title: result.duplicateOf.task.title,
                    statusCode: result.duplicateOf.task.statusCode,
                    createdAt: result.duplicateOf.task.createdAt,
                    sameDescription: result.duplicateOf.sameDescription,
                    sameWorkspace: result.duplicateOf.sameWorkspace,
                  },
                }),
              })
            }
            if (draft.statusCode !== 'pending') {
              return writeJson(res, 400, { error: `draft is already ${draft.statusCode}`, committed: false })
            }
            if (draft.kindCode === 'subtask_plan') {
              const result = confirmSubtaskPlanDraft(db, id)
              return writeJson(res, 200, {
                ok: true,
                committed: committedNow(db, before),
                tasks: result.tasks.map(publicTask),
                created: result.tasks.length,
                problems: result.problems,
              })
            }
            if (draft.kindCode === 'daily_plan') {
              // ⚠️ 必须先执行确认、再算 `committed`：`committedNow` 是**回读库**得出的，
              // 写成 `{ committed: committedNow(...), plan: confirmDailyPlanDraft(...) }`
              // 会按书写顺序先算 committed —— 那时确认还没发生，永远回 false。
              const plan = confirmDailyPlanDraft(db, id)
              return writeJson(res, 200, { ok: true, committed: committedNow(db, before), plan })
            }
            if (draft.kindCode === 'knowledge') {
              const knowledge = confirmKnowledgeDraft(db, id)
              return writeJson(res, 200, { ok: true, committed: committedNow(db, before), knowledge })
            }
            if (draft.kindCode === 'review') {
              const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : undefined
              const summaryMd = typeof draft.payload.summaryMd === 'string' ? draft.payload.summaryMd : ''
              if (taskId === undefined || getTask(db, taskId) === undefined) return writeJson(res, 404, { error: 'task not found', committed: false })
              const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : null
              /**
               * **幂等**（v1.14.0 修，对齐验收标准「重复确认同一条复盘不产生重复记忆」）。
               *
               * 曾经每次确认都 `createTaskReview()` 生成一个**新的** reviewId ——
               * 而记忆写入的去重键就是这个 reviewId，于是"幂等"形同虚设：
               * 重复确认把同一条复盘又写成一条记忆（实测 notes 41→43）。
               *
               * 现在把首次生成的 reviewId 记回草稿 payload：重复确认复用同一个 review，
               * `writeReviewToTeamMemory` 的 `review_memory_written` 记录随即命中 → 不再重写。
               * 存 payload 而不是加列：不需要 schema 变更（schema 只单向前进）。
               */
              const existingReviewId = typeof draft.payload.reviewId === 'string' ? draft.payload.reviewId : null
              /**
               * DB 侧三件事收进**一个**事务（2026-10-05 审计 §3.3 的同类问题）：
               * 建 review、把 reviewId 回写草稿、把草稿标 confirmed。
               * 原先三步各写各的，`UPDATE … status_code` 还是裸语句（同一文件的两处裸 UPDATE 之一）。
               * 团队记忆的写入留在事务**之外**：它是 async 且属于"额外沉淀"，
               * 不能把 SQLite 事务跨越 await 挂着（更不能让它的失败牵连复盘本身）。
               */
              const reviewId = withTransaction(db, () => {
                const createdId = existingReviewId ?? createTaskReview(db, { taskId, sessionId, summaryMd, lessonsJson: draft.payload.lessons ?? [] })
                if (existingReviewId === null) {
                  updateDraft(db, id, { ...draft.payload, reviewId: createdId })
                }
                setDraftStatus(db, id, 'confirmed', new Date().toISOString())
                return createdId
              }, { immediate: true })
              /**
               * v1.14.0：复盘确认时**顺带**把结论写进团队记忆库（否则复盘只活在本机）。
               *
               * ## ⚠️ 团队记忆是**公司内部系统**（v1.14.58 补的能力门卫）
               *
               * 它不会开源，开源用户拿不到 `dsh-team-memory` 插件与内网记忆服务。
               * 界面上已经改成"拿不到能力就整块不渲染"，但**服务端也要拦一道**：
               * 客户端可以被绕过（curl / 脚本 / 旧版前端仍会带 `memoryEnabled: true`），
               * 而我们**不该往一个开源用户机器上凭空造 `~/.dsh/memory/queue/` 文件**。
               * 所以这里先问 `teamMemoryAvailable()`，不可用就直接不写、回 `enabled: false`。
               *
               * 三条硬约束（原样保留）：
               * 1. 可见性默认 `private`（复盘可能含客户信息），由确认弹窗传 `memoryScope` 覆盖；
               * 2. `memoryEnabled === false`（用户在弹窗里取消勾选）→ 一个字节都不写；
               * 3. **写失败绝不让复盘确认失败** —— 复盘已经进本地库了，这是"额外的沉淀"，
               *    不是前置条件；失败只回一条 degradedReason 给界面显示。
               */
              const memory = teamMemoryAvailable()
                ? await writeReviewToTeamMemory(db, reviewId, {
                    enabled: body?.memoryEnabled !== false,
                    scope: body?.memoryScope === 'team' ? 'team' : 'private',
                    service: teamMemory,
                  })
                : { enabled: false as const, scope: 'private' as const, written: 0, skipped: 0 }
              return writeJson(res, 200, { ok: true, committed: committedNow(db, before), reviewId, memory })
            }
            if (draft.kindCode === 'completion') {
              const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : undefined
              if (taskId === undefined) return writeJson(res, 400, { error: 'completion draft requires taskId', committed: false })
              const task = getTask(db, taskId)
              if (task === undefined) return writeJson(res, 404, { error: 'task not found', committed: false })
              const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : null
              const summary = typeof draft.payload.summary === 'string' ? draft.payload.summary.trim() : ''
              const now = new Date().toISOString()
              /**
               * **一次验收 = 一个事务**（2026-10-05 审计 §3.3）。
               *
               * 历史行为把这件逻辑上的一件事拆成 4 个独立事务：`completeTaskCascade`（自带事务）
               * → `linkTaskSession` → `addTaskMemory` → 最后一条**裸** `UPDATE task_drafts`。
               * 崩在中间就留下"任务已 done、草稿仍 pending"，界面上继续催用户验收；
               * 用户再点一次，`addTaskMemory` 又写一条 summary 共享记忆（无幂等键），
               * 表现为"我已经验收过了，它还在让我验收"。
               *
               * 现在四步在同一事务里：要么全部生效，要么全部不生效（草稿仍是 pending，
               * 用户可以重试，且不会留下半截状态）。这是**唯一**此前不走 `withDraftConfirm`
               * 单事务口径的确认分支，现在口径统一了。
               */
              const completedTask = withTransaction(db, () => {
                completeTaskCascade(db, taskId, 'user')
                if (sessionId !== null) linkTaskSession(db, { taskId, sessionId, roleCode: 'execute' })
                if (summary !== '') {
                  addTaskMemory(db, { taskId, kind: 'summary', content: summary, sourceSessionId: sessionId })
                }
                setDraftStatus(db, id, 'confirmed', now)
                return getTask(db, taskId)
              }, { immediate: true })
              return writeJson(res, 200, { ok: true, committed: committedNow(db, before), task: publicTask(completedTask ?? task) })
            }
            return writeJson(res, 400, { error: `unknown draft kind ${draft.kindCode}`, committed: false })
          } catch (error) {
            /**
             * 抛错路径也要说清楚"没有落盘"。`before` 没抓到（读草稿就炸了）时按 false 算。
             *
             * 这里**不写死 `false`** 而是回读一次库：复盘分支的团队记忆写入在事务**之外**，
             * 万一它抛了，复盘其实已经进本地库了 —— 那种情况下说 `false` 就是**反向的不诚实**。
             */
            return writeJson(res, 400, { error: errorMessage(error), committed: before === undefined ? false : committedNow(db, before) })
          }
        }
        if (method === 'POST' && action === 'abandon') {
          const draft = getDraft(db, id)
          if (draft === undefined) return writeJson(res, 404, { error: 'draft not found' })
          if (draft.statusCode !== 'pending') return writeJson(res, 400, { error: `draft is already ${draft.statusCode}` })
          const now = new Date().toISOString()
          const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
          abandonDraft(db, id)
          /**
           * 先落「负记忆」（草稿行自己身上的三个列），再写任务侧留痕。
           *
           * 两者覆盖的范围**不一样**，缺一不可：
           * - `recordDraftRejection` 不看草稿有没有 `taskId`，**所有**被驳回的草稿都记，
           *   包括知识草稿这种 `payload` 里根本没有任务、此前理由当场丢弃的类型；
           * - `recordDraftFeedback` 只对**带 taskId 且任务还在**的草稿写任务事件 + 共享记忆，
           *   是给 AI 会话看的那一份。
           */
          recordDraftRejection(db, id, reason, now)
          recordDraftFeedback(db, draft, 'rejected', reason, now)
          return writeJson(res, 200, { ok: true })
        }
        if (method === 'POST' && action === 'defer') {
          const draft = getDraft(db, id)
          if (draft === undefined) return writeJson(res, 404, { error: 'draft not found' })
          if (draft.statusCode !== 'pending') return writeJson(res, 400, { error: `draft is already ${draft.statusCode}` })
          if (!isDeferrableDraftKind(draft.kindCode)) return writeJson(res, 400, { error: `draft kind "${draft.kindCode}" cannot be deferred` })
          const now = new Date().toISOString()
          const deferred = deferDraft(db, id, now)
          if (deferred === undefined) return writeJson(res, 400, { error: 'defer failed' })
          // 暂存留痕：所有带 taskId 的草稿都写（原来只写 completion）——
          // AI 后续会话要据此知道自己被暂存过、暂存了几次。
          const note = typeof body?.note === 'string' ? body.note.trim() : ''
          recordDraftFeedback(db, deferred, 'deferred', note, now)
          return writeJson(res, 200, { ok: true, draft: deferred })
        }
        if (method === 'POST' && action === 'resume') {
          const resumed = resumeDraft(db, id)
          if (resumed === undefined) return writeJson(res, 404, { error: 'draft not found or not pending' })
          return writeJson(res, 200, { ok: true, draft: resumed })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
