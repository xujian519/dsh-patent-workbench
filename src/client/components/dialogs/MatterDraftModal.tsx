/**
 * 建档 / 编辑案卷（阶段 5 · 5B）—— H4-8 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **传进来的**：标题文案（"新建 / 编辑"由容器的 `matterEditId` 判定）、整份草稿值、
 *   三个字典切片（`dictOf` 的判定留在容器）、busy。**没有一处 `useState`**：
 *   `matterDraft` 住容器（提交时 `saveMatter` 要从整份草稿拼载荷）。
 * - **留在这里的**：只有"怎么画这一块"和"改哪个字段"。
 * - **不发请求**：`onSubmit` 把表单事件原样交给容器的 `saveMatter`。
 *
 * ## 字段顺序是有理由的，别按字母重排
 *
 * 按「引擎要什么」排在前面：申请日 / 优先权日 / 要求优先权 / 专利类型 是
 * `patent-deadline` 起算期限的输入（决策 3），填错会算出错的期限 ——
 * 所以它们与案号同级显眼，而不是埋在最后。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import type { Dict } from '../../viewTypes.js'

export interface MatterDraftModalProps {
  /** 标题文案：由容器按 `matterEditId` 决定「新建案卷」还是「编辑案卷」。 */
  title: string
  draft: Record<string, string>
  onChange: (next: Record<string, string>) => void
  matterTypeOptions: readonly Dict[]
  patentKindOptions: readonly Dict[]
  stageOptions: readonly Dict[]
  busy: boolean
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}

export function MatterDraftModal({
  title, draft, onChange, matterTypeOptions, patentKindOptions, stageOptions, busy, onClose, onSubmit,
}: MatterDraftModalProps): JSX.Element {
  /** 改一个字段：整份草稿一起写回容器（一份 state，不在这里分叉）。 */
  const set = (field: string, value: string): void => onChange({ ...draft, [field]: value })
  return (
    <Modal
      title={<><Icon name="folder" />{title}</>}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">案号与名称必填；其余可留空（留空 = 库里为 NULL，不是空串）</span>
          <button className="wb-btn primary" type="submit" form="wb-matter-form" disabled={busy}><Icon name="check" />保存</button>
        </>
      )}
    >
      <form className="wb-form" id="wb-matter-form" onSubmit={onSubmit}>
        <label className="full">案号<input required value={draft.caseNumber} onChange={(e) => set('caseNumber', e.target.value)} placeholder="内部案号，如 2026-UM-002" /></label>
        <label className="full">发明名称<input required value={draft.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label>案型<select value={draft.matterType} onChange={(e) => set('matterType', e.target.value)}>{matterTypeOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>专利类型<select value={draft.patentKind} onChange={(e) => set('patentKind', e.target.value)}><option value="">（未定）</option>{patentKindOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>阶段<select value={draft.stageCode} onChange={(e) => set('stageCode', e.target.value)}>{stageOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>客户<input value={draft.clientId} onChange={(e) => set('clientId', e.target.value)} /></label>
        <label>申请号<input value={draft.applicationNo} onChange={(e) => set('applicationNo', e.target.value)} /></label>
        <label>公开号<input value={draft.publicationNo} onChange={(e) => set('publicationNo', e.target.value)} /></label>
        <label>授权号<input value={draft.patentNo} onChange={(e) => set('patentNo', e.target.value)} /></label>
        <label>申请日<input type="date" value={draft.filingDate} onChange={(e) => set('filingDate', e.target.value)} /></label>
        <label>优先权日<input type="date" value={draft.priorityDate} onChange={(e) => set('priorityDate', e.target.value)} /></label>
        <label className="wb-inline-check"><input type="checkbox" checked={draft.claimsPriority === '1'} onChange={(e) => set('claimsPriority', e.target.checked ? '1' : '0')} />要求优先权</label>
        <label className="wb-inline-check"><input type="checkbox" checked={draft.isPctNationalPhase === '1'} onChange={(e) => set('isPctNationalPhase', e.target.checked ? '1' : '0')} />PCT 进入中国</label>
        <label>技术领域<input value={draft.techField} onChange={(e) => set('techField', e.target.value)} /></label>
        <label>IPC<input value={draft.ipc} onChange={(e) => set('ipc', e.target.value)} /></label>
        <label>发明人<input value={draft.inventors} onChange={(e) => set('inventors', e.target.value)} placeholder="多人用逗号分隔" /></label>
        <label>申请人<input value={draft.applicant} onChange={(e) => set('applicant', e.target.value)} /></label>
        <label>代理师<input value={draft.attorney} onChange={(e) => set('attorney', e.target.value)} /></label>
        <label className="full">案卷目录<input value={draft.workspacePath} onChange={(e) => set('workspacePath', e.target.value)} placeholder="该案卷的工作目录（会话在此目录下时会优先召回本卷知识）" /></label>
      </form>
    </Modal>
  )
}
