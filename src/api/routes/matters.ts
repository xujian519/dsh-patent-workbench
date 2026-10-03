/**
 * 案卷域路由（专利工作台阶段 2）。
 *
 * 端点（全部 loopback-only）：
 * - `GET  /api/workbench/matters`                    列表（可按 stage/matter_type/client/q 过滤）
 * - `POST /api/workbench/matters`                    建案
 * - `GET  /api/workbench/matters/:id`                详情
 * - `PATCH /api/workbench/matters/:id`               更新
 * - `DELETE /api/workbench/matters/:id`              删除（连带解绑知识条目）
 * - `GET  /api/workbench/matters/:id/notices`        官文列表
 * - `POST /api/workbench/matters/:id/notices`        登记官文（期限的起算输入）
 * - `DELETE /api/workbench/matters/:id/notices/:nid` 删除官文
 * - `GET  /api/workbench/matters/:id/deadlines`      期限列表（阶段 3 由期限引擎写入）
 * - `POST /api/workbench/matters/:id/deadlines/recompute` 调期限引擎重算并落库（返回待补输入）
 * - `PATCH /api/workbench/matters/:id/deadlines/:did` 单条期限状态（已办理 / 已豁免）
 * - `GET  /api/workbench/matters/:id/events`         案卷事件（_matter-log.md 的只读投影）
 * - `POST /api/workbench/matters/:id/events/sync`     读案卷目录的 _matter-log.md → 投影成事件（幂等、只追加；不写磁盘）
 * - `POST /api/workbench/matters/:id/events`         追加事件
 *
 * 校验失败一律 `400` + 中文原因（仓储层抛出）；不静默忽略非法值。
 *
 * 期限重算**不自己算法条**：起算与期间全部交给 DSH Patent 的 `patentDeadline` 服务，
 * 这里只做映射与落库。服务拿不到时返回 `409` 让界面明说“期限引擎不可用”，
 * 绝不在插件里兜底一份期限口径（同一语义两处实现是禁区）。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  MATTER_STAGE_CODES, appendMatterEvent, createMatter, createMatterNotice, deleteMatter, deleteMatterNotice,
  getMatter, listMatterDeadlines, listMatterEvents, listMatterNotices, listMatters, localDateString,
  projectMatterLogEvents, replaceMatterDeadlines, setMatterDeadlineStatus, updateMatter, type MatterStageCode,
} from '../../db/repo.js'
import { parseMatterLog } from '../../shared/matterLog.js'

/**
 * 投影源的**文件名常量**（`patent-matter` 技能定义的固定名）。
 *
 * 只认这一个名字：不接受调用方传路径 —— 否则一个手滑的 `../../../` 就能把任意文件的行
 * 读成"案卷事件"存进库。案卷目录 + 固定文件名 = 攻击面为零。
 */
const MATTER_LOG_FILENAME = '_matter-log.md'
/** 单次导入的体积上限：日志是纯文本行记录，2 MiB 已远超真实规模（一万行约 0.5 MiB）。 */
const MAX_MATTER_LOG_BYTES = 2 * 1024 * 1024
import { buildDeadlineQuery, reportToDeadlineRows, type PatentDeadlineService } from '../../shared/patentDeadline.js'
import { MATTERS_PREFIX, badRequest, errorMessage, methodNotAllowed, pathSegments, readJsonBody, requireLoopback, writeJson } from './helpers.js'

/** 期限引擎（软探测）的注入口；未注入或探测为 undefined 时重算端点明确降级。 */
export interface MatterRouteDeps {
  /**
   * DSH Patent 的 `patentDeadline` 服务探测器（`ctx.get` 软探测，**不进 `inject`**）。
   * 未安装/未在 profile 根域注册时返回 undefined——插件照样加载，只是重算不可用。
   */
  patentDeadline?: () => PatentDeadlineService | undefined
  /** 引擎标识，写进 `computed_from` 供追溯（默认 `@deepseek-ai/dsh-patent-deadline`）。 */
  engineId?: string
}

/**
 * `GET /api/workbench/matter-deadlines/upcoming?days=7`：跨案卷的"近 N 天到期"。
 *
 * ## 为什么要有这个聚合端点（而不是让界面遍历案卷）
 *
 * "近 7 天到期"是**跨案卷**的问题，而 `GET /matters/:id/deadlines` 是单卷的。
 * 让客户端先拉案卷列表再逐个拉期限 = N+1 次请求，且**排序会散在客户端**
 * （"哪条最急"这个判定绝不能两处各算一遍）。聚合与排序都放在 SQL 这一层：
 * 一个查询、一份顺序，界面只负责画。
 *
 * 只返回**未结案、未完成**的期限：
 * - `status` 是 `done` / `waived` 的不进看板（用户已经处理过，再出现就是噪声）；
 * - 已结案（`closed_at` 非空）的案卷整体不进（案子都结了，它的期限不再是"要办的事"）。
 * 今天之前的（已过期）**要进来** —— "昨天就该交的东西"比"后天要交的"更该被看见。
 */
