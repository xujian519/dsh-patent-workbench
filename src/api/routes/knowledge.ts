/**
 * 知识库域路由（含 read-local-file）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { open as openFile, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { assertValidFileLink, createKnowledge, deleteKnowledgeWithRefs, getDictionary, getKnowledge, listKnowledge, updateKnowledge } from '../../db/repo.js'
import { KNOWLEDGE_PREFIX, MAX_LOCAL_DOC_BYTES, badRequest, methodNotAllowed, pathSegments, readJsonBody, requireCode, requireLoopback, toNativePath, writeJson } from './helpers.js'

/**
 * 按**字节**截断 UTF-8 时，最后一个字符可能被切一半、变成 U+FFFD。
 * 只在这个位置去掉它，用户就不会在正文末尾看到一个"�"。
 *
 * 注意不能改用 `String.slice(0, N)` 按字符截 —— 那要求先把整个文件解码成字符串，
 * 正是这里要修掉的开销（见下面 `read-local-file` 的注释）。
 */
function dropSplitTailChar(text: string): string {
  return text.endsWith('\uFFFD') ? text.slice(0, -1) : text
}

export function makeKnowledgeRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: KNOWLEDGE_PREFIX,
      handler: async (req, res) => {
        if (!requireLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, KNOWLEDGE_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined
        if (segments.length === 1 && segments[0] === 'read-local-file') {
          const rawPath = method === 'GET'
            ? url.searchParams.get('path') ?? undefined
            : method === 'POST' && body !== undefined && typeof body.path === 'string' ? body.path : undefined
          if (rawPath === undefined || rawPath.trim() === '') return writeJson(res, 400, { error: 'path is required' })
          try {
            const fileLink = assertValidFileLink(rawPath)
            if (fileLink === null) return writeJson(res, 400, { error: 'path is required' })
            const filePath = toNativePath(fileLink)
            const info = await stat(filePath)
            if (!info.isFile()) return writeJson(res, 400, { error: 'path is not a file' })
            /**
             * ⚠️ 必须先按 `info.size` 判、再决定怎么读 —— **不能"整读进来再 slice"**。
             *
             * 原写法是 `const content = await readFile(filePath, 'utf8')` 之后才比
             * `content.length > MAX_LOCAL_DOC_BYTES`：`readFile` 会把**整个文件**物化成
             * 字符串（1 GB 的日志 ≈ 2 GB 堆），而这条路由的入参是知识条目的 `fileLink`，
             * 它指向多大的文件不由我们决定 —— 上限形同虚设。
             *
             * 超限时改从**文件句柄**读前 MAX 字节：内存恒为 1 MiB，对外契约不变
             * （照旧 200 + `truncated: true`，客户端弹窗无需改动）。
             * 顺带把 `truncated` 的口径修正成**字节**（与常量名 `MAX_LOCAL_DOC_BYTES` 一致；
             * 原来用 `content.length` 是**字符**数，1 MiB 的中文文档被判成"没超限"却仍整读过）。
             */
            const truncated = info.size > MAX_LOCAL_DOC_BYTES
            let content: string
            if (truncated) {
              const handle = await openFile(filePath, 'r')
              try {
                const buffer = Buffer.allocUnsafe(MAX_LOCAL_DOC_BYTES)
                const { bytesRead } = await handle.read(buffer, 0, MAX_LOCAL_DOC_BYTES, 0)
                content = dropSplitTailChar(buffer.subarray(0, bytesRead).toString('utf8'))
              } finally {
                await handle.close()
              }
            } else {
              content = await readFile(filePath, 'utf8')
            }
            return writeJson(res, 200, {
              ok: true,
              path: filePath,
              fileLink,
              name: basename(filePath),
              content,
              truncated,
              size: info.size,
            })
          } catch (error) {
            return badRequest(res, error)
          }
        }
        if (segments.length === 0) {
          if (method === 'GET') {
            const q = url.searchParams.get('q') ?? undefined
            const kindCode = url.searchParams.get('kind_code') ?? undefined
            const sourceTaskId = url.searchParams.get('source_task_id') ?? undefined
            const sourceReviewId = url.searchParams.get('source_review_id') ?? undefined
            const matterId = url.searchParams.get('matter_id') ?? undefined
            if (kindCode !== undefined && getDictionary(db, 'knowledge_kind', kindCode) === undefined) return writeJson(res, 400, { error: 'unknown knowledge_kind' })
            return writeJson(res, 200, { ok: true, entries: listKnowledge(db, { q, kindCode, sourceTaskId, sourceReviewId, matterId }) })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const title = typeof body.title === 'string' ? body.title.trim() : ''
              if (title === '') throw new Error('title is required')
              const kindCode = typeof body.kindCode === 'string' ? body.kindCode : 'note'
              requireCode(db, 'knowledge_kind', kindCode, 'kindCode')
              const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : []
              const fileLink = body.fileLink === undefined || body.fileLink === null ? null : typeof body.fileLink === 'string' ? body.fileLink : undefined
              if (fileLink === undefined) throw new Error('fileLink must be a string or null')
              const entry = createKnowledge(db, {
                kindCode,
                title,
                contentMd: typeof body.contentMd === 'string' ? body.contentMd : '',
                tags,
                sourceTaskId: typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null,
                sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null,
                sourceReviewId: typeof body.sourceReviewId === 'string' ? body.sourceReviewId : null,
                /**
                 * 归入案卷（阶段 5）：`matterId` 给了非空串才归入；不存在时 `createKnowledge`
                 * 会抛「案卷不存在」（→ 400），**不静默写 NULL**。
                 */
                matterId: typeof body.matterId === 'string' && body.matterId.trim() !== '' ? body.matterId.trim() : null,
                fileLink,
              })
              return writeJson(res, 201, { ok: true, knowledge: entry })
            } catch (error) {
              return badRequest(res, error)
            }
          }
          return methodNotAllowed(res)
        }
        const id = segments[0]
        if (method === 'GET' && segments.length === 1) {
          const entry = getKnowledge(db, id)
          return writeJson(res, entry === undefined ? 404 : 200, entry === undefined ? { error: 'knowledge not found' } : { ok: true, knowledge: entry })
        }
        if (method === 'PATCH' && segments.length === 1) {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const patch: Parameters<typeof updateKnowledge>[2] = {}
          if (typeof body.title === 'string') patch.title = body.title.trim()
          if (typeof body.contentMd === 'string') patch.contentMd = body.contentMd
          if (typeof body.kindCode === 'string') { requireCode(db, 'knowledge_kind', body.kindCode, 'kindCode'); patch.kindCode = body.kindCode }
          if (Array.isArray(body.tags)) patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
          if ('sourceTaskId' in body) patch.sourceTaskId = typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null
          if ('sourceReviewId' in body) patch.sourceReviewId = typeof body.sourceReviewId === 'string' ? body.sourceReviewId : null
          if ('fileLink' in body) patch.fileLink = typeof body.fileLink === 'string' ? body.fileLink : null
          /**
           * 归入/移出案卷：显式 `null` 或空串 = 移出；给了不存在的 id → `updateKnowledge`
           * 抛「案卷不存在」（下面的 catch 转 400 中文原因）。
           */
          if ('matterId' in body) patch.matterId = typeof body.matterId === 'string' && body.matterId.trim() !== '' ? body.matterId.trim() : null
          /**
           * P2：取代 / 有效期。
           *
           * `supersededById` 显式传 `null` 表示**解除取代**（用户把标注撤了）；
           * 传非空字符串必须指向一条真实存在的条目 —— 指向不存在的 id 会让
           * "已被 X 取代"变成一句查不到出处的话，而压制行为照样生效（静默的多余压制）。
           * 所以当场 400，不做静默接受。
           */
          if ('supersededById' in body) {
            if (body.supersededById === null) patch.supersededById = null
            else if (typeof body.supersededById === 'string' && body.supersededById.trim() !== '') {
              const target = getKnowledge(db, body.supersededById.trim())
              if (target === undefined) return writeJson(res, 400, { error: `supersededById 指向的条目不存在：${body.supersededById.trim()}` })
              if (target.id === id) return writeJson(res, 400, { error: 'supersededById 不能指向自己' })
              patch.supersededById = target.id
            } else return writeJson(res, 400, { error: 'supersededById 必须是条目 id 或 null' })
          }
          if ('validUntil' in body) {
            if (body.validUntil === null) patch.validUntil = null
            else if (typeof body.validUntil === 'string' && body.validUntil.trim() !== '') {
              if (!Number.isFinite(Date.parse(body.validUntil))) return writeJson(res, 400, { error: 'validUntil 必须是可解析的时间串或 null' })
              patch.validUntil = body.validUntil.trim()
            } else return writeJson(res, 400, { error: 'validUntil 必须是时间串或 null' })
          }
          /**
           * ⚠️ `updateKnowledge` 会为**不存在**的案卷抛错（见 `repo/knowledge.ts#assertKnownMatter`），
           * 所以这里必须包 try —— 与本文件 POST 分支同形。不包的话一个错案卷 id 会变成 500，
           * 而本仓的纪律是"坏输入 → 400 + 可读中文原因"。
           */
          let entry: ReturnType<typeof updateKnowledge>
          try {
            entry = updateKnowledge(db, id, patch)
          } catch (error) {
            return badRequest(res, error)
          }
          if (entry === undefined) return writeJson(res, 404, { error: 'knowledge not found' })
          return writeJson(res, 200, { ok: true, knowledge: entry })
        }
        if (method === 'DELETE' && segments.length === 1) {
          /**
           * P2：删条目要顺带清掉指向它的取代引用，并把"连带影响了几条"**回显给用户** ——
           * 否则"删掉修正条 → 旧条目永久查不到"这种事没有任何地方看得出来。
           */
          const result = deleteKnowledgeWithRefs(db, id)
          return writeJson(res, 200, { ok: true, deleted: result.deleted, clearedSupersedeRefs: result.clearedRefs })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
