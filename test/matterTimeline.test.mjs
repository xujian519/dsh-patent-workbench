/**
 * 案卷时间线（阶段 5 · 5B）的纯函数判据。
 *
 * 为什么这层必须单测：它是**三份数据源的日期口径归一化**（ISO 时间戳 vs 纯日期）
 * 加上一个跨源排序。这类"混在一起比大小"的判定一旦写错，表现是"时间线顺序怪怪的"——
 * 用户说不清哪里不对，而界面看起来完全正常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMatterTimeline } from '../lib/client/matterTimeline.js'

/** 字典兜底口径：查不到就原样返回 code（与实现约定一致）。 */
const labelOf = (kind, code) => ({ notice_kind: { office_action_first: '第一次审查意见通知书' }, delivery_mode: { electronic: '电子送达' }, deadline_status: { pending: '待处理' } })[kind]?.[code] ?? code

const event = (over = {}) => ({ id: 'e1', action: '建案', artifact: null, approver: null, note: null, at: '2026-09-30T10:00:00.000Z', ...over })
const notice = (over = {}) => ({ id: 'n1', noticeKind: 'office_action_first', dispatchDate: '2026-10-05', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: 4, fileLink: null, note: null, ...over })
const deadline = (over = {}) => ({ id: 'd1', label: '答复第一次审查意见', dueDate: '2027-02-05', dueDateRaw: '2027-02-05', basis: '专利法实施细则', status: 'pending', ...over })

const build = (over = {}) => buildMatterTimeline({ events: [], notices: [], deadlines: [], labelOf, ...over })

test('三源合并：粒度统一成 YYYY-MM-DD，且按日期降序（最近的在上）', () => {
  const timeline = build({ events: [event()], notices: [notice()], deadlines: [deadline()] })
  assert.deepEqual(timeline.entries.map((entry) => entry.kind), ['deadline', 'notice', 'event'])
  assert.deepEqual(timeline.entries.map((entry) => entry.date), ['2027-02-05', '2026-10-05', '2026-09-30'])
  // ISO 时间戳要按**本地日**归一化（不是 UTC 日）—— 否则临近午夜的事件会跑到前一天
  const localMidnightish = build({ events: [event({ at: new Date(2026, 8, 30, 0, 30).toISOString() })] })
  assert.equal(localMidnightish.entries[0].date, '2026-09-30')
})

test('同一天多条：先事件 → 再官文 → 再期限，且顺序稳定（同输入必同输出）', () => {
  const sameDay = { events: [event({ at: '2026-10-05' })], notices: [notice()], deadlines: [deadline({ dueDate: '2026-10-05' })] }
  const first = build(sameDay)
  assert.deepEqual(first.entries.map((entry) => entry.kind), ['event', 'notice', 'deadline'])
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(build(sameDay).entries.map((entry) => entry.id), first.entries.map((entry) => entry.id), '结果必须稳定（否则每次重渲染顺序都在跳）')
  }
})

test('码翻中文走调用方给的字典；查不到就原样显示码（不猜、不留空）', () => {
  const known = build({ notices: [notice()] })
  assert.equal(known.entries[0].title, '官文：第一次审查意见通知书')
  assert.match(known.entries[0].detail, /送达方式：电子送达/)
  assert.match(known.entries[0].detail, /指定期限：4 个月/)
  const unknown = build({ notices: [notice({ noticeKind: 'brand_new_kind', deliveryMode: 'pigeon' })] })
  assert.equal(unknown.entries[0].title, '官文：brand_new_kind', '字典查不到也要看得见是什么码')
  assert.match(unknown.entries[0].detail, /送达方式：pigeon/)
})

test('日期缺失/无法解析的条目不参与排序，但**不许静默丢弃**（进 undated）', () => {
  const timeline = build({
    events: [event({ at: '' }), event({ id: 'e2', action: '检索', at: '不是时间' })],
    notices: [notice({ dispatchDate: '' })],
    deadlines: [deadline()],
  })
  assert.deepEqual(timeline.entries.map((entry) => entry.kind), ['deadline'])
  assert.equal(timeline.undated.length, 3, '三条没有日期的都要留在 undated 里，让界面能说明原因')
  assert.deepEqual(timeline.undated.map((entry) => entry.kind).sort(), ['event', 'event', 'notice'])
})

test('顺延口径：届满日与不顺延届满日不同时两个都写；相同时不重复写', () => {
  const withRaw = build({ deadlines: [deadline({ dueDate: '2027-02-20', dueDateRaw: '2027-02-05' })] })
  assert.match(withRaw.entries[0].detail, /不顺延届满：2027-02-05/)
  const same = build({ deadlines: [deadline()] })
  assert.doesNotMatch(same.entries[0].detail, /不顺延届满/)
})

test('事件的补充信息拼装：备注 / 产出 / 确认人，空的不留分隔符', () => {
  const only_note = build({ events: [event({ note: '签了委托书' })] })
  assert.equal(only_note.entries[0].detail, '签了委托书')
  const all = build({ events: [event({ note: '签了委托书', artifact: '委托书.pdf', approver: '张三' })] })
  assert.equal(all.entries[0].detail, '签了委托书 · 产出：委托书.pdf · 确认人：张三')
  const none = build({ events: [event()] })
  assert.equal(none.entries[0].detail, '', '什么都没填就是空串（界面据此不渲染第二行）')
})
