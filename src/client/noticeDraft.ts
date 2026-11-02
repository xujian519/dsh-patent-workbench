/**
 * 官文登记草稿的**纯逻辑**（无 React、无 DOM、无请求）。
 *
 * 为什么单独成文件：表单草稿的初值与提交载荷是"会改变期限起点"的判定，
 * 必须能被 `node --test` 直接锁住；写在 `index.tsx` 里就只能靠人眼看。
 *
 * 宪法约束（破例 EX-2026-001 的偿还）：
 * - **不预选送达方式**。它决定送达日；预选等于替当事人造一条事实（第 3 条、第 11 条之一）；
 * - **缺送达方式不发请求**，并给出可操作的中文原因，不静默按电子送达提交（第 13 条之二）。
 */
import type { Dict } from './viewTypes.js'

/** 表单里的官文草稿：全部是字符串（原生控件的值），提交时才收敛类型。 */
export type NoticeDraft = {
  noticeKind: string
  dispatchDate: string
  deliveryMode: string
  deliveryDate: string
  designatedMonths: string
  fileLink: string
  note: string
}

/** 打开登记表单时的初值。`deliveryMode` 恒为空串 —— 这是刻意的，不是漏填。 */
export function initialNoticeDraft(input: {
  noticeKindOptions: readonly Dict[]
  dispatchDate: string
}): NoticeDraft {
  return {
    noticeKind: input.noticeKindOptions[0]?.code ?? '',
    dispatchDate: input.dispatchDate,
    deliveryMode: '',
    deliveryDate: '',
    designatedMonths: '',
    fileLink: '',
    note: '',
  }
}

/** 提交给 `POST /matters/:id/notices` 的载荷。 */
export interface NoticePayload {
  noticeKind: string
  dispatchDate: string
  deliveryMode: string
  deliveryDate: string | null
  designatedMonths: number | null
  fileLink: string | null
  note: string | null
}

export type NoticePayloadResult =
  | { ok: true; value: NoticePayload }
  | { ok: false; error: string }

/** 草稿 → 载荷；缺送达方式时给出**不改写草稿**的失败结果。 */
export function buildNoticePayload(draft: Record<string, string>): NoticePayloadResult {
  const field = (key: string): string => draft[key] ?? ''
  const deliveryMode = field('deliveryMode').trim()
  if (deliveryMode === '') {
    return {
      ok: false,
      error: '请选择送达方式：它决定送达日，缺了期限无法起算（系统不会默认按电子送达）',
    }
  }
  const months = Number(field('designatedMonths').trim())
  const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  return {
    ok: true,
    value: {
      noticeKind: field('noticeKind'),
      dispatchDate: field('dispatchDate').trim(),
      deliveryMode,
      deliveryDate: text(field('deliveryDate')),
      designatedMonths: Number.isInteger(months) && months > 0 ? months : null,
      fileLink: text(field('fileLink')),
      note: text(field('note')),
    },
  }
}
