/**
 * 「已受理」与「已落盘」的区分（调研 P0-1，`docs/research/2026-10-07-灵枢dsh-memory调研.md` §7 第一步①）。
 *
 * ## 为什么需要这道契约
 *
 * 2026-10-03 的 v1.16.4 缺陷形态是「**建得出、确认不了**」：那条知识草稿用工具参数名
 * （`content_md`）建出来，`POST /drafts` 回了 201 看着一切正常，但用户点「确认入库」时
 * 只拿到一句 `knowledge requires content` —— 草稿从头到尾**一个字节都没落盘**，
 * 而链路上每一环都报过成功。灵枢（dsh-memory）对这个问题的答案是给写入结果加一个
 * `committed` 字段（`{"ok": true, "committed": false, "moved_to": "review_queue"}`）：
 * **绝不假装成功**。
 *
 * 本测试锁的就是这条契约：`POST /drafts/:id/confirm` 的每一个响应都必须说清楚
 * 「这次点击到底有没有往库里写东西」，而不是一律 `ok: true`。
 *
 * ## 判据的口径（不是"服务端说自己成功了"，而是"库里的状态真的变了"）
 *
 * `committed === true` 当且仅当：调用**之前**草稿是 `pending` 且 payload 里**没有**
 * 上一次的产出，调用**之后**草稿是 `confirmed`。三条缺一不可：
 *
 * - 草稿不是 pending → 这次没跑 build（回放 / 已被放弃 / 已确认过）；
 * - payload 里已有产出 → 走的是幂等回放路径，一个实体都没重建；
 * - 调用后仍不是 confirmed → `build` 里请求了回滚（`tx.rollback()`），等于没写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createDraft } from '../lib/db/repo.js'

function startTestServer() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  // 生产路径由 apply() 播种字典；测试里也要播，否则 POST /drafts 的 kind 校验会 400。
  seedDictionaries(db)
  const routes = makeRoutes(db, {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return { db, server }
}

async function withServer(fn) {
  const { db, server } = startTestServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const port = address.port
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try {
    await fn({ db, request })
  } finally {
    server.close()
    db.close()
  }
}

test('确认成功时 committed 为 true（真的落盘了）', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '创造性判断', contentMd: '三步法。' } })
    const res = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.committed, true, '待确认草稿确认成功 → 真的写了新实体')
    assert.equal(res.body.knowledge.title, '创造性判断')
  })
})

test('任务草稿重复确认：回放，committed 为 false（没有新建第二条）', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'task', sessionId: null, payload: { title: '重复确认测试', typeCode: 'code_impl', priorityCode: 'p2' } })
    const first = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(first.status, 200)
    assert.equal(first.body.committed, true)

    const second = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(second.status, 200)
    assert.equal(second.body.committed, false, '第二次确认没有新建任何东西')
    assert.equal(second.body.replayed, true)
    assert.equal(second.body.task.id, first.body.task.id, '回放的是同一条任务')

    const count = db.prepare('SELECT COUNT(*) AS n FROM tasks').get()
    assert.equal(count.n, 1, '重复确认不得建出第二条任务')
  })
})

test('知识草稿重复确认：400 且 committed 为 false', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '已被确认过', contentMd: '正文。' } })
    const first = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(first.body.committed, true)

    const second = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(second.status, 400)
    assert.equal(second.body.committed, false, '被拒的确认必须明说"没有落盘"')
  })
})

test('已放弃的草稿：400 且 committed 为 false', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '已放弃', contentMd: '正文。' } })
    const abandoned = await request('POST', `/api/workbench/drafts/${draft.id}/abandon`)
    assert.equal(abandoned.status, 200)

    const res = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(res.status, 400)
    assert.equal(res.body.committed, false)
    const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get()
    assert.equal(count.n, 0, '放弃过的草稿确认不得落库')
  })
})

test('草稿不存在：404 且 committed 为 false', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/api/workbench/drafts/does-not-exist/confirm')
    assert.equal(res.status, 404)
    assert.equal(res.body.committed, false)
  })
})

test('坏 payload 的知识草稿：抛错路径也不假装成功', async () => {
  await withServer(async ({ db, request }) => {
    // 绕过 POST /drafts 的建入校验，直接落一条缺 contentMd 的草稿 ——
    // 复现"已经躺在库里的坏草稿"（v1.16.4 的真实形态）。
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '缺正文' } })
    const res = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(res.status, 400)
    assert.equal(res.body.committed, false)
    // 错误文案必须说明"哪一条、为什么"，不是一句英文栈
    assert.match(String(res.body.error), /content/i)
  })
})
