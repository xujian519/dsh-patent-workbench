/**
 * 方案 A：期限看板分组。过期只信服务端；今日届满只跟传入的面板日键比相等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deadlineUrgencyCount, groupUpcomingDeadlines } from '../lib/client/deadlineBoard.js'

const row = (over = {}) => ({
  id: 'x', matterId: 'm', caseNumber: 'C', matterTitle: 'T', label: 'L',
  dueDate: '2026-10-05', status: 'pending', overdue: false, ...over,
})

test('已过期 → 今日届满 → 其余，组内保持原顺序', () => {
  const groups = groupUpcomingDeadlines([
    row({ id: 'rest-1', dueDate: '2026-10-04' }),
    row({ id: 'over-1', dueDate: '2026-09-01', overdue: true }),
    row({ id: 'today-1', dueDate: '2026-10-03' }),
    row({ id: 'over-2', dueDate: '2026-09-20', overdue: true }),
    row({ id: 'rest-2', dueDate: '2026-10-06' }),
  ], '2026-10-03')
  assert.deepEqual(groups.overdue.map((item) => item.id), ['over-1', 'over-2'])
  assert.deepEqual(groups.dueToday.map((item) => item.id), ['today-1'])
  assert.deepEqual(groups.rest.map((item) => item.id), ['rest-1', 'rest-2'])
})

test('服务端标了过期的行，即使届满日等于面板日键，也不进今日届满', () => {
  const groups = groupUpcomingDeadlines([
    row({ id: 'skew', dueDate: '2026-10-03', overdue: true }),
    row({ id: 'real-today', dueDate: '2026-10-03', overdue: false }),
  ], '2026-10-03')
  assert.deepEqual(groups.overdue.map((item) => item.id), ['skew'])
  assert.deepEqual(groups.dueToday.map((item) => item.id), ['real-today'])
  assert.deepEqual(groups.rest, [])
  assert.equal(deadlineUrgencyCount(groups), 2)
})

test('日键对不上就不算今日届满（不另造一个今天）', () => {
  const groups = groupUpcomingDeadlines([
    row({ id: 'soon', dueDate: '2026-10-03', overdue: false }),
  ], '2026-10-01')
  assert.deepEqual(groups.dueToday, [])
  assert.deepEqual(groups.rest.map((item) => item.id), ['soon'])
  assert.equal(deadlineUrgencyCount(groups), 0)
})

test('空列表三组都空，紧迫计数为 0', () => {
  const groups = groupUpcomingDeadlines([], '2026-10-03')
  assert.deepEqual(groups, { overdue: [], dueToday: [], rest: [] })
  assert.equal(deadlineUrgencyCount(groups), 0)
})
