import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  appendMatterEvent, createKnowledge, createMatter, createMatterNotice, deleteMatter, deleteMatterNotice,
  getMatter, getKnowledge, getMatterByCaseNumber, listMatterDeadlines, listMatterEvents, listMatterNotices,
  listMatters, replaceMatterDeadlines, setMatterDeadlineStatus, updateMatter, updateKnowledge, listKnowledge,
  findMatterIdByWorkspacePath,
  MATTER_STAGE_CODES, PATENT_KINDS, NOTICE_KINDS, REPEATABLE_NOTICE_KINDS, DELIVERY_MODES,
} from '../lib/db/repo.js'

/** 每个用例一个内存库（迁移 + 出厂字典都跑一遍，与生产 apply() 同序）。 */
function freshDb() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  return db
}

function baseMatter(overrides = {}) {
  return { caseNumber: 'CN-2026-0001', title: '一种测试装置', matterType: 'drafting', ...overrides }
}

test('migration 20: 案卷四表 + 领域字典 + knowledge.matter_id', () => {
  const db = freshDb()
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '22')

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
    for (const table of ['matters', 'matter_notices', 'matter_deadlines', 'matter_events']) {
      assert.ok(tables.includes(table), `缺表 ${table}`)
    }

    const rows = db.prepare("SELECT kind, code FROM dictionaries WHERE kind IN ('matter_type','matter_stage','patent_kind','notice_kind')").all()
    const byKind = {}
    for (const row of rows) (byKind[row.kind] ??= []).push(row.code)
    // 阶段枚举必须逐字对齐 patent-matter 六态（不另造码）
    assert.deepEqual([...byKind.matter_stage].sort(), [...MATTER_STAGE_CODES].sort())
    // 专利类型逐字对齐 patent-deadline 的 PatentKind
    assert.deepEqual([...byKind.patent_kind].sort(), [...PATENT_KINDS].sort())
    // 官文种类逐字对齐 NoticeKind
    assert.deepEqual([...byKind.notice_kind].sort(), [...NOTICE_KINDS].sort())
    assert.ok(byKind.matter_type.length >= 8)
    // 可重复登记的种类与期限引擎同口径
    assert.ok(REPEATABLE_NOTICE_KINDS.has('office-action-subsequent'))
    assert.ok(!REPEATABLE_NOTICE_KINDS.has('grant-notice'))
    assert.deepEqual([...DELIVERY_MODES], ['electronic', 'postal', 'personal', 'publication'])

    const cols = db.prepare('PRAGMA table_info(knowledge_entries)').all().map((col) => col.name)
    assert.ok(cols.includes('matter_id'), 'knowledge_entries 缺 matter_id 列')
  } finally {
    db.close()
  }
})

test('createMatter: 建案、按案号取回、列表过滤', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter({
      patentKind: 'utility-model',
      filingDate: '2026-01-05',
      applicationNo: '202620000001.0',
      attorney: '徐健',
    }))
    assert.equal(matter.caseNumber, 'CN-2026-0001')
    assert.equal(matter.stageCode, 'open')
    assert.equal(matter.patentKind, 'utility-model')
    assert.equal(matter.filingDate, '2026-01-05')
    assert.equal(matter.claimsPriority, false)

    assert.equal(getMatter(db, matter.id).id, matter.id)
    assert.equal(getMatterByCaseNumber(db, 'CN-2026-0001').id, matter.id)

    createMatter(db, baseMatter({ caseNumber: 'CN-2026-0002', title: '另一案', matterType: 'oa_response', stageCode: 'drafting' }))
    assert.equal(listMatters(db).length, 2)
    assert.equal(listMatters(db, { stageCode: 'drafting' }).length, 1)
    assert.equal(listMatters(db, { matterType: 'oa_response' }).length, 1)
    assert.equal(listMatters(db, { q: '另一案' }).length, 1)
    assert.equal(listMatters(db, { q: '202620000001' }).length, 1)
  } finally {
    db.close()
  }
})

