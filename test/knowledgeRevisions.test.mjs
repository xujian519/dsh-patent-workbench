/**
 * 知识条目前像表（调研 §7 第一步③，`docs/research/2026-10-07-灵枢dsh-memory调研.md`）。
 *
 * ## 为什么需要这道契约
 *
 * `updateKnowledge` 是**纯覆写**（`UPDATE ... SET content_md = ?`）：改之前那一版正文
 * 在库里就**永远没有了**。知识条目是攒下来的资产，一次误改、一次 AI 自动归并写错
 * 就是不可逆的损失。灵枢把"改前留一份、可回滚"当基础设施做，本仓从前像表补上。
 *
 * ## 本测试锁的口径
 *
 * 1. **前像存的是"改之前"那一版**，不是改之后（存错了整张表就毫无意义）。
 * 2. **前像与覆写同生共死** —— 条目改了却没有前像，或反之，都不允许。
 * 3. **还原本身也可还原** —— "退回去"这个动作会把"退之前"那一版也存成前像，
 *    所以退错了还能再退回来，不是单向门。
 * 4. **删除也留像，且能用原 id 复活** —— 复活必须沿用原 id，
 *    否则指向它的引用（`superseded_by_id`）会全部断掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkbenchDb } from '../lib/db/database.js'
import {
  createKnowledge, getKnowledge, updateKnowledge, deleteKnowledgeWithRefs,
  listKnowledgeRevisions, restoreKnowledgeRevision,
} from '../lib/db/repo.js'

function freshDb() {
  // 生产路径由 apply() 播种字典；知识域不依赖字典，这里不用播。
  return openWorkbenchDb({ dbPath: ':memory:' })
}

/** 直接数前像行，不走 listKnowledgeRevisions —— 断言"库里真的有几行"。 */
function revisionCount(db, entryId) {
  return db.prepare('SELECT COUNT(*) AS n FROM knowledge_entry_revisions WHERE entry_id = ?').get(entryId).n
}

test('改知识条目：前像存的是改之前那一版', async () => {
  const db = freshDb()
  try {
    const entry = createKnowledge(db, { title: '三步法', contentMd: '第一版：整体考虑。' })
    updateKnowledge(db, entry.id, { contentMd: '第二版：三步法细化。' })

    const revisions = listKnowledgeRevisions(db, entry.id)
    assert.equal(revisions.length, 1)
    assert.equal(revisions[0].entryId, entry.id)
    assert.equal(revisions[0].revisionNo, 1)
    assert.equal(revisions[0].contentMd, '第一版：整体考虑。', '前像必须是"被覆盖掉的那一版"，不是当前版')
    assert.equal(getKnowledge(db, entry.id).contentMd, '第二版：三步法细化。')
    assert.match(revisions[0].archivedAt, /^\d{4}-\d{2}-\d{2}T/, '要有"这一版是什么时候被换掉的"')
  } finally {
    db.close()
  }
})

test('连改两次：版本号递增，列表从新到旧', async () => {
  const db = freshDb()
  try {
    const entry = createKnowledge(db, { title: '版本', contentMd: 'v1' })
    updateKnowledge(db, entry.id, { contentMd: 'v2' })
    updateKnowledge(db, entry.id, { contentMd: 'v3' })

    const revisions = listKnowledgeRevisions(db, entry.id)
    assert.equal(revisions.length, 2)
    assert.deepEqual(revisions.map((r) => r.revisionNo), [2, 1], '最近的在前')
    assert.deepEqual(revisions.map((r) => r.contentMd), ['v2', 'v1'])
    assert.equal(revisionCount(db, entry.id), 2)
  } finally {
    db.close()
  }
})