function upcomingDeadlineRoute(db: DatabaseSync): WebRoute {
  return {
    kind: 'exact',
    path: '/api/workbench/matter-deadlines/upcoming',
    handler(req, res) {
      if (!requireLoopback(req, res)) return
      if ((req.method ?? 'GET') !== 'GET') return methodNotAllowed(res)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rawDays = Number(url.searchParams.get('days') ?? '7')
      const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(365, Math.round(rawDays)) : 7
      /**
       * 窗口右端按**本地日**算（与仓库别处的日界口径一致：定宽 `YYYY-MM-DD`，
       * 词典序 == 日期序）。左端不设限 —— 过期未处理的必须看得见。
       */
      const until = new Date()
      until.setDate(until.getDate() + days)
      const untilDate = localDateString(until)
      const rows = db.prepare(`
        SELECT d.id, d.matter_id, d.label, d.due_date, d.due_date_raw, d.status, d.basis, m.case_number, m.title
        FROM matter_deadlines d
        JOIN matters m ON m.id = d.matter_id
        WHERE m.closed_at IS NULL
          AND (d.status IS NULL OR d.status NOT IN ('done', 'waived'))
          AND d.due_date <= ?
        ORDER BY d.due_date ASC, m.case_number ASC, d.label ASC
      `).all(untilDate) as unknown as Array<Record<string, unknown>>
      const items = rows.map((row) => ({
        id: row.id as string,
        matterId: row.matter_id as string,
        caseNumber: row.case_number as string,
        matterTitle: row.title as string,
        label: row.label as string,
        dueDate: row.due_date as string,
        dueDateRaw: row.due_date_raw as string,
        status: (row.status ?? null) as string | null,
        basis: (row.basis ?? null) as string | null,
        /** `due_date < 今天` → 已过期（服务端算，界面不自己比日期 —— 时区只在一处算）。 */
        overdue: (row.due_date as string) < localDateString(),
      }))
      return writeJson(res, 200, { ok: true, days, until: untilDate, today: localDateString(), deadlines: items })
    },
  }
}