test('createMatter: 非法输入当场拒绝（不静默改写）', () => {
  const db = freshDb()
  try {
    assert.throws(() => createMatter(db, baseMatter({ caseNumber: '' })), /案号/)
    assert.throws(() => createMatter(db, baseMatter({ title: '  ' })), /发明名称/)
    assert.throws(() => createMatter(db, baseMatter({ stageCode: 'nope' })), /阶段 非法/)
    assert.throws(() => createMatter(db, baseMatter({ patentKind: 'pct' })), /专利类型 非法/)
    // 2026-02-30 不是真实日期
    assert.throws(() => createMatter(db, baseMatter({ filingDate: '2026-02-30' })), /申请日/)
    assert.throws(() => createMatter(db, baseMatter({ filingDate: '2026/01/05' })), /申请日/)
    // 半填的优先权：两个方向都拒绝
    assert.throws(() => createMatter(db, baseMatter({ claimsPriority: true })), /优先权日/)
    assert.throws(() => createMatter(db, baseMatter({ priorityDate: '2025-01-05' })), /主张优先权/)
    // 合法组合
    const ok = createMatter(db, baseMatter({ claimsPriority: true, priorityDate: '2025-01-05' }))
    assert.equal(ok.claimsPriority, true)
    // 案号唯一
    assert.throws(() => createMatter(db, baseMatter({ title: '重号' })), /已存在/)
  } finally {
    db.close()
  }
})

test('updateMatter: 改案号冲突拒绝、归档补日期、重新打开清日期', () => {
  const db = freshDb()
  try {
    const a = createMatter(db, baseMatter({ caseNumber: 'A-1', title: '甲' }))
    createMatter(db, baseMatter({ caseNumber: 'B-1', title: '乙' }))

    assert.throws(() => updateMatter(db, a.id, { caseNumber: 'B-1' }), /已被另一案卷占用/)
    assert.throws(() => updateMatter(db, a.id, { filingDate: '2026-13-01' }), /申请日/)

    const closed = updateMatter(db, a.id, { stageCode: 'closed' })
    assert.equal(closed.stageCode, 'closed')
    assert.match(closed.closedAt ?? '', /^\d{4}-\d{2}-\d{2}$/)

    const reopened = updateMatter(db, a.id, { stageCode: 'analyzing' })
    assert.equal(reopened.stageCode, 'analyzing')
    assert.equal(reopened.closedAt, null)

    const renamed = updateMatter(db, a.id, { title: '甲（改名）' })
    assert.equal(renamed.title, '甲（改名）')
    assert.throws(() => updateMatter(db, 'no-such-id', { title: 'x' }), /不存在/)
  } finally {
    db.close()
  }
})

test('matter_notices: 一案一份的官文重复登记被拒，可重复种类允许', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter())
    const first = createMatterNotice(db, {
      matterId: matter.id, noticeKind: 'office-action-first', dispatchDate: '2026-03-01', designatedMonths: 4,
    })
    assert.equal(first.deliveryMode, 'electronic')
    assert.equal(first.designatedMonths, 4)
    // 一案只有一份 → 第二份拒绝
    assert.throws(() => createMatterNotice(db, { matterId: matter.id, noticeKind: 'office-action-first', dispatchDate: '2026-04-01' }), /已登记过/)
    // 可重复种类 → 允许多份
    createMatterNotice(db, { matterId: matter.id, noticeKind: 'office-action-subsequent', dispatchDate: '2026-05-01' })
    createMatterNotice(db, { matterId: matter.id, noticeKind: 'office-action-subsequent', dispatchDate: '2026-07-01' })
    assert.equal(listMatterNotices(db, matter.id).length, 3)

    assert.throws(() => createMatterNotice(db, { matterId: matter.id, noticeKind: 'nope', dispatchDate: '2026-03-01' }), /官文种类 非法/)
    assert.throws(() => createMatterNotice(db, { matterId: matter.id, noticeKind: 'grant-notice', dispatchDate: '2026-02-30' }), /发文日/)
    assert.throws(() => createMatterNotice(db, { matterId: matter.id, noticeKind: 'grant-notice', dispatchDate: '2026-03-01', deliveryMode: 'fax' }), /送达方式 非法/)
    assert.throws(() => createMatterNotice(db, { matterId: matter.id, noticeKind: 'grant-notice', dispatchDate: '2026-03-01', designatedMonths: 0 }), /指定期限月数/)
    assert.throws(() => createMatterNotice(db, { matterId: 'no-such', noticeKind: 'grant-notice', dispatchDate: '2026-03-01' }), /案卷不存在/)

    assert.equal(deleteMatterNotice(db, first.id), true)
    assert.equal(deleteMatterNotice(db, first.id), false)
  } finally {
    db.close()
  }
})

