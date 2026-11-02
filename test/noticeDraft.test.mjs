/**
 * 官文登记草稿的纯逻辑：送达方式不得被预选，也不得被静默补上。
 *
 * 对应宪法第 3 条 / 第 11 条之一 / 第 13 条之二（破例 EX-2026-001 的偿还）。
 * 这条策略长在 `index.tsx` 里时只能靠人眼看；搬进纯模块后由这里锁住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNoticePayload, initialNoticeDraft } from '../lib/client/noticeDraft.js'

test('initialNoticeDraft：即使有字典也不预选送达方式', () => {
  const draft = initialNoticeDraft({ noticeKindOptions: [{ kind: 'notice_kind', code: 'oa', name: '审查意见' }], dispatchDate: '2026-10-20' })
  assert.equal(draft.noticeKind, 'oa')
  assert.equal(draft.dispatchDate, '2026-10-20')
  assert.equal(draft.deliveryMode, '', '送达方式必须留空，等用户按官文实际方式选择')
})

test('buildNoticePayload：缺送达方式（含纯空白）→ 拒绝，并给出可操作原因', () => {
  for (const deliveryMode of ['', '   ']) {
    const built = buildNoticePayload({ noticeKind: 'oa', dispatchDate: '2026-10-20', deliveryMode, designatedMonths: '4' })
    assert.equal(built.ok, false)
    assert.match(built.error, /请选择送达方式/)
  }
})

test('buildNoticePayload：有送达方式才收敛类型；空字段保持 null，不写空串', () => {
  const built = buildNoticePayload({
    noticeKind: 'oa',
    dispatchDate: ' 2026-10-20 ',
    deliveryMode: 'postal',
    deliveryDate: '',
    designatedMonths: '4',
    fileLink: ' file:///tmp/a.pdf ',
    note: '',
  })
  assert.equal(built.ok, true)
  assert.deepEqual(built.value, {
    noticeKind: 'oa',
    dispatchDate: '2026-10-20',
    deliveryMode: 'postal',
    deliveryDate: null,
    designatedMonths: 4,
    fileLink: 'file:///tmp/a.pdf',
    note: null,
  })
})