export function makeMatterRoutes(db: DatabaseSync, deps: MatterRouteDeps = {}): WebRoute[] {
  const engineId = deps.engineId ?? '@deepseek-ai/dsh-patent-deadline'
  return [
    {
      kind: 'prefix',
      path: MATTERS_PREFIX,
      handler: async (req, res) => {
        if (!requireLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, MATTERS_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined

        // ------------------------------------------------------------------ 集合
        if (segments.length === 0) {
          if (method === 'GET') {
            const rawStage = url.searchParams.get('stage_code') ?? undefined
            if (rawStage !== undefined && !(MATTER_STAGE_CODES as readonly string[]).includes(rawStage)) {
              return writeJson(res, 400, { error: `stage_code 非法，合法值：${MATTER_STAGE_CODES.join(' / ')}` })
            }
            return writeJson(res, 200, {
              ok: true,
              matters: listMatters(db, {
                stageCode: rawStage as MatterStageCode | undefined,
                matterType: url.searchParams.get('matter_type') ?? undefined,
                clientId: url.searchParams.get('client_id') ?? undefined,
                q: url.searchParams.get('q') ?? undefined,
              }),
            })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const matter = createMatter(db, {
                caseNumber: body.caseNumber as string,
                title: body.title as string,
                clientId: body.clientId as string | null | undefined,
                matterType: body.matterType as string,
                patentKind: body.patentKind as never,
                stageCode: body.stageCode as never,
                applicationNo: body.applicationNo as string | null | undefined,
                publicationNo: body.publicationNo as string | null | undefined,
                patentNo: body.patentNo as string | null | undefined,
                filingDate: body.filingDate as string | null | undefined,
                priorityDate: body.priorityDate as string | null | undefined,
                claimsPriority: body.claimsPriority as boolean | undefined,
                isPctNationalPhase: body.isPctNationalPhase as boolean | undefined,
                ipc: body.ipc as string | null | undefined,
                techField: body.techField as string | null | undefined,
                inventors: body.inventors as string | null | undefined,
                applicant: body.applicant as string | null | undefined,
                attorney: body.attorney as string | null | undefined,
                workspacePath: body.workspacePath as string | null | undefined,
                extra: body.extra as Record<string, unknown> | undefined,
              })
              return writeJson(res, 201, { ok: true, matter })
            } catch (error) {
              return badRequest(res, error)
            }
          }
          return methodNotAllowed(res)
        }

        const id = segments[0]

        // ------------------------------------------------------------------ 子资源
        if (segments.length >= 2) {
          const section = segments[1]
          if (section === 'notices') {
            if (segments.length === 2 && method === 'GET') {
              return writeJson(res, 200, { ok: true, notices: listMatterNotices(db, id) })
            }
            if (segments.length === 2 && method === 'POST') {
              if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
              try {
                return writeJson(res, 201, {
                  ok: true,
                  notice: createMatterNotice(db, {
                    matterId: id,
                    noticeKind: body.noticeKind as never,
                    dispatchDate: body.dispatchDate as string,
                    deliveryMode: body.deliveryMode as never,
                    deliveryDate: body.deliveryDate as string | null | undefined,
                    designatedMonths: body.designatedMonths as number | null | undefined,
                    fileLink: body.fileLink as string | null | undefined,
                    note: body.note as string | null | undefined,
                  }),
                })
              } catch (error) {
                return badRequest(res, error)
              }
            }
            if (segments.length === 3 && method === 'DELETE') {
              const removed = deleteMatterNotice(db, id, segments[2])
              return writeJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: '官文记录不存在' })
            }
            return methodNotAllowed(res)
          }

          if (section === 'deadlines') {
            if (segments.length === 2 && method === 'GET') {
              return writeJson(res, 200, { ok: true, deadlines: listMatterDeadlines(db, id) })
            }
            /**
             * 重算：只要
             * 1. 调引擎（纯函数，`today` 由调用方给，报告可复现）；
             * 2. 把已算出的期限整表替换，**保留用户已确认的 done/waived**（仓储层保证）；
             * 3. 把 pending 随响应返回——它没有届满日，不进真日期列。
             */
            if (segments.length === 3 && segments[2] === 'recompute' && method === 'POST') {
              const matter = getMatter(db, id)
              if (matter === undefined) return writeJson(res, 404, { error: '案卷不存在' })
              const service = deps.patentDeadline?.()
              if (service === undefined) {
                return writeJson(res, 409, {
                  error: '期限引擎不可用：未探测到 DSH Patent 的 patentDeadline 服务。'
                    + '请在 profile 根域注册 @deepseek-ai/dsh-patent-deadline（config: { provideService: true, exposeTool: false }）后重试；'
                    + '在此之前请手工录入期限，本插件不会自行推算期限。',
                })
              }
              const raw = body ?? {}
              const today = typeof raw.today === 'string' && raw.today !== '' ? raw.today : localDateString()
              try {
                const report = service.evaluate(buildDeadlineQuery({
                  matter,
                  notices: listMatterNotices(db, id),
                  today,
                  restDayRule: raw.restDayRule === 'apply' || raw.restDayRule === 'omit' ? raw.restDayRule : undefined,
                }), typeof raw.reminderLeadDays === 'number' ? { reminderLeadDays: raw.reminderLeadDays } : undefined)
                const deadlines = replaceMatterDeadlines(db, id, reportToDeadlineRows(report, { today, engine: engineId }))
                return writeJson(res, 200, {
                  ok: true,
                  today,
                  restDayRule: report.restDayRule,
                  deadlines,
                  pending: report.pending,
                  calendarCoverage: service.calendarCoverage(),
                })
              } catch (error) {
                return badRequest(res, error)
              }
            }
            if (segments.length === 3 && method === 'PATCH' && segments[2] !== 'recompute') {
              if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
              try {
                return writeJson(res, 200, { ok: true, deadline: setMatterDeadlineStatus(db, id, segments[2], body.status as string) })
              } catch (error) {
                return badRequest(res, error)
              }
            }
            return methodNotAllowed(res)
          }

          if (section === 'events') {
            if (segments.length === 2 && method === 'GET') {
              return writeJson(res, 200, { ok: true, events: listMatterEvents(db, id) })
            }
            /**
             * `POST /matters/:id/events/sync`：把案卷目录里的 `_matter-log.md`
             * **投影**成 `matter_events`（阶段 6 · bridge 收口；决策 D1）。
             *
             * 方向是**单向**的：日志是唯一事实源，本端点**只读磁盘、只追加库行** ——
             * 不写案卷目录（那个方向被明令禁止）、不 UPDATE/DELETE 已有事件。
             * 幂等：同一份日志导两次，第二次 `added = 0`。
             */
            if (segments.length === 3 && segments[2] === 'sync' && method === 'POST') {
              const matter = getMatter(db, id)
              if (matter === undefined) return writeJson(res, 404, { error: '案卷不存在' })
              const dir = matter.workspacePath === null ? '' : matter.workspacePath.trim()
              if (dir === '') {
                /**
                 * 没登记目录就**直说没法定位**，不猜一个路径、也不去别处找日志：
                 * 猜错会把另一个案卷的日志导进来，那比"没导入"严重得多。
                 */
                return writeJson(res, 400, {
                  error: '案卷没有登记「案卷目录」，无法定位 _matter-log.md。请先在案卷详情里补全目录（例如 patent-workspace/<案号>）。',
                })
              }
              const logPath = join(dir, MATTER_LOG_FILENAME)
              let content: string
              try {
                const info = await stat(logPath)
                if (!info.isFile()) return writeJson(res, 400, { error: `${logPath} 不是文件` })
                if (info.size > MAX_MATTER_LOG_BYTES) {
                  return writeJson(res, 400, { error: `_matter-log.md 超过上限（${MAX_MATTER_LOG_BYTES} 字节），拒绝整体导入` })
                }
                content = await readFile(logPath, 'utf8')
              } catch (error) {
                const code = (error as { code?: string }).code
                if (code === 'ENOENT') return writeJson(res, 404, { error: `该案卷目录下没有 ${MATTER_LOG_FILENAME}：${logPath}` })
                return writeJson(res, 400, { error: `读取 ${logPath} 失败：${errorMessage(error)}` })
              }
              const parsed = parseMatterLog(content)
              const result = projectMatterLogEvents(db, id, parsed.events)
              return writeJson(res, 200, {
                ok: true,
                path: logPath,
                added: result.added,
                existing: result.existing,
                total: result.total,
                /** 名字与数量一并给出："导入了 0 条"与"另有 2 行没解析出来"是两件事。 */
                ignoredLines: parsed.ignored,
                skipped: parsed.skipped,
                events: listMatterEvents(db, id),
              })
            }
            if (segments.length === 2 && method === 'POST') {
              if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
              try {
                return writeJson(res, 201, {
                  ok: true,
                  event: appendMatterEvent(db, {
                    matterId: id,
                    action: body.action as string,
                    artifact: body.artifact as string | null | undefined,
                    approver: body.approver as string | null | undefined,
                    note: body.note as string | null | undefined,
                    at: body.at as string | undefined,
                  }),
                })
              } catch (error) {
                return badRequest(res, error)
              }
            }
            return methodNotAllowed(res)
          }

          return writeJson(res, 404, { error: 'unknown sub-resource' })
        }

        // ------------------------------------------------------------------ 单案
        if (method === 'GET') {
          const matter = getMatter(db, id)
          return writeJson(res, matter === undefined ? 404 : 200, matter === undefined ? { error: '案卷不存在' } : { ok: true, matter })
        }
        if (method === 'PATCH') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const patch: Parameters<typeof updateMatter>[2] = {}
            if ('caseNumber' in body) patch.caseNumber = body.caseNumber as string
            if ('title' in body) patch.title = body.title as string
            if ('clientId' in body) patch.clientId = body.clientId as string | null
            if ('matterType' in body) patch.matterType = body.matterType as string
            if ('patentKind' in body) patch.patentKind = body.patentKind as never
            if ('stageCode' in body) patch.stageCode = body.stageCode as never
            if ('applicationNo' in body) patch.applicationNo = body.applicationNo as string | null
            if ('publicationNo' in body) patch.publicationNo = body.publicationNo as string | null
            if ('patentNo' in body) patch.patentNo = body.patentNo as string | null
            if ('filingDate' in body) patch.filingDate = body.filingDate as string | null
            if ('priorityDate' in body) patch.priorityDate = body.priorityDate as string | null
            if ('claimsPriority' in body) patch.claimsPriority = body.claimsPriority as boolean
            if ('isPctNationalPhase' in body) patch.isPctNationalPhase = body.isPctNationalPhase as boolean
            if ('ipc' in body) patch.ipc = body.ipc as string | null
            if ('techField' in body) patch.techField = body.techField as string | null
            if ('inventors' in body) patch.inventors = body.inventors as string | null
            if ('applicant' in body) patch.applicant = body.applicant as string | null
            if ('attorney' in body) patch.attorney = body.attorney as string | null
            if ('workspacePath' in body) patch.workspacePath = body.workspacePath as string | null
            if ('closedAt' in body) patch.closedAt = body.closedAt as string | null
            if ('extra' in body) patch.extra = body.extra as Record<string, unknown>
            return writeJson(res, 200, { ok: true, matter: updateMatter(db, id, patch) })
          } catch (error) {
            return badRequest(res, error)
          }
        }
        if (method === 'DELETE') {
          const result = deleteMatter(db, id)
          return writeJson(res, result.deleted ? 200 : 404, result.deleted ? { ok: true, ...result } : { error: '案卷不存在' })
        }
        return methodNotAllowed(res)
      },
    },
    // 跨案卷的"近 N 天到期"（今日视图用）—— 与单卷 CRUD 分开成独立路径，避免与 :id 抢段
    upcomingDeadlineRoute(db),
  ]
}