test('matter_deadlines: 重算保留用户已确认状态；非法日期/重复 key 拒绝', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter())
    const first = replaceMatterDeadlines(db, matter.id, [
      { deadlineKey: 'oa-1-response', label: '第一次审查意见答复', dueDate: '2026-07-01', dueDateRaw: '2026-07-01', basis: '专利法实施细则第5条' },
      { deadlineKey: 'annual-fee-1', label: '第1年年费', dueDate: '2027-01-05', dueDateRaw: '2027-01-05' },
    ])
    assert.equal(first.length, 2)
    assert.equal(first[0].status, 'pending')
    assert.deepEqual(first[0].computedFrom, {})

    // 用户点了「已办理」
    const done = setMatterDeadlineStatus(db, first[0].id, 'done')
    assert.equal(done.status, 'done')
    assert.throws(() => setMatterDeadlineStatus(db, first[0].id, 'forgotten'), /期限状态非法/)
    assert.throws(() => setMatterDeadlineStatus(db, 'no-such', 'done'), /不存在/)

    // 重算：dueDate 更新，但已确认的 done 不被打回 pending
    const recomputed = replaceMatterDeadlines(db, matter.id, [
      { deadlineKey: 'oa-1-response', label: '第一次审查意见答复（重算）', dueDate: '2026-08-01', dueDateRaw: '2026-07-30' },
    ])
    assert.equal(recomputed.length, 1)
    assert.equal(recomputed[0].dueDate, '2026-08-01')
    assert.equal(recomputed[0].status, 'done', '重算不得把已办理刷回 pending')

    assert.throws(() => replaceMatterDeadlines(db, matter.id, [
      { deadlineKey: 'x', label: 'x', dueDate: '2026-02-30', dueDateRaw: '2026-02-28' },
    ]), /届满日/)
    assert.throws(() => replaceMatterDeadlines(db, matter.id, [
      { deadlineKey: 'd', label: 'd', dueDate: '2026-01-01', dueDateRaw: '2026-01-01' },
      { deadlineKey: 'd', label: 'd2', dueDate: '2026-01-02', dueDateRaw: '2026-01-02' },
    ]), /重复/)
    assert.equal(listMatterDeadlines(db, matter.id).length, 1)
  } finally {
    db.close()
  }
})

test('matter_events: 只追加、按时间返回', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter())
    appendMatterEvent(db, { matterId: matter.id, action: '建案', artifact: 'patent-workspace/A-1/', approver: '用户', at: '2026-03-01T10:00:00.000Z' })
    appendMatterEvent(db, { matterId: matter.id, action: '检索', artifact: '01-检索/x.md' })
    const events = listMatterEvents(db, matter.id)
    assert.equal(events.length, 2)
    assert.equal(events[0].action, '建案')
    assert.equal(events[1].action, '检索')
    assert.throws(() => appendMatterEvent(db, { matterId: matter.id, action: '' }), /动作/)
    assert.throws(() => appendMatterEvent(db, { matterId: 'no-such', action: 'x' }), /案卷不存在/)
  } finally {
    db.close()
  }
})

test('deleteMatter: 级联官文/期限/事件，并解绑知识条目的 matter_id', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter())
    createMatterNotice(db, { matterId: matter.id, noticeKind: 'grant-notice', dispatchDate: '2026-03-01' })
    replaceMatterDeadlines(db, matter.id, [{ deadlineKey: 'd', label: 'd', dueDate: '2026-04-01', dueDateRaw: '2026-04-01' }])
    appendMatterEvent(db, { matterId: matter.id, action: '建案' })
    const entry = createKnowledge(db, { title: '挂在案卷上的沉淀', contentMd: '正文' })
    db.prepare('UPDATE knowledge_entries SET matter_id = ? WHERE id = ?').run(matter.id, entry.id)

    const result = deleteMatter(db, matter.id)
    assert.deepEqual(result, { deleted: true, detachedKnowledge: 1 })
    assert.equal(getMatter(db, matter.id), undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM matter_notices').get().c, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM matter_deadlines').get().c, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM matter_events').get().c, 0)
    assert.equal(getKnowledge(db, entry.id).matter_id ?? null, null, '知识条目的 matter_id 应被解绑，不留悬空指针')

    assert.deepEqual(deleteMatter(db, matter.id), { deleted: false, detachedKnowledge: 0 })
  } finally {
    db.close()
  }
})

