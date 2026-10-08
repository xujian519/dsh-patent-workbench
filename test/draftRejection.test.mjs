/**
 * 负记忆：被拒草稿留痕（调研 §7 第一步②，`docs/research/2026-10-07-灵枢dsh-memory调研.md`）。
 *
 * ## 为什么需要这道契约
 *
 * 「草稿没被采纳」这件事此前**大部分时候是静默的**：
 *
 * - 用户放弃草稿时填的理由，只有在草稿**恰好带着一个存在的 `taskId`** 时才会被写进
 *   任务事件与共享记忆；**知识草稿**（`payload` 里根本没有任务）被驳回时理由当场丢弃。
 * - 确认时校验不通过（`knowledge requires content` 这类）只抛一句错误给界面，
 *   弹层一关，库里**没有任何地方记得"这条草稿确认失败过、因为什么"** ——
 *   用户下次点确认只会看到一模一样的报错，提交草稿的 AI 也永远不知道自己被卡在哪。
 *
 * 灵枢（dsh-memory）对这个问题的做法是把 REJECT 落进 `rejected/` 层**留痕可查**。
 * 本仓落在草稿行自己身上：`rejection_reason` / `rejected_at` / `rejection_count` 三列。
 *
 * ## 本测试锁的两条口径
 *
 * 1. **留痕不看草稿有没有关联任务** —— 知识草稿的理由也必须留下来（核心回归点）。
 * 2. **留痕不改 `status_code` 语义** —— 校验失败的知识草稿仍是 `pending`，
 *    用户改好字段后能原地重试；「被拒过」是**附加信息**，不是终态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createDraft, createTask, updateDraft } from '../lib/db/repo.js'

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

/** 直接查列，不走 `getDraft` —— 断言"库里真的有这几列"，而不是"映射函数看起来对"。 */
function rawRejection(db, id) {
  return db.prepare('SELECT rejection_reason, rejected_at, rejection_count, status_code FROM task_drafts WHERE id = ?').get(id)
}

test('驳回知识草稿：理由落进草稿行（此前当场丢弃）', async () => {
  await withServer(async ({ db, request }) => {
    // 知识草稿没有 taskId —— 正是此前理由被丢掉的那一类。
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '待驳回', contentMd: '正文。' } })
    const res = await request('POST', `/api/workbench/drafts/${draft.id}/abandon`, { reason: '源文件还没定稿' })
    assert.equal(res.status, 200)

    const row = rawRejection(db, draft.id)
    assert.equal(row.rejection_reason, '源文件还没定稿')
    assert.equal(row.rejection_count, 1)
    assert.match(String(row.rejected_at), /^\d{4}-\d{2}-\d{2}T/, '被拒时间要落 ISO 串')
    assert.equal(row.status_code, 'abandoned')
  })
})

test('不填理由也计数，但不编造理由', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '没写理由', contentMd: '正文。' } })
    // 空白串与缺字段两种"没填"，口径必须一致。
    const res = await request('POST', `/api/workbench/drafts/${draft.id}/abandon`, { reason: '   ' })
    assert.equal(res.status, 200)

    const row = rawRejection(db, draft.id)
    assert.equal(row.rejection_reason, null, '用户没填理由，不该被编造成有理由')
    assert.equal(row.rejection_count, 1, '没写理由也是一次"被拒"')
    assert.notEqual(row.rejected_at, null)
  })
})

test('确认反复校验失败：每次都留痕、计数递增、草稿仍是 pending', async () => {
  await withServer(async ({ db, request }) => {
    // 绕过 POST /drafts 的建入校验，直接落一条缺 contentMd 的草稿 —— 复现"已经躺在库里的坏草稿"。
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '缺正文' } })

    const first = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(first.status, 400)
    const afterFirst = rawRejection(db, draft.id)
    assert.equal(afterFirst.rejection_count, 1)
    assert.match(String(afterFirst.rejection_reason), /content/i, '失败原因是可读的中文/英文说明，不是空')

    const second = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(second.status, 400)
    const afterSecond = rawRejection(db, draft.id)
    assert.equal(afterSecond.rejection_count, 2, '反复点重试要能看出"又失败了一次"')
    assert.equal(afterSecond.status_code, 'pending', '校验失败不该把草稿推向终态 —— 用户改好后还要能原地重试')
  })
})

