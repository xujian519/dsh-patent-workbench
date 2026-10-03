/**
 * 官文登记（阶段 5 · 5C 的前置）—— H4-8 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 业务边界（原注释一并搬过来，别丢）
 *
 * 官文是**期限的输入源** —— 没有官文就没有起算点。这里只登记事实
 * （发文日 / 送达 / 指定期限 / 文件），**不算期限** —— 算期限是引擎的职责（决策 3）。
 *
 * ## 代码边界（plan §3）
 *
 * - **传进来的**：整份草稿值、两个字典切片（`dictOf` 的判定留在容器）、busy。
 *   **没有一处 `useState`**：`noticeDraft` 住容器（`saveNotice` 要从整份草稿拼载荷）。
 * - **不发请求**：`onSubmit` 把表单事件原样交给容器的 `saveNotice`。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import type { Dict } from '../../viewTypes.js'

export interface NoticeDraftModalProps {
  draft: Record<string, string>
  onChange: (next: Record<string, string>) => void
  noticeKindOptions: readonly Dict[]
  deliveryModeOptions: readonly Dict[]
  busy: boolean
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}

export function NoticeDraftModal({
  draft, onChange, noticeKindOptions, deliveryModeOptions, busy, onClose, onSubmit,
}: NoticeDraftModalProps): JSX.Element {
  /** 改一个字段：整份草稿一起写回容器（一份 state，不在这里分叉）。 */
  const set = (field: string, value: string): void => onChange({ ...draft, [field]: value })
  return (
    <Modal
      title={<><Icon name="file" />登记官文</>}
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">只登记事实；期限由引擎按这些输入计算</span>
          <button className="wb-btn primary" type="submit" form="wb-notice-form" disabled={busy}><Icon name="check" />登记</button>
        </>
      )}
    >
      <form className="wb-form" id="wb-notice-form" onSubmit={onSubmit}>
        <label className="full">官文类型<select required value={draft.noticeKind} onChange={(e) => set('noticeKind', e.target.value)}>{noticeKindOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>发文日<input required type="date" value={draft.dispatchDate} onChange={(e) => set('dispatchDate', e.target.value)} /></label>
        <label>送达方式<select value={draft.deliveryMode} onChange={(e) => set('deliveryMode', e.target.value)}>{deliveryModeOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>送达日<input type="date" value={draft.deliveryDate} onChange={(e) => set('deliveryDate', e.target.value)} /></label>
        <label>指定期限（月）<input type="number" min={1} max={36} value={draft.designatedMonths} onChange={(e) => set('designatedMonths', e.target.value)} placeholder="留空 = 不指定" /></label>
        <label className="full">官文文件<input value={draft.fileLink} onChange={(e) => set('fileLink', e.target.value)} placeholder="file:// 或绝对路径（复用知识库同一套 file_link 机制）" /></label>
        <label className="full">备注<input value={draft.note} onChange={(e) => set('note', e.target.value)} /></label>
      </form>
    </Modal>
  )
}