// --------------------------------------------------------------------------- 路由

function startServer(db, deps = {}) {
  const routes = makeRoutes(db, deps)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return server
}

async function withServer(fn, deps = {}) {
  const db = freshDb()
  const server = startServer(db, deps)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}/api/workbench/matters`
  try {
    await fn(base)
  } finally {
    server.close()
    db.close()
  }
}

test('routes: 建案 / 列表 / 详情 / 改阶段 / 官文 / 事件 / 删除', async () => {
  await withServer(async (base) => {
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseNumber: 'R-1', title: '路由案卷', matterType: 'drafting', patentKind: 'invention' }),
    })
    assert.equal(created.status, 201)
    const { matter } = await created.json()
    assert.equal(matter.caseNumber, 'R-1')

    const list = await (await fetch(base)).json()
    assert.equal(list.matters.length, 1)

    const detail = await (await fetch(`${base}/${matter.id}`)).json()
    assert.equal(detail.matter.title, '路由案卷')

    const badStage = await fetch(`${base}?stage_code=nope`)
    assert.equal(badStage.status, 400)

    const patched = await (await fetch(`${base}/${matter.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageCode: 'drafting' }),
    })).json()
    assert.equal(patched.matter.stageCode, 'drafting')

    const invalid = await fetch(`${base}/${matter.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filingDate: '2026-02-30' }),
    })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /申请日/)

    const notice = await fetch(`${base}/${matter.id}/notices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noticeKind: 'office-action-first', dispatchDate: '2026-03-01', designatedMonths: 4 }),
    })
    assert.equal(notice.status, 201)
    const notices = await (await fetch(`${base}/${matter.id}/notices`)).json()
    assert.equal(notices.notices.length, 1)

    const event = await fetch(`${base}/${matter.id}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: '建案' }),
    })
    assert.equal(event.status, 201)
    const events = await (await fetch(`${base}/${matter.id}/events`)).json()
    assert.equal(events.events.length, 1)

    const removed = await fetch(`${base}/${matter.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal((await fetch(`${base}/${matter.id}`)).status, 404)
  })
})

// --------------------------------------------------------------------------- 期限重算（阶段 3：调 DSH Patent 的 patentDeadline 服务）

/** 替身引擎：只验证"映射与落库"，期限规则本身在 DSH Patent 侧测。 */
function stubEngine(seen) {
  return {
    evaluate(query) {
      seen.push(query)
      return {
        computed: [{
          id: 'priority-window', label: '优先权期限', legalBasis: '专利法第29条第1款',
          rawDueDate: '2027-01-05', dueDate: '2027-01-05', daysRemaining: 107, status: 'normal',
          rolledForward: false, triggerBasis: '申请日',
        }],
        pending: [{ id: 'grant-registration', label: '授权登记', legalBasis: '细则第X条', requiredInput: 'authorizationPublicationDate', reason: '缺授权公告日' }],
        restDayRule: 'apply',
      }
    },
    calendarCoverage: () => ({ years: [2026, 2027] }),
  }
}

