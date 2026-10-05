/**
 * 案卷「扫描导入」的服务端入口。
 *
 * 端点（全部 loopback-only）：
 * - `POST /api/workbench/matter-import/scan`  扫描一个工作根目录 → 候选清单（**不落库**）
 *
 * 独立成文件是为了热重载时能作为新模块被重新加载（同 `localDirRoute.ts`）。
 *
 * ## 信任边界
 *
 * 这里**接受调用方传任意路径**去扫描 —— 与既有 `GET /knowledge/read-local-file`
 * （`routes/knowledge.ts`）同一姿态：信任边界就是 **loopback 围栏**（`requireLoopback`，
 * `api/http.ts:77` 是唯一实现）。不在这里虚构一层「根白名单」：扫描根本来就是用户
 * 在界面里自选的，白名单只会得到一个永远配不对的配置项，还让人误以为「已经防住了」。
 *
 * 递归扫描真正要防的是**环与资源耗尽**，那两条在 `matter-import/scan.ts` 里
 * （符号链接不下钻、深度与数量上限、截断回报）。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { assertValidFileLink } from '../db/repo.js'
import { toNativePath } from '../shared/hostPath.js'
import { commitMatterImport } from '../matter-import/commit.js'
import { scanWorkspaceTree } from '../matter-import/scan.js'
import { badRequest, methodNotAllowed, pathSegments, readJsonBody, requireLoopback, writeJson } from './routes/helpers.js'

export const MATTER_IMPORT_PREFIX = '/api/workbench/matter-import'

/**
 * 把用户填的扫描根转成原生绝对路径。
 *
 * 只展开**开头**的 `~`（`~/工作` → `/Users/xujian/工作`）—— 界面预填的就是这个形态。
 * 相对路径**明确拒绝**而不是「相对于 cwd 展开」：cwd 是服务进程的、用户看不见的东西，
 * 猜错了会去扫一个完全无关的目录，而用户以为自己扫的是「工作」。
 */
export function resolveScanRoot(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('扫描根不能为空（例如 ~/工作）')
  let expanded = text
  if (text === '~') expanded = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) expanded = join(homedir(), text.slice(2))
  /**
   * 先自己拦相对路径，是为了给**中文原因**：`assertValidFileLink` 抛的是
   * `fileLink must be a file:// URL or an absolute path`，摆到中文界面上等于没说清
   * 「相对谁」。这里把理由讲透，用户才知道该填什么。
   */
  if (!isAbsolute(expanded)) {
    throw new Error(`扫描根必须是绝对路径或以 ~ 开头（收到「${text}」）—— 相对路径要相对于谁？服务进程的工作目录是你看不见的，猜错了会去扫一个完全无关的地方。`)
  }
  return toNativePath(assertValidFileLink(expanded)!, process.platform)
}

/**
 * commit 请求体上限 2 MiB。
 *
 * `readJsonBody` 的缺省是 256 KiB（`api/http.ts:98`），而 983 条候选各带路径与名称
 * 约 250 KB —— 正卡在边界上，目录再多一点就会变成「什么都没发生地失败」。
 */
const COMMIT_BODY_MAX_BYTES = 2 * 1024 * 1024

export function makeMatterImportRoute(db: DatabaseSync): WebRoute[] {
  return [{
    kind: 'prefix',
    path: MATTER_IMPORT_PREFIX,
    handler: async (req, res) => {
      if (!requireLoopback(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = pathSegments(url, MATTER_IMPORT_PREFIX)
      const method = req.method ?? 'GET'

      if (segments.length === 1 && segments[0] === 'scan') {
        if (method !== 'POST') return methodNotAllowed(res)
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        try {
          const root = resolveScanRoot(body.root)
          const scan = await scanWorkspaceTree(root)
          return writeJson(res, 200, { ok: true, ...scan })
        } catch (error) {
          return badRequest(res, error)
        }
      }

      if (segments.length === 1 && segments[0] === 'commit') {
        if (method !== 'POST') return methodNotAllowed(res)
        const body = await readJsonBody(req, COMMIT_BODY_MAX_BYTES)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        try {
          return writeJson(res, 200, { ok: true, ...commitMatterImport(db, body.items) })
        } catch (error) {
          return badRequest(res, error)
        }
      }

      return writeJson(res, 404, { error: 'unknown sub-resource' })
    },
  }]
}