test('还原：条目退回那一版，且"退之前"也被存成前像（可再退回来）', async () => {
  const db = freshDb()
  try {
    const entry = createKnowledge(db, { title: '还原', contentMd: 'v1' })
    updateKnowledge(db, entry.id, { contentMd: 'v2' })
    updateKnowledge(db, entry.id, { contentMd: 'v3' })

    const v1 = listKnowledgeRevisions(db, entry.id).find((r) => r.revisionNo === 1)
    const restored = restoreKnowledgeRevision(db, v1.id)
    assert.equal(restored.contentMd, 'v1', '退回到第一版')

    // 还原不是单向门：v3 也被存下来了，还能退回去。
    assert.equal(revisionCount(db, entry.id), 3, '还原本身也要留一份前像')
    const v3 = listKnowledgeRevisions(db, entry.id).find((r) => r.revisionNo === 3)
    assert.equal(v3.contentMd, 'v3', '被退掉的那一版没丢')
    assert.equal(restoreKnowledgeRevision(db, v3.id).contentMd, 'v3', '能再退回来')
  } finally {
    db.close()
  }
})

test('还原会带回标题与标签，不只是一段正文', async () => {
  const db = freshDb()
  try {
    const entry = createKnowledge(db, { title: '原标题', contentMd: '正文', tags: ['A', 'B'] })
    updateKnowledge(db, entry.id, { title: '改过的标题', tags: ['C'] })

    const revision = listKnowledgeRevisions(db, entry.id)[0]
    const restored = restoreKnowledgeRevision(db, revision.id)
    assert.equal(restored.title, '原标题')
    assert.deepEqual(restored.tags, ['A', 'B'], '标签列也要跟着回去，否则"还原"是半截的')
  } finally {
    db.close()
  }
})

test('改不存在的条目：返回 undefined，且不凭空造前像', async () => {
  const db = freshDb()
  try {
    const result = updateKnowledge(db, 'does-not-exist', { contentMd: 'x' })
    assert.equal(result, undefined)
    const total = db.prepare('SELECT COUNT(*) AS n FROM knowledge_entry_revisions').get().n
    assert.equal(total, 0, '没有条目就没有"改前"可言，不该留下孤儿前像')
  } finally {
    db.close()
  }
})

test('删除：留前像，且能用原 id 复活', async () => {
  const db = freshDb()
  try {
    const entry = createKnowledge(db, { title: '要删的', contentMd: '正文内容', tags: ['x'] })
    const result = deleteKnowledgeWithRefs(db, entry.id)
    assert.equal(result.deleted, true)
    assert.equal(revisionCount(db, entry.id), 1, '删除前必须留一份 —— 这是唯一会让正文彻底消失的操作')

    const revision = listKnowledgeRevisions(db, entry.id)[0]
    const revived = restoreKnowledgeRevision(db, revision.id)
    assert.equal(revived.id, entry.id, '必须用原 id 复活，否则指向它的引用全断')
    assert.equal(revived.title, '要删的')
    assert.equal(revived.contentMd, '正文内容')
    assert.deepEqual(revived.tags, ['x'])
    assert.equal(getKnowledge(db, entry.id).contentMd, '正文内容')
  } finally {
    db.close()
  }
})

test('删一条被取代的条目：被连带恢复的邻居不产生前像', async () => {
  const db = freshDb()
  try {
    const fix = createKnowledge(db, { title: '修正条', contentMd: '修正后的内容' })
    const old = createKnowledge(db, { title: '旧条', contentMd: '旧内容', supersededById: fix.id })

    const result = deleteKnowledgeWithRefs(db, fix.id)
    assert.equal(result.deleted, true)
    assert.equal(result.clearedRefs, 1, '旧条随之解除压制')
    assert.equal(getKnowledge(db, old.id).supersededById, null)

    assert.equal(revisionCount(db, fix.id), 1, '被删的那条留像')
    assert.equal(revisionCount(db, old.id), 0, '邻居只是引用列被清空、正文没动，不该塞一份重复前像')
  } finally {
    db.close()
  }
})

test('前像不存在时还原返回 undefined', async () => {
  const db = freshDb()
  try {
    assert.equal(restoreKnowledgeRevision(db, 'no-such-revision'), undefined)
  } finally {
    db.close()
  }
})