test('路由：期限重算调引擎、落库、返回待补输入', async () => {
  const seen = []
  await withServer(async (base) => {
    const created = await (await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseNumber: 'D-1', title: '期限案卷', matterType: 'drafting', patentKind: 'invention', filingDate: '2026-01-05' }),
    })).json()
    const matterId = created.matter.id

    const res = await fetch(`${base}/${matterId}/deadlines/recompute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ today: '2026-09-20' }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.today, '2026-09-20')
    assert.equal(payload.restDayRule, 'apply')
    assert.deepEqual(payload.calendarCoverage.years, [2026, 2027])
    // pending 没有届满日，只随响应返回，不进真日期列
    assert.deepEqual(payload.pending.map((entry) => entry.id), ['grant-registration'])
    assert.equal(payload.deadlines.length, 1)
    assert.equal(payload.deadlines[0].deadlineKey, 'priority-window')
    assert.equal(payload.deadlines[0].dueDate, '2027-01-05')
    assert.equal(payload.deadlines[0].status, 'pending')
    // computed_from 记来源（可追溯），但**不记** daysRemaining（每天都会变的派生值）
    assert.equal(payload.deadlines[0].computedFrom.engine, '@deepseek-ai/dsh-patent-deadline')
    assert.equal(payload.deadlines[0].computedFrom.today, '2026-09-20')
    assert.equal(payload.deadlines[0].computedFrom.triggerBasis, '申请日')
    assert.ok(!('daysRemaining' in payload.deadlines[0].computedFrom))

    // 传给引擎的入参：值域逐字对齐（无翻译层）
    assert.equal(seen.length, 1)
    assert.equal(seen[0].kind, 'invention')
    assert.deepEqual(seen[0].filingDate, { year: 2026, month: 1, day: 5 })
    assert.deepEqual(seen[0].today, { year: 2026, month: 9, day: 20 })
    assert.equal(seen[0].claimsPriority, false)

    // 重算保留用户已确认的状态（done 不被刷回 pending）
    const stored = (await (await fetch(`${base}/${matterId}/deadlines`)).json()).deadlines
    assert.equal(stored.length, 1)
    await fetch(`${base}/${matterId}/deadlines/${stored[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
    })
    await fetch(`${base}/${matterId}/deadlines/recompute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ today: '2026-09-21' }),
    })
    const after = (await (await fetch(`${base}/${matterId}/deadlines`)).json()).deadlines
    assert.equal(after[0].status, 'done')
    assert.equal(after[0].computedFrom.today, '2026-09-21')
  }, { patentDeadline: () => stubEngine(seen) })
})

test('路由：期限引擎缺失时重算明确降级（409，且不偷偷写期限）', async () => {
  await withServer(async (base) => {
    const created = await (await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseNumber: 'D-2', title: '无引擎案卷', matterType: 'drafting', patentKind: 'utility-model', filingDate: '2026-02-01' }),
    })).json()
    const res = await fetch(`${base}/${created.matter.id}/deadlines/recompute`, { method: 'POST' })
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /期限引擎不可用/)
    const list = await (await fetch(`${base}/${created.matter.id}/deadlines`)).json()
    assert.equal(list.deadlines.length, 0)
  })
})

test('路由：必填缺失时重算返回 400 中文原因（不静默丢字段）', async () => {
  const seen = []
  await withServer(async (base) => {
    const created = await (await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseNumber: 'D-3', title: '缺类型案卷', matterType: 'drafting' }),
    })).json()
    const res = await fetch(`${base}/${created.matter.id}/deadlines/recompute`, { method: 'POST' })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /专利类型/)
    assert.equal(seen.length, 0)

    const notFound = await fetch(`${base}/no-such-matter/deadlines/recompute`, { method: 'POST' })
    assert.equal(notFound.status, 404)
  }, { patentDeadline: () => stubEngine(seen) })
})

// ---------------------------------------------------------------------------
// 阶段 5 · 决策 5.2.1：knowledge_entries.matter_id 的读写（此前列在、代码全空）
// ---------------------------------------------------------------------------

test('知识条目归入案卷：create/update/list 三条路都通，且 list 能按案卷过滤', () => {
  const db = freshDb()
  try {
    const m = createMatter(db, baseMatter())
    const other = createMatter(db, baseMatter({ caseNumber: 'CN-2026-0002' }))
    const attached = createKnowledge(db, { title: '答复策略：三步法怎么答', matterId: m.id })
    const loose = createKnowledge(db, { title: '通论：三步法', sourceTaskId: null })
    assert.equal(attached.matterId, m.id, 'createKnowledge 必须落库 matter_id')
    assert.equal(loose.matterId, null, '不给就是不归入（不是静默挂到某个案子下）')
    assert.equal(getKnowledge(db, attached.id).matterId, m.id, '读回来也要在')

    // 过滤：只拿这个案子的
    assert.deepEqual(listKnowledge(db, { matterId: m.id }).map((entry) => entry.id), [attached.id])
    assert.equal(listKnowledge(db, { matterId: other.id }).length, 0)

    // 改归属（含"移出"）
    assert.equal(updateKnowledge(db, loose.id, { matterId: m.id }).matterId, m.id)
    assert.equal(listKnowledge(db, { matterId: m.id }).length, 2)
    assert.equal(updateKnowledge(db, loose.id, { matterId: null }).matterId, null, '显式 null = 移出案卷')

    // 与 sourceTaskId 并存、语义不互相干扰
    const both = createKnowledge(db, { title: '既来自任务又属于案卷', sourceTaskId: null, matterId: other.id })
    assert.equal(both.matterId, other.id)
    assert.equal(both.sourceTaskId, null)
  } finally {
    db.close()
  }
})

test('归入不存在的案卷必须**当场报错**，不许静默写 NULL（否则召回会悄悄少东西）', () => {
  const db = freshDb()
  try {
    for (const call of [
      () => createKnowledge(db, { title: '坏归属', matterId: 'no-such-matter' }),
      () => updateKnowledge(db, createKnowledge(db, { title: '待改' }).id, { matterId: 'no-such-matter' }),
    ]) {
      assert.throws(call, /案卷不存在/, '悬空引用必须显式失败')
    }
    // 失败不许留下半截数据
    assert.equal(listKnowledge(db).filter((entry) => entry.title === '坏归属').length, 0)
  } finally {
    db.close()
  }
})

test('删案卷会把归入它的知识移出案卷（内容与来源一点不动）', () => {
  const db = freshDb()
  try {
    const m = createMatter(db, baseMatter())
    const entry = createKnowledge(db, { title: '归入后删案卷', contentMd: '正文', matterId: m.id })
    const result = deleteMatter(db, m.id)
    assert.deepEqual(result, { deleted: true, detachedKnowledge: 1 })
    const after = getKnowledge(db, entry.id)
    assert.equal(after.matterId, null, '归属被清空')
    assert.equal(after.contentMd, '正文', '内容不许被"顺手"改写')
  } finally {
    db.close()
  }
})

test('findMatterIdByWorkspacePath：目录边界 + 最长优先 + 归一化（"本案卷优先"的判定键）', () => {
  const db = freshDb()
  try {
    const a = createMatter(db, baseMatter({ caseNumber: 'CN-1', workspacePath: '/w/案1' }))
    const ten = createMatter(db, baseMatter({ caseNumber: 'CN-10', workspacePath: '/w/案10' }))
    const deep = createMatter(db, baseMatter({ caseNumber: 'CN-2', workspacePath: '/w/案1/子案' }))
    createMatter(db, baseMatter({ caseNumber: 'CN-3' }))  // 没登记目录 → 不参与匹配
    assert.equal(findMatterIdByWorkspacePath(db, '/w/案1'), a.id)
    assert.equal(findMatterIdByWorkspacePath(db, '/w/案1/'), a.id, '尾斜杠归一化')
    assert.equal(findMatterIdByWorkspacePath(db, String.raw`/w/案1\子`), a.id, '反斜杠归一化（Windows 路径；用 String.raw 才能真的带一个反斜杠进字符串）')
    assert.equal(findMatterIdByWorkspacePath(db, '/w/案10/x'), ten.id, '/w/案1 不许吃掉 /w/案10')
    assert.equal(findMatterIdByWorkspacePath(db, '/w/案1/子案/x'), deep.id, '子目录认更具体的那个')
    assert.equal(findMatterIdByWorkspacePath(db, '/w/其他'), null)
    assert.equal(findMatterIdByWorkspacePath(db, ''), null)
    assert.equal(findMatterIdByWorkspacePath(db, undefined), null, '没有 cwd 不报错，就是不认案卷')
  } finally {
    db.close()
  }
})

test('routes: 知识条目归入案卷（PATCH matterId）—— 合法 200、坏案卷 400 中文原因', async () => {
  await withServer(async (mattersBase) => {
    const knowledgeBase = mattersBase.replace('/api/workbench/matters', '/api/workbench/knowledge')
    const post = (body) => fetch(knowledgeBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const patch = (id, body) => fetch(`${knowledgeBase}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const created = await fetch(mattersBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseNumber: 'R-K-1', title: '带知识的路由案卷', matterType: 'drafting' }) })
    const matterId = (await created.json()).matter.id

    const first = await post({ title: '答复策略：三步法', matterId })
    assert.equal(first.status, 201)
    const entry = (await first.json()).knowledge
    assert.equal(entry.matterId, matterId, 'POST 就要能直接归入案卷')

    const listed = await fetch(`${knowledgeBase}?matter_id=${matterId}`)
    const listedBody = await listed.json()
    assert.deepEqual(listedBody.entries.map((item) => item.id), [entry.id], '列表能按案卷过滤')

    // 坏案卷 id：必须是 400 + 可读原因，不是 500、也不是静默写 NULL
    const bad = await patch(entry.id, { matterId: 'no-such-matter' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /案卷不存在/)

    // 移出案卷：显式 null
    const detached = await patch(entry.id, { matterId: null })
    assert.equal(detached.status, 200)
    assert.equal((await detached.json()).knowledge.matterId, null)
  })
})

