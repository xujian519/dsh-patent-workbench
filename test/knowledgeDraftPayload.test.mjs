/**
 * 知识草稿 payload 字段名归一化回归（v1.16.4，用户实测缺陷）。
 *
 * ## 真实缺陷（2026-10-03）
 *
 * 用户在界面上点「确认入库」，拿到的是 `操作失败：knowledge requires content`。
 * 库里那条 pending 知识草稿有 **1668 字正文**，但它写在 `content_md` 下
 * （模型照着 `workbench_submit_knowledge` 的**工具参数名**填的），而入库侧只认 `contentMd`：
 *
 * - 路由 201「草稿已建」→ 死草稿静静躺在「待处理」里；
 * - 弹窗正文**空白**（读 `payload.contentMd`）；
 * - 确认入库 400，一句英文：不说缺什么、不说合法键名、也不说 payload 里其实有正文。
 *
 * ## 本文件守四件事
 *
 * 1. **别名表**（`normalizeKnowledgeDraftPayload`）：snake_case 工具参数名一律归到规范键名，
 *    且**回报**用了哪些别名（静默改写字段是本仓禁止的）；
 * 2. **准入措辞**（`knowledgeDraftRejection`）：缺标题/缺正文给中文原因，并列出本次 payload
 *    的实际键 —— 建草稿（HTTP 400）与确认入库共用这一份；
 * 3. **写侧不丢件**（`canonicalizeKnowledgeDraftPayload`）：只换字段名，历史键与未知键原样保留；
 * 4. **接线（源码级）**：确认入库、建草稿路由、草稿弹窗三处都必须走这一个实现，
 *    且文案里写出来的字段名必须与别名表一致（文案漂了就红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  KNOWLEDGE_DRAFT_CANONICAL_KEYS,
  KNOWLEDGE_DRAFT_FIELD_ALIASES,
  canonicalizeKnowledgeDraftPayload,
  knowledgeDraftRejection,
  knowledgeDraftUnknownKeys,
  normalizeKnowledgeDraftPayload,
} from '../lib/shared/knowledgeDraftPayload.js'
import { KNOWLEDGE_DRAFT_PAYLOAD_FIELDS_DOC, KNOWLEDGE_DRAFT_SESSION_CONSTRAINT } from '../lib/shared/knowledgeDraftOverwrite.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('别名表：工具参数名（snake_case）逐条归到规范键名，并回报用到的别名', () => {
  const { payload, usedAliases } = normalizeKnowledgeDraftPayload({
    title: '标题',
    content_md: '正文',
    kind_code: 'decision',
    tags: ['a'],
    source_task_id: 'task-1',
    source_review_id: 'review-1',
    file_link: '/tmp/a.md',
    matter_id: 'matter-1',
  })
  assert.deepEqual(payload, {
    title: '标题',
    contentMd: '正文',
    kindCode: 'decision',
    tags: ['a'],
    sourceTaskId: 'task-1',
    sourceReviewId: 'review-1',
    matterId: 'matter-1',
    fileLink: '/tmp/a.md',
  })
  assert.deepEqual(usedAliases, ['content_md', 'kind_code', 'source_task_id', 'source_review_id', 'matter_id', 'file_link'])
})

test('别名表：规范键优先，两套写法并存时照样上报别名（不静默吞掉一处）', () => {
  const { payload, usedAliases } = normalizeKnowledgeDraftPayload({ title: 'T', contentMd: '规范正文', content_md: '另一份正文' })
  assert.equal(payload.contentMd, '规范正文')
  assert.deepEqual(usedAliases, ['content_md'])
  // 规范键为空串（等于没写）时回落到别名：模型很容易写出 contentMd: ''
  assert.equal(normalizeKnowledgeDraftPayload({ title: 'T', contentMd: '', content_md: '别名正文' }).payload.contentMd, '别名正文')
})

test('归一化：非法类型取安全默认，不在这里判必填（判必填是 knowledgeDraftRejection 的事）', () => {
  const { payload } = normalizeKnowledgeDraftPayload({ title: 42, contentMd: null, tags: 'not-an-array', kindCode: '' })
  assert.equal(payload.title, '')
  assert.equal(payload.contentMd, '')
  assert.deepEqual(payload.tags, [])
  // 没给 kindCode 照旧按 note（与 confirmKnowledgeDraft 原口径一致）
  assert.equal(payload.kindCode, 'note')
  assert.deepEqual(normalizeKnowledgeDraftPayload(undefined).payload.tags, [])
})

test('准入措辞：缺正文/缺标题给中文原因，并列出本次 payload 的实际键', () => {
  assert.equal(knowledgeDraftRejection({ title: 'T', contentMd: '正文' }), null)
  assert.equal(knowledgeDraftRejection({ title: 'T', content_md: '正文' }), null)

  const noContent = knowledgeDraftRejection({ title: 'T', content: '想当然的键名' })
  assert.match(noContent, /缺少正文/)
  assert.match(noContent, /contentMd/)
  assert.match(noContent, /content_md/)
  assert.match(noContent, /本次 payload 的键：title、content/)

  const noTitle = knowledgeDraftRejection({ contentMd: '有正文' })
  assert.match(noTitle, /缺少标题/)
  assert.match(noTitle, /本次 payload 的键：contentMd/)

  const empty = knowledgeDraftRejection({})
  assert.match(empty, /缺少标题/)
  assert.match(empty, /（空）/)
})

test('写侧：只换字段名，历史键与未知键原样保留（不静默丢件）', () => {
  const { payload, usedAliases } = canonicalizeKnowledgeDraftPayload({
    title: 'T',
    content_md: '正文',
    revision: 3,
    replacedTitles: ['旧的'],
    supersededById: 'k-1',
    validUntil: '2027-01-01T00:00:00.000Z',
    未来字段: '原样保留',
  })
  assert.deepEqual(usedAliases, ['content_md'])
  assert.equal(payload.contentMd, '正文')
  assert.equal(payload.content_md, undefined)
  assert.equal(payload.revision, 3)
  assert.deepEqual(payload.replacedTitles, ['旧的'])
  assert.equal(payload.supersededById, 'k-1')
  assert.equal(payload.validUntil, '2027-01-01T00:00:00.000Z')
  assert.equal(payload.未来字段, '原样保留')
  // matterId 只在该写的时候写：没提过就不凭空塞一个 null（"未归入" ≠ "没提过"）
  assert.equal('matterId' in canonicalizeKnowledgeDraftPayload({ title: 'T', contentMd: 'x' }).payload, false)
  assert.equal('matterId' in canonicalizeKnowledgeDraftPayload({ title: 'T', contentMd: 'x', matter_id: null }).payload, true)
})

test('未知键：只把"不认识也不是历史字段"的键报出来（用于提示，不用于拒收）', () => {
  assert.deepEqual(knowledgeDraftUnknownKeys({ title: 'T', contentMd: 'x', content_md: 'y', revision: 2, 未来字段: 1 }), ['未来字段'])
})

test('文案与别名表同口径：字段名说明必须覆盖每个规范键与每个别名（文案漂了就红）', () => {
  for (const key of KNOWLEDGE_DRAFT_CANONICAL_KEYS) {
    assert.ok(KNOWLEDGE_DRAFT_PAYLOAD_FIELDS_DOC.includes(key), `字段名说明里少了规范键 ${key}`)
  }
  for (const alias of Object.keys(KNOWLEDGE_DRAFT_FIELD_ALIASES)) {
    assert.ok(KNOWLEDGE_DRAFT_PAYLOAD_FIELDS_DOC.includes(alias), `字段名说明里少了别名 ${alias}`)
  }
  // 绕行建议必须带上字段名说明（否则调用方又会照着工具参数名猜）
  assert.ok(KNOWLEDGE_DRAFT_SESSION_CONSTRAINT.includes(KNOWLEDGE_DRAFT_PAYLOAD_FIELDS_DOC))
})

test('接线：确认入库 / 建草稿路由 / 草稿弹窗三处都走这一个实现，且不再直读 payload.contentMd', () => {
  const knowledgeRepo = readFileSync(join(root, 'src/db/repo/knowledge.ts'), 'utf8')
  assert.match(knowledgeRepo, /knowledgeDraftRejection\(draft\.payload\)/, '确认入库必须先过统一准入判定')
  assert.match(knowledgeRepo, /normalizeKnowledgeDraftPayload\(draft\.payload\)/, '确认入库必须走统一归一化')
  assert.ok(!knowledgeRepo.includes('knowledge requires content'), '旧的英文报错不得回来')

  const draftsRoute = readFileSync(join(root, 'src/api/routes/drafts.ts'), 'utf8')
  assert.match(draftsRoute, /canonicalizeKnowledgeDraftPayload\(payload\)/, '建草稿路由必须把别名收成规范键名')
  assert.match(draftsRoute, /knowledgeDraftRejection\(payload\)/, '建草稿路由必须挡掉缺字段的死草稿')

  const body = readFileSync(join(root, 'src/client/components/KnowledgeDraftBody.tsx'), 'utf8')
  assert.match(body, /normalizeKnowledgeDraftPayload\(payload\)/, '弹窗必须走统一归一化')
  // 只在**代码**里断言：注释里出现 `payload.contentMd`（解释旧写法）是允许的。
  const bodyCode = body.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
  assert.ok(!/payload\.contentMd/.test(bodyCode), '弹窗不得直读 payload.contentMd（那种草稿的正文会显示成空）')
})
