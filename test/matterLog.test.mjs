/**
 * `_matter-log.md` 解析层（阶段 6 · bridge 收口）的判据。
 *
 * 这一层是"库只是日志的投影"这句话的**唯一入口**：解析错了，投影就错了，
 * 而界面上一切看起来都正常（时间线少一行或时间对不上，用户只会觉得"怪"）。
 *
 * 格式权威源：DSH Patent 的 `patent-matter` 技能
 *（`packages/bundle/web-app/skills/patent/patent-matter/SKILL.md` §事件日志）：
 * `时间 | 动作 | 产物 | 审批人 | 备注`，管道分隔、只追加。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matterLogEventKey, parseMatterLog } from '../lib/shared/matterLog.js'

const sample = [
  '2026-08-19T21:00:00+08:00 | 建案 | patent-workspace/CN2026-0001/ 目录骨架 | 用户 | 交底书已入 00-交底书/',
  '2026-08-19T21:15:00+08:00 | 检索 | 01-检索/2026-08-19_硅基负极.md | 用户(检索式确认) | 命中 D1/D2',
].join('\n')

test('标准五段行：五个字段逐一对上，时间戳**原样保留**（带偏移是信息，不重写）', () => {
  const parsed = parseMatterLog(sample)
  assert.equal(parsed.events.length, 2)
  assert.deepEqual(parsed.events[0], {
    at: '2026-08-19T21:00:00+08:00',
    action: '建案',
    artifact: 'patent-workspace/CN2026-0001/ 目录骨架',
    approver: '用户',
    note: '交底书已入 00-交底书/',
  })
  assert.equal(parsed.events[1].approver, '用户(检索式确认)', '带括号的审批人原样保留')
  assert.deepEqual(parsed.skipped, [])
})

test('可缺段：2/3/4 段都收，缺的字段是 null（不是空串、不是占位符）', () => {
  const parsed = parseMatterLog([
    '2026-08-19T21:00:00+08:00 | 建案',
    '2026-08-19T21:01:00+08:00 | 检索 | 01-检索/x.md',
    '2026-08-19T21:02:00+08:00 | 分析 | 03-分析/y.md | 用户',
  ].join('\n'))
  assert.deepEqual(parsed.events.map((event) => [event.action, event.artifact, event.approver, event.note]), [
    ['建案', null, null, null],
    ['检索', '01-检索/x.md', null, null],
    ['分析', '03-分析/y.md', '用户', null],
  ])
})

test('备注里带 `|` 不截断（多出的段并回备注）', () => {
  const parsed = parseMatterLog('2026-08-19T21:00:00+08:00 | 交付 | 04-撰写/a.pdf | 用户 | 接受了 3 处修订 | 另有 1 处拒绝')
  assert.equal(parsed.events[0].note, '接受了 3 处修订 | 另有 1 处拒绝')
})

test('脚手架行静默忽略但计数（空行/标题/围栏/引用/水平线/表格分隔/表头）', () => {
  const parsed = parseMatterLog([
    '# 案卷事件日志',
    '',
    '> 只追加，禁止覆写',
    '时间 | 动作 | 产物 | 审批人 | 备注',
    '| --- | --- | --- | --- | --- |',
    '---',
    '```',
    '2026-08-19T21:00:00+08:00 | 建案',
    '```',
    '2026-08-19T21:05:00+08:00 | 检索',
  ].join('\r\n'))
  assert.deepEqual(parsed.events.map((event) => event.action), ['检索'], '围栏里的示例行**不算**真事件（它是文档，不是记录）')
  assert.equal(parsed.ignored, 9, '空行/标题/引用/表头/分隔/水平线/两行围栏 + 围栏内那行 = 9')
  assert.deepEqual(parsed.skipped, [], '脚手架不算"未解析"（否则每个带表头的文件都会报一串噪声）')
})

test('看起来是记录但用不了的行 → 进 skipped 并给**行号 + 原因**（绝不静默丢弃）', () => {
  const parsed = parseMatterLog([
    '# 头',
    '2026-08-19T21:00:00+08:00 | 建案',
    '这行没有分隔符',
    '不是时间 | 检索 | x.md',
    '2026-08-19T21:10:00+08:00 | ',
    ' | 检索',
  ].join('\n'))
  assert.deepEqual(parsed.events.map((event) => event.action), ['建案'])
  assert.deepEqual(parsed.skipped.map((row) => row.line), [3, 4, 5, 6], '行号是 1 起的原始行号（人对着文件找得到）')
  assert.match(parsed.skipped[0].reason, /缺少字段分隔符/)
  assert.match(parsed.skipped[1].reason, /时间无法解析/)
  assert.match(parsed.skipped[2].reason, /缺少动作/)
  assert.match(parsed.skipped[3].reason, /缺少时间/)
  for (const row of parsed.skipped) assert.notEqual(row.text, '', '原始文本要带上，否则用户不知道是哪一行')
})

test('BOM 与 CRLF（Windows 上写出来的日志）', () => {
  const parsed = parseMatterLog('\uFEFF2026-08-19T21:00:00+08:00 | 建案\r\n2026-08-19T21:01:00+08:00 | 检索\r\n')
  assert.deepEqual(parsed.events.map((event) => event.action), ['建案', '检索'])
  assert.deepEqual(parsed.skipped, [])
})

test('幂等键 = 时间 + 动作 + 产物（审批人/备注后补不算新事件）', () => {
  const base = { at: '2026-08-19T21:00:00+08:00', action: '建案', artifact: '目录骨架' }
  assert.equal(matterLogEventKey(base), matterLogEventKey({ ...base }))
  assert.notEqual(matterLogEventKey(base), matterLogEventKey({ ...base, artifact: '另一个产物' }))
  // 同一时刻同一动作但产物不同 = 两条（真实场景：一次交付里登记了两个文件）
  const parsed = parseMatterLog([
    '2026-08-19T21:00:00+08:00 | 交付 | a.pdf',
    '2026-08-19T21:00:00+08:00 | 交付 | b.pdf',
  ].join('\n'))
  assert.equal(parsed.events.length, 2)
  assert.notEqual(matterLogEventKey(parsed.events[0]), matterLogEventKey(parsed.events[1]))
})

test('空文件/非字符串输入不炸（返回空结果，不是抛错）', () => {
  for (const input of ['', '\n\n', undefined, null]) {
    const parsed = parseMatterLog(input)
    assert.deepEqual(parsed.events, [])
    assert.deepEqual(parsed.skipped, [])
  }
})
