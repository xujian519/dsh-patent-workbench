/**
 * 知识库“打开本地文件”路由。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增/修复路由无法通过 dev_reload_package 立即生效）。
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertValidFileLink } from '../db/repo.js'
import { badRequest, errorMessage, methodNotAllowed, readJsonBody, requireLoopback, writeJson } from './http.js'
import { toNativePath, wslDriveToWindows } from '../shared/hostPath.js'

function tryOpen(candidates: Array<{ command: string; args: string[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    const errors: unknown[] = []
    const attempt = (): void => {
      if (index >= candidates.length) {
        reject(new AggregateError(errors, `无法打开文件：所有打开命令均失败（${errors.map(errorMessage).join('; ')}）`))
        return
      }
      const { command, args } = candidates[index++]
      execFile(command, args, { windowsVerbatimArguments: process.platform === 'win32' }, (error) => {
        if (error) { errors.push(error); attempt() } else resolve()
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
  const candidates: Array<{ command: string; args: string[] }> = []
  if (winPath !== filePath) {
    candidates.push({ command: 'cmd.exe', args: ['/c', 'start', '', winPath] })
    candidates.push({ command: 'explorer.exe', args: [winPath] })
  }
  candidates.push({ command: 'wslview', args: [filePath] })
  candidates.push({ command: 'xdg-open', args: [filePath] })
  candidates.push({ command: 'gio', args: ['open', filePath] })
  return tryOpen(candidates)
}

export function makeOpenFileRoute(): WebRoute {
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
        await openLocalFile(filePath)
        return writeJson(res, 200, { ok: true, path: filePath })
      } catch (error) {
        return badRequest(res, error)
      }
    },
  }
}
