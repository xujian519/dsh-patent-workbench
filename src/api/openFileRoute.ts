/**
 * 知识库“打开本地文件”路由。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增/修复路由无法通过 dev_reload_package 立即生效）。
 *
 * ## 这个路由是**代码执行原语**，不是"打开文档"
 *
 * 交给系统默认程序打开 = 在本机执行那个扩展名关联到的程序。入参 `fileLink` 来自知识条目，
 * 而知识条目能由模型草稿 / 导入数据写入，所以放行范围由 `shared/openableFile.ts`
 * 的白名单说了算（**唯一判定处**）：白名单内 → 默认程序打开；
 * 其余（`.command` `.sh` `.exe` `.lnk`…、以及没有扩展名的可执行脚本）
 * → **降级为在文件管理器中定位**，绝不交给默认程序。
 * 响应里的 `mode` 就是实际走的那条腿（`open` / `reveal`），客户端据此给用户可读提示。
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertValidFileLink } from '../db/repo.js'
import { badRequest, errorMessage, methodNotAllowed, readJsonBody, requireLoopback, writeJson } from './http.js'
import { decideOpenMode } from '../shared/openableFile.js'
import { toNativePath, wslDriveToWindows } from '../shared/hostPath.js'

interface OpenCandidate {
  command: string
  args: string[]
  /**
   * 该退出码不算失败。
   *
   * `explorer.exe /select,…` **成功时也返回 1**（长期行为，不是错误），
   * 不豁免就会把"已经定位好了"报成"所有打开命令均失败"。
   */
  ignoreExitCode?: number
}

function tryOpen(candidates: OpenCandidate[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    const errors: unknown[] = []
    const attempt = (): void => {
      if (index >= candidates.length) {
        reject(new AggregateError(errors, `无法打开文件：所有打开命令均失败（${errors.map(errorMessage).join('; ')}）`))
        return
      }
      const { command, args, ignoreExitCode } = candidates[index++]
      execFile(command, args, { windowsVerbatimArguments: process.platform === 'win32' }, (error) => {
        // `execFile` 的非零退出把退出码放在 `error.code`（`ExecFileException` 的 `code`
        // 是 `string | number`，所以这里显式收窄，别用 `NodeJS.ErrnoException` 那个纯 string 的口径）。
        const exitCode = (error as { code?: string | number } | null)?.code
        if (error && !(ignoreExitCode !== undefined && exitCode === ignoreExitCode)) { errors.push(error); attempt() } else resolve()
      })
    }
    attempt()
  })
}

function openLocalFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return tryOpen([{ command: 'cmd', args: ['/c', 'start', '', filePath] }])
  }
  if (process.platform === 'darwin') {
    return tryOpen([{ command: 'open', args: [filePath] }])
  }
  const winPath = wslDriveToWindows(filePath)
  const candidates: OpenCandidate[] = []
  if (winPath !== filePath) {
    candidates.push({ command: 'cmd.exe', args: ['/c', 'start', '', winPath] })
    candidates.push({ command: 'explorer.exe', args: [winPath] })
  }
  candidates.push({ command: 'wslview', args: [filePath] })
  candidates.push({ command: 'xdg-open', args: [filePath] })
  candidates.push({ command: 'gio', args: ['open', filePath] })
  return tryOpen(candidates)
}

/**
 * 在文件管理器中**定位**（选中）文件，而不是打开它。
 *
 * 比"打开"的退路更弱、更安全：不经过扩展名关联，因此不执行任何程序。
 * Windows 侧参数必须自带引号 —— `execFile` 传了 `windowsVerbatimArguments: true`
 * （为了 `cmd /c start` 那一腿），argv 会原样拼接，而 `explorer /select,` 的空格路径
 * 不引起来就会被拆成两个开关。（Windows 文件名不可能含 `"`，所以这样拼是安全的。）
 */
function revealLocalFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return tryOpen([{ command: 'explorer.exe', args: [`/select,"${filePath}"`], ignoreExitCode: 1 }])
  }
  if (process.platform === 'darwin') {
    return tryOpen([{ command: 'open', args: ['-R', filePath] }])
  }
  const winPath = wslDriveToWindows(filePath)
  const candidates: OpenCandidate[] = []
  if (winPath !== filePath) {
    candidates.push({ command: 'explorer.exe', args: [`/select,"${winPath}"`], ignoreExitCode: 1 })
  }
  const parent = dirname(filePath)
  candidates.push({ command: 'xdg-open', args: [parent] })
  candidates.push({ command: 'gio', args: ['open', parent] })
  return tryOpen(candidates)
}

/**
 * 两条腿的**注入点**（生产不传，用文件内的真实现）。
 *
 * 之所以要把它们抽成依赖：这是全仓唯一会**执行本机程序**的地方，
 * 单测必须能在**不真的调用 `open` / `xdg-open` / `explorer`** 的前提下断言
 * "某类文件走的是哪条腿"（否则测试自己就会成为那个执行原语，
 * 而且 headless CI 上 `xdg-open` 根本不存在，判据会变成平台相关）。
 * 与 `makePersonaRoutes(db, deps.personas)` / `dev-verify.mjs` 同一套做法。
 */
export interface OpenFileDeps {
  openFile?: (filePath: string) => Promise<void>
  revealFile?: (filePath: string) => Promise<void>
}

export function makeOpenFileRoute(deps: OpenFileDeps = {}): WebRoute {
  const openFileImpl = deps.openFile ?? openLocalFile
  const revealFileImpl = deps.revealFile ?? revealLocalFile
  return {
    kind: 'exact',
    path: '/api/workbench/knowledge/open-file',
    handler: async (req, res) => {
      if (!requireLoopback(req, res)) return
      if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res)
      const body = await readJsonBody(req)
      if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
      const raw = typeof body.fileLink === 'string' ? body.fileLink : typeof body.path === 'string' ? body.path : undefined
      if (raw === undefined || raw.trim() === '') return writeJson(res, 400, { error: 'fileLink is required' })
      try {
        const fileLink = assertValidFileLink(raw)
        if (fileLink === null) return writeJson(res, 400, { error: 'fileLink is required' })
        const filePath = toNativePath(fileLink, process.platform)
        const info = await stat(filePath)
        if (!info.isFile()) return writeJson(res, 400, { error: 'path is not a file' })
        /**
         * ⚠️ 目录类型（`.app` / `.workbuddy` 这类 bundle）已被上面 `isFile()` 挡掉 ——
         * 但 `.command` / `.sh` / `.exe` / `.lnk` **是普通文件**，必须靠白名单挡。
         */
        const decision = decideOpenMode(filePath)
        if (decision.mode === 'open') {
          await openFileImpl(filePath)
          return writeJson(res, 200, { ok: true, path: filePath, mode: 'open' })
        }
        /**
         * 降级腿是**尽力而为**：`open -R` / `explorer /select,` / `xdg-open <目录>`
         * 在无桌面环境（headless CI、SSH 会话）里可能全都不存在。
         *
         * 那种情况**不能报失败**：判定已经生效（我们确实没有执行任何东西），
         * 用户照样可以自己进那个目录。返回 200 + `revealed:false`，
         * 由客户端**如实**说"不会用默认程序打开，请手动到该目录打开"——
         * 报成 400 会让"这台机器没有 xdg-open"看起来像"接口坏了"。
         */
        let revealed = true
        try {
          await revealFileImpl(filePath)
        } catch {
          revealed = false
        }
        return writeJson(res, 200, {
          ok: true,
          path: filePath,
          mode: 'reveal',
          revealed,
          reason: decision.reason,
          extension: decision.extension,
        })
      } catch (error) {
        return badRequest(res, error)
      }
    },
  }
}