test('从未被拒的草稿：三列留空，不伪造留痕', async () => {
  await withServer(async ({ db, request }) => {
    const draft = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '正常草稿', contentMd: '正文。' } })
    const res = await request('POST', `/api/workbench/drafts/${draft.id}/confirm`)
    assert.equal(res.status, 200)

    const row = rawRejection(db, draft.id)
    assert.equal(row.rejection_reason, null)
    assert.equal(row.rejected_at, null)
    assert.equal(row.rejection_count, 0)
  })
})

test('带关联任务的草稿被驳回：草稿行与任务事件两处都有留痕', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '关联任务', typeCode: 'code_impl', priorityCode: 'p2' })
    const draft = createDraft(db, { kindCode: 'task', sessionId: null, payload: { title: '拆分草稿', typeCode: 'code_impl', priorityCode: 'p2', taskId: task.id } })

    const res = await request('POST', `/api/workbench/drafts/${draft.id}/abandon`, { reason: '拆得不对' })
    assert.equal(res.status, 200)

    // 一份给库（草稿行），一份给 AI 会话（任务事件 + 共享记忆）—— 两者范围不同，都要有。
    assert.equal(rawRejection(db, draft.id).rejection_reason, '拆得不对')
    const events = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_code = 'draft_rejected'").get(task.id)
    assert.equal(events.n, 1, '带任务的草稿仍要写任务事件（原有行为不能因为新增留痕而丢掉）')
  })
})

test('GET /drafts 的 rejectedDrafts 能查到被拒草稿（含仍 pending 的校验失败草稿）', async () => {
  await withServer(async ({ db, request }) => {
    const abandoned = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '被驳回的', contentMd: '正文。' } })
    await request('POST', `/api/workbench/drafts/${abandoned.id}/abandon`, { reason: '先不做' })
    const failing = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '校验失败的' } })
    await request('POST', `/api/workbench/drafts/${failing.id}/confirm`)

    const res = await request('GET', '/api/workbench/drafts')
    assert.equal(res.status, 200)
    const ids = (res.body.rejectedDrafts ?? []).map((d) => d.id)
    assert.ok(ids.includes(abandoned.id), '被用户驳回的要能查到')
    assert.ok(ids.includes(failing.id), '判据是 rejected_at 非空，不看 status_code —— 仍是 pending 的也要能查到')
    const found = res.body.rejectedDrafts.find((d) => d.id === abandoned.id)
    assert.equal(found.rejectionReason, '先不做', '列表里要带上理由，否则"可查"是空的')
    assert.equal(found.rejectionCount, 1)
  })
})

test('被拒后又**确认**的草稿：留痕还在，但不再算「被驳回的草稿」', async () => {
  await withServer(async ({ db, request }) => {
    // 造一条"被拒过、用户改好后真的入库了"的草稿：这正是漏判据会把它错列进驳回清单的场景。
    const fixed = createDraft(db, { kindCode: 'knowledge', sessionId: null, payload: { title: '改好能用' } })
    await request('POST', `/api/workbench/drafts/${fixed.id}/confirm`)   // 缺 contentMd → 留痕、仍 pending
    assert.equal(rawRejection(db, fixed.id).rejection_count, 1, '前提：这条确实被拒过')
    updateDraft(db, fixed.id, { title: '改好能用', contentMd: '补上正文。', kindCode: 'note' })
    const ok = await request('POST', `/api/workbench/drafts/${fixed.id}/confirm`)
    assert.equal(ok.status, 200, '改好后必须能确认（否则这个用例测的不是"已确认"这条路径）')

    // 三列**不清除** —— 「负记忆」不因为事后被采纳就抹掉，这是设计。
    const raw = rawRejection(db, fixed.id)
    assert.equal(raw.status_code, 'confirmed')
    assert.equal(raw.rejection_count, 1)
    assert.notEqual(raw.rejected_at, null)

    // 但列表要按"现在还算不算未处理的驳回"过滤：用户已经批准了，再列出来就是错的。
    const res = await request('GET', '/api/workbench/drafts')
    assert.equal(res.status, 200)
    const ids = (res.body.rejectedDrafts ?? []).map((d) => d.id)
    assert.equal(ids.includes(fixed.id), false, '已确认的草稿不许出现在「被驳回」清单里')
  })
})
