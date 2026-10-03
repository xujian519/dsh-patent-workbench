/**
 * 回归：行内 JSON 列损坏时，**读路径不许整批失败**。
 *
 * 真实场景：手改库、半截写入或旧格式残留让 `tasks.extra` / `task_drafts.payload_json`
 * 不是合法 JSON。改动前各 repo 裸 `JSON.parse`，一条脏行就让 `GET /tasks`、`GET /drafts`
 * 整个 500，而且报错里看不出是哪一行 —— 单条脏行殃及整批。
 *
 * 修法：所有读路径经 `safeJsonParse`（`db/repo/shared.ts`），坏值降级为 `fallback`，
 * 行本身照常返回。**迁移里不使用**（迁移遇坏值应当响亮失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { safeJsonParse } from '../lib/db/repo/shared.js'
import { createTask, createDraft, getDraft, listTasks } from '../lib/db/repo.js'

test('safeJsonParse：合法值取原值，空/坏值取回退，且从不抛错', () => {
  assert.deepEqual(safeJsonParse('{"a":1}', {}), { a: 1 })
  assert.deepEqual(safeJsonParse('[]', {}), [])
  assert.deepEqual(safeJsonParse('"ok"', 'F'), 'ok')
  assert.deepEqual(safeJsonParse('', { fallback: true }), { fallback: true })
  assert.deepEqual(safeJsonParse(null, { fallback: true }), { fallback: true })
  assert.deepEqual(safeJsonParse(undefined, 'F'), 'F')
  assert.deepEqual(safeJsonParse('{ 这不是 JSON', 'F'), 'F', '坏 JSON 必须回退而不是抛错')
})

test('safeJsonParse：一条脏 extra 不再让 listTasks 整批失败', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const good = createTask(db, { title: 'good', typeCode: 'code_impl', priorityCode: 'p1' })
  const bad = createTask(db, { title: 'bad', typeCode: 'code_impl', priorityCode: 'p1' })
  db.prepare('UPDATE tasks SET extra = ? WHERE id = ?').run('{ 这不是 JSON', bad.id)

  const tasks = listTasks(db) // 改动前这里会抛，整批拿不到
  const byId = new Map(tasks.map((task) => [task.id, task]))
  assert.equal(byId.size, 2, '两条任务都要返回，脏行不许被丢掉')
  assert.deepEqual(byId.get(bad.id).extra, {}, '坏 extra 降级为空对象')
  assert.deepEqual(byId.get(good.id).extra, {}, '同批的干净行不受牵连')
  db.close()
})

test('safeJsonParse：坏 payload_json 不再让 getDraft 抛错', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const draft = createDraft(db, {
    kindCode: 'task',
    sessionId: 's-bad-json',
    payload: { title: 't', typeCode: 'code_impl', priorityCode: 'p2' },
  })
  db.prepare('UPDATE task_drafts SET payload_json = ? WHERE id = ?').run('}{', draft.id)

  const loaded = getDraft(db, draft.id)
  assert.notEqual(loaded, undefined, '草稿行本身仍然可见')
  assert.deepEqual(loaded.payload, {}, '坏 payload 降级为空对象')
  db.close()
})
