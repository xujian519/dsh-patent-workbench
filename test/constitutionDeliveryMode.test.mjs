/**
 * 宪法对齐：送达方式不得用默认值补事实。
 *
 * 对应条款：
 * - 第 3 条（缺失即不确定）：缺送达方式 → 送达日 UNDETERMINED，禁止兜底；
 * - 第 11 条之一（送达日 ≠ 发文日）：送达方式是必填事实，不是可省略的分支；
 * - 第 13 条之二（工具入参不补事实）：省略即未知；
 * - 第 32 条门禁第 11 项（删参测试）。
 *
 * 破例登记：dsh-PMS `docs/exceptions/EX-2026-001-delivery-mode-default.md`。
 * 这份测试就是它的**偿还证据**：默认值从数据库、仓储层、界面三处一起删掉，
 * 任何一处长回来都会在这里变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createMatter, createMatterNotice } from '../lib/db/repo.js'
import { buildDeadlineQuery } from '../lib/shared/patentDeadline.js'

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

function freshDb() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  return db
}

const baseMatter = () => ({ caseNumber: 'CN-2026-0001', title: '一种测试装置', matterType: 'drafting' })

const notice = (overrides = {}) => ({
  noticeKind: 'office-action-first',
  dispatchDate: '2026-03-01',
  deliveryMode: 'electronic',
  deliveryDate: null,
  designatedMonths: null,
  ...overrides,
})

test('第 3 条 / 第 11 条之一：数据库层没有送达方式默认值', () => {
  const db = freshDb()
  try {
    const columns = db.prepare('PRAGMA table_info(matter_notices)').all()
    const mode = columns.find((column) => column.name === 'delivery_mode')
    assert.ok(mode !== undefined, 'matter_notices 缺 delivery_mode 列')
    assert.equal(mode.dflt_value, null, 'delivery_mode 不得有数据库默认值（否则省略写入会被静默补成电子送达）')
    assert.equal(Number(mode.notnull), 0, 'delivery_mode 必须可空：NULL = 尚未登记，不是电子送达')

    // 字典齐全：登记表单不再需要硬编码回落值
    const modes = db.prepare("SELECT code FROM dictionaries WHERE kind = 'delivery_mode' AND active = 1 ORDER BY sort_order").all()
    assert.deepEqual(modes.map((row) => row.code), ['electronic', 'postal', 'personal', 'publication'])
  } finally {
    db.close()
  }
})

test('第 3 条：客户端源码里不存在电子送达的硬编码回落', () => {
  for (const path of ['client/index.tsx', 'client/components/dialogs/NoticeDraftModal.tsx', 'client/components/MattersView.tsx']) {
    const text = src(path)
    assert.ok(
      !/['"]electronic['"]/.test(text),
      `${path} 不得硬编码 'electronic'：送达方式只能由用户显式选择（EX-2026-001）`,
    )
  }
  // 判定时点不得回落到系统当天（第 4 条 / 第 13 条之二）
  assert.ok(
    !/today\s*=\s*typeof raw\.today[\s\S]{0,120}?:\s*localDateString\(\)/.test(src('api/routes/matters.ts')),
    '重算接口不得在省略 today 时取系统当天',
  )
})

test('第 13 条之二：省略送达方式 → 当场拒绝，不落库', () => {
  const db = freshDb()
  try {
    const matter = createMatter(db, baseMatter())
    for (const deliveryMode of [undefined, null, '']) {
      assert.throws(
        () => createMatterNotice(db, { matterId: matter.id, noticeKind: 'grant-notice', dispatchDate: '2026-03-01', deliveryMode }),
        /送达方式必填/,
        `deliveryMode=${JSON.stringify(deliveryMode)} 必须被拒`,
      )
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM matter_notices').get().c, 0)
  } finally {
    db.close()
  }
})

test('第 11 条之一：缺送达方式的官文不进引擎，转成可机读 pending', () => {
  // 三个用例对应宪法第 11 条之一的检验：
  //   {发文日, 方式 NULL} → UNDETERMINED（这里是 pending + requiredInput）
  //   {发文日, 方式 electronic} → 送出电子的 mode，送达日交给引擎
  //   {发文日, 方式 postal} → 送出邮寄的 mode，送达日交给引擎
  const missing = buildDeadlineQuery({ matter: { applicationNo: '202620000001.0', patentKind: 'invention', filingDate: '2026-01-05', priorityDate: null, claimsPriority: false, isPctNationalPhase: false, extra: {} }, notices: [notice({ deliveryMode: null })], today: '2026-09-20' })
  assert.ok(!('notices' in missing.query))
  assert.deepEqual(missing.pending.map((entry) => entry.requiredInput), ['deliveryMode'])

  for (const mode of ['electronic', 'postal']) {
    const built = buildDeadlineQuery({
      matter: { applicationNo: '202620000001.0', patentKind: 'invention', filingDate: '2026-01-05', priorityDate: null, claimsPriority: false, isPctNationalPhase: false, extra: {} },
      notices: [notice({ deliveryMode: mode })],
      today: '2026-09-20',
    })
    assert.equal(built.query.notices[0].delivery.mode, mode)
    // 没有确认过送达日时不编造"证据日期"：送达日由引擎按该分支的规则算
    assert.ok(!('enteredDate' in built.query.notices[0].delivery))
    assert.ok(!('actualReceiptDate' in built.query.notices[0].delivery))
    assert.equal(built.pending.length, 0)
  }
})
