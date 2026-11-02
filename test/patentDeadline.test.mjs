/**
 * 案卷 → 期限引擎 适配层（阶段 3）：只测**映射**，不测期限规则。
 *
 * 期限规则（起算日、法定/指定期间、细则第5条顺延）属 DSH Patent 的
 * `@deepseek-ai/dsh-patent-deadline`，在那里测；本文件测的是"工作台的案卷/官文
 * 有没有被正确翻译成引擎入参、引擎报告有没有被正确落成期限行"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDeadlineQuery, reportToDeadlineRows, toCalendarDate } from '../lib/shared/patentDeadline.js'

test('toCalendarDate：只接受真实存在的 YYYY-MM-DD', () => {
  assert.deepEqual(toCalendarDate('2026-02-28'), { year: 2026, month: 2, day: 28 })
  // 假日期必须被拒（复用仓储层的真实性判定，不在这里另写一份）
  assert.equal(toCalendarDate('2026-02-30'), null)
  assert.equal(toCalendarDate('2026-13-01'), null)
  assert.equal(toCalendarDate('2026-2-8'), null)
  assert.equal(toCalendarDate('2026/02/08'), null)
  assert.equal(toCalendarDate(''), null)
})

const matter = (overrides = {}) => ({
  applicationNo: '202620000001.0',
  patentKind: 'invention',
  filingDate: '2026-01-05',
  priorityDate: null,
  claimsPriority: false,
  isPctNationalPhase: false,
  extra: {},
  ...overrides,
})

const notice = (overrides = {}) => ({
  noticeKind: 'office-action-first',
  dispatchDate: '2026-03-01',
  deliveryMode: 'electronic',
  deliveryDate: null,
  designatedMonths: null,
  ...overrides,
})

test('buildDeadlineQuery：预备案卷（无申请号）不产生法律期限', () => {
  // 宪法第 6 条之一第 3 点：申请号未定的案卷不得进入期限计算
  for (const applicationNo of [null, '', '   ']) {
    assert.throws(
      () => buildDeadlineQuery({ matter: matter({ applicationNo }), notices: [], today: '2026-09-20' }),
      /预备案卷/,
      `applicationNo=${JSON.stringify(applicationNo)} 必须被拒`,
    )
  }
})

test('buildDeadlineQuery：必填缺失一律抛中文错误，不静默丢字段', () => {
  assert.throws(() => buildDeadlineQuery({ matter: matter({ patentKind: null }), notices: [], today: '2026-09-20' }), /专利类型/)
  assert.throws(() => buildDeadlineQuery({ matter: matter({ filingDate: null }), notices: [], today: '2026-09-20' }), /申请日/)
  assert.throws(() => buildDeadlineQuery({ matter: matter({ filingDate: '2026-02-30' }), notices: [], today: '2026-09-20' }), /申请日/)
  assert.throws(() => buildDeadlineQuery({ matter: matter(), notices: [], today: '' }), /出报告日/)
  // 要求优先权却没给优先权日：不许拿申请日去近似
  assert.throws(() => buildDeadlineQuery({ matter: matter({ claimsPriority: true }), notices: [], today: '2026-09-20' }), /优先权日/)
})

test('buildDeadlineQuery：优先权、PCT、扩展字段按显式输入映射', () => {
  const { query, pending } = buildDeadlineQuery({
    matter: matter({
      claimsPriority: true,
      priorityDate: '2025-12-01',
      isPctNationalPhase: true,
      extra: { authorizationPublicationDate: '2026-06-10', marketingApprovalDate: '2026-07-01' },
    }),
    notices: [],
    today: '2026-09-20',
    restDayRule: 'omit',
  })
  assert.equal(pending.length, 0)
  assert.equal(query.kind, 'invention')
  assert.deepEqual(query.filingDate, { year: 2026, month: 1, day: 5 })
  assert.equal(query.claimsPriority, true)
  assert.deepEqual(query.priorityDate, { year: 2025, month: 12, day: 1 })
  assert.equal(query.isPctNationalPhase, true)
  assert.deepEqual(query.authorizationPublicationDate, { year: 2026, month: 6, day: 10 })
  assert.deepEqual(query.marketingApprovalDate, { year: 2026, month: 7, day: 1 })
  assert.equal(query.restDayRule, 'omit')
  assert.deepEqual(query.today, { year: 2026, month: 9, day: 20 })
})

test('buildDeadlineQuery：不要求优先权但填了优先权日时照样传（不推断、也不丢）', () => {
  const { query } = buildDeadlineQuery({ matter: matter({ priorityDate: '2025-12-01' }), notices: [], today: '2026-09-20' })
  assert.equal(query.claimsPriority, false)
  assert.deepEqual(query.priorityDate, { year: 2025, month: 12, day: 1 })
})

test('buildDeadlineQuery：扩展字段缺失即不传（交给引擎列 pending），非法值抛错', () => {
  const { query } = buildDeadlineQuery({ matter: matter(), notices: [], today: '2026-09-20' })
  assert.ok(!('authorizationPublicationDate' in query))
  assert.ok(!('marketingApprovalDate' in query))
  assert.ok(!('isPctNationalPhase' in query))
  assert.throws(
    () => buildDeadlineQuery({ matter: matter({ extra: { authorizationPublicationDate: '不是日期' } }), notices: [], today: '2026-09-20' }),
    /authorizationPublicationDate/,
  )
})

test('buildDeadlineQuery：官文按送达方式映射成"有证据日期"，并带指定期间', () => {
  const pairs = [
    ['electronic', 'enteredDate'],
    ['postal', 'actualReceiptDate'],
    ['personal', 'handedOverDate'],
    ['publication', 'publicationDate'],
  ]
  for (const [mode, field] of pairs) {
    const { query } = buildDeadlineQuery({
      matter: matter(),
      notices: [notice({ deliveryMode: mode, deliveryDate: '2026-03-16' })],
      today: '2026-09-20',
    })
    const entry = query.notices[0]
    assert.equal(entry.kind, 'office-action-first')
    assert.equal(entry.delivery.mode, mode)
    assert.deepEqual(entry.delivery.dispatchDate, { year: 2026, month: 3, day: 1 })
    assert.deepEqual(entry.delivery[field], { year: 2026, month: 3, day: 16 }, `${mode} → ${field}`)
  }
  // 没确认送达日时不编造证据日期；指定期间原样带上
  const { query: bare } = buildDeadlineQuery({ matter: matter(), notices: [notice({ designatedMonths: 4 })], today: '2026-09-20' })
  assert.ok(!('enteredDate' in bare.notices[0].delivery))
  assert.equal(bare.notices[0].designatedMonths, 4)
  // 一笔官文都没有时不传 notices（引擎对空数组与缺字段同义，但少一个形状差异）
  assert.ok(!('notices' in buildDeadlineQuery({ matter: matter(), notices: [], today: '2026-09-20' }).query))
})

test('buildDeadlineQuery：送达方式缺失的官文不进引擎，转成 pending 并点名缺项', () => {
  // 宪法第 3 条 / 第 11 条之一：缺送达方式时送达日必须 UNDETERMINED。
  // 引擎的 mode 是必填且"省略即电子送达"，所以这条官文**不许送进去**。
  const { query, pending } = buildDeadlineQuery({
    matter: matter(),
    notices: [notice({ deliveryMode: null })],
    today: '2026-09-20',
  })
  assert.ok(!('notices' in query), '缺送达方式的官文不得以任何默认方式送进引擎')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].requiredInput, 'deliveryMode')
  assert.match(pending[0].reason, /不默认按电子送达/)
  assert.match(pending[0].label, /office-action-first/)

  // 同一卷里其余官文照常计算：一处缺口不该让整卷期限变空白
  const mixed = buildDeadlineQuery({
    matter: matter(),
    notices: [notice({ deliveryMode: null }), notice({ deliveryMode: 'postal', dispatchDate: '2026-04-01' })],
    today: '2026-09-20',
  })
  assert.equal(mixed.query.notices.length, 1)
  assert.equal(mixed.query.notices[0].delivery.mode, 'postal')
  assert.equal(mixed.pending.length, 1)
})

test('reportToDeadlineRows：只落已算出的期限，pending 不进真日期列', () => {
  const rows = reportToDeadlineRows({
    computed: [{
      id: 'priority-window', label: '优先权期限', legalBasis: '专利法第29条第1款',
      rawDueDate: '2027-01-05', dueDate: '2027-01-06', daysRemaining: 108, status: 'normal',
      rolledForward: true, triggerBasis: '申请日', calendarCaveat: '2027 年节假日安排未收录',
    }],
    pending: [{ id: 'grant-registration', label: '授权登记', legalBasis: '细则第X条', requiredInput: 'authorizationPublicationDate', reason: '缺授权公告日' }],
    restDayRule: 'apply',
  }, { today: '2026-09-20', engine: 'test-engine' })

  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.deadlineKey, 'priority-window')
  assert.equal(row.dueDate, '2027-01-06')
  assert.equal(row.dueDateRaw, '2027-01-05')
  assert.equal(row.basis, '专利法第29条第1款')
  assert.equal(row.computedFrom.engine, 'test-engine')
  assert.equal(row.computedFrom.today, '2026-09-20')
  assert.equal(row.computedFrom.restDayRule, 'apply')
  assert.equal(row.computedFrom.rolledForward, true)
  assert.equal(row.computedFrom.triggerBasis, '申请日')
  assert.equal(row.computedFrom.calendarCaveat, '2027 年节假日安排未收录')
  assert.ok(!('daysRemaining' in row.computedFrom), 'daysRemaining 是相对今天的派生值，不得落库')
})

test('reportToDeadlineRows：可选来源缺失时不写空键', () => {
  const rows = reportToDeadlineRows({
    computed: [{
      id: 'annual-fee-1', label: '第1年年费', legalBasis: '专利法第44条',
      rawDueDate: '2027-01-05', dueDate: '2027-01-05', daysRemaining: 10, status: 'urgent', rolledForward: false,
    }],
    pending: [],
    restDayRule: 'apply',
  }, { today: '2026-09-20', engine: 'test-engine' })
  assert.ok(!('triggerBasis' in rows[0].computedFrom))
  assert.ok(!('calendarCaveat' in rows[0].computedFrom))
})
