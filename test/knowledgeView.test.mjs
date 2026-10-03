/**
 * 知识视图（H4-4）纯逻辑的单测：草稿 → 载荷的拼装。
 *
 * 为什么要有这一条：这段逻辑原先内联在详情表单的 `onSubmit` 里（`index.tsx` 需要宿主运行时，
 * 跑不起来 = 测不到），H4-4 把它搬进 `knowledgeView.ts` 之后**就能被直接断言**了。
 * 期望值全部手写，不从实现里"取"（否则测的是"实现没变"，不是"口径对"）。
 *
 * ⚠️ 这些规则都是有代价的：`''` 不当 null 传，服务端会把"没填"存成空字符串；
 * 标签不切分，用户写"TTS, 踩坑"会变成一个标签；不设上限，一个字段就能塞进上万标签。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgePayload } from '../lib/client/knowledgeView.js'

const draft = (over = {}) => ({
  title: '  某案的检索经验  ',
  contentMd: '正文里可以有,逗号和 #标签 字样',
  kindCode: 'lesson',
  tags: '',
  sourceTaskId: '',
  sourceReviewId: '',
  matterId: '',
  fileLink: '',
  ...over,
})

test('buildKnowledgePayload：标题 trim；正文**原样**（不 trim、不切标签）', () => {
  const payload = buildKnowledgePayload(draft())
  assert.equal(payload.title, '某案的检索经验')
  assert.equal(payload.contentMd, '正文里可以有,逗号和 #标签 字样', '正文是 Markdown 正文，不许被标签规则碰到')
})

test('buildKnowledgePayload：标签按逗号/井号/空白切分、去空、trim', () => {
  const payload = buildKnowledgePayload(draft({ tags: 'TTS, 踩坑，#检索  经验,, ' }))
  assert.deepEqual(payload.tags, ['TTS', '踩坑', '检索', '经验'])
})

test('buildKnowledgePayload：标签上限 20 个（超出的丢掉，不报错）', () => {
  const payload = buildKnowledgePayload(draft({ tags: Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ') }))
  assert.equal(payload.tags.length, 20)
  assert.deepEqual(payload.tags.slice(0, 3), ['t0', 't1', 't2'], '保留的是前 20 个（按用户书写顺序）')
})

test('buildKnowledgePayload：四个可空字段的空串归一成 null（不许把"没填"写成空串）', () => {
  const payload = buildKnowledgePayload(draft({ sourceTaskId: '  ', sourceReviewId: '', fileLink: '   ' }))
  assert.equal(payload.sourceTaskId, null)
  assert.equal(payload.sourceReviewId, null)
  assert.equal(payload.fileLink, null)
  assert.equal(payload.matterId, null, '案卷下拉的"（不归入）"就是空串')
})

test('buildKnowledgePayload：填了的值 trim 后原样带上（关联任务/复盘/案卷/文件链接）', () => {
  const payload = buildKnowledgePayload(draft({
    sourceTaskId: ' t1 ', sourceReviewId: 'rv1', matterId: 'm1', fileLink: ' file:///tmp/a.md ',
  }))
  assert.equal(payload.sourceTaskId, 't1')
  assert.equal(payload.sourceReviewId, 'rv1')
  assert.equal(payload.matterId, 'm1', '案卷 id 不做 trim 之外的归一（它是 select 的值）')
  assert.equal(payload.fileLink, 'file:///tmp/a.md')
})

test('buildKnowledgePayload：分类与"新建/编辑"无关 —— 载荷里没有 id，编辑走 URL', () => {
  // 防回归：曾经把 id 塞进 payload 里发给 POST，服务端把它当未知字段静默忽略
  const payload = buildKnowledgePayload(draft())
  assert.equal('id' in payload, false)
  assert.deepEqual(Object.keys(payload).sort(), ['contentMd', 'fileLink', 'kindCode', 'matterId', 'sourceReviewId', 'sourceTaskId', 'tags', 'title'])
})