// ---------------------------------------------------------------------------
// 阶段 5 · 5C：跨案卷「近 N 天到期」聚合端点
// ---------------------------------------------------------------------------

test('routes: /matter-deadlines/upcoming —— 窗口内、排除已完成/免除与已结案、已过期也要进来', async () => {
  const db = freshDb()
  const server = startServer(db)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}/api/workbench/matter-deadlines/upcoming`
  try {
    const open = createMatter(db, baseMatter({ caseNumber: 'UP-1' }))
    const closed = createMatter(db, baseMatter({ caseNumber: 'UP-CLOSED' }))
    // 结案只能走 PATCH（`MatterInput` 没有 closedAt —— 建档时不能顺手把一个案子标成结案）
    updateMatter(db, closed.id, { closedAt: '2026-09-01' })
    const day = (offset) => {
      const date = new Date()
      date.setDate(date.getDate() + offset)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    /**
     * ⚠️ `replaceMatterDeadlines` 是**整表替换**（这是它的语义：重算就是"这份报告说了什么就是什么"），
     * 所以同一案卷的多条要**一次传进去** —— 分多次调用会互相覆盖，测试会得到"只剩最后一条"的假现场。
     */
    const rows = (offsetMap) => offsetMap.map(([key, offset, status]) => ({
      deadlineKey: key, label: key, dueDate: day(offset), dueDateRaw: day(offset), basis: '细则', status,
    }))
    replaceMatterDeadlines(db, open.id, rows([
      ['d3', 3, 'pending'],
      ['d10', 10, 'pending'],   // 窗口外（默认 7 天）
      ['past', -2, 'pending'],  // 已过期 → 必须进
      ['done', 1, 'done'],      // 已完成 → 不进
      ['waived', 2, 'waived'],  // 已免除 → 不进
    ]))
    // 已结案 → 整卷不进
    replaceMatterDeadlines(db, closed.id, rows([['closed', 1, 'pending']]))

    const res = await fetch(`${base}?days=7`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.deadlines.map((item) => item.label), ['past', 'd3'], '升序（最急的在前）+ 过期保留')
    assert.equal(body.deadlines[0].overdue, true, '过期标记由服务端算（时区口径只在一处）')
    assert.equal(body.deadlines[1].overdue, false)
    assert.equal(body.deadlines[0].caseNumber, 'UP-1', '带出案号，看板要能指回案卷')

    // 窗口可调：days=14 时 d10 也进来
    const wider = await (await fetch(`${base}?days=14`)).json()
    assert.deepEqual(wider.deadlines.map((item) => item.label), ['past', 'd3', 'd10'])

    // 非法 days 回落到缺省 7（不是 0、也不是无限）
    const bad = await (await fetch(`${base}?days=abc`)).json()
    assert.equal(bad.days, 7)

    // 只读：非 GET 一律 405（不给"顺手改期限"的入口）
    assert.equal((await fetch(base, { method: 'POST' })).status, 405)
  } finally {
    server.close()
    db.close()
  }
})
