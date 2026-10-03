/**
 * 新建任务（H4-8 第 3 批）—— 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **表单是非受控的**（提交时读 `FormData`），所以这里**没有一处 `useState`**。
 *   唯一受控的字段是工作区：它要能被「浏览…」写回，所以值住容器
 *   （`formWorkspace` / `openDirPicker('form')` → `applyWorkspaceDir` 写回），
 *   这里只把它同步进一个 hidden 输入供 `FormData` 读取。
 *   隐藏输入的字段名 `workspacePath` **就是提交接口的一部分**，改名等于改接口。
 * - **判定不在这里**：三个字典切片由容器 `dictOf(...)` 切好传入；耗时留空的 `null` 语义、
 *   越界夹取都在容器的 `createTask` 里。
 * - **不发请求**：`onSubmit` 把表单事件原样交给容器的 `createTask`。
 *
 * ## 与编辑任务弹窗是同一套字段与文案
 *
 * 「耗时（分钟）」的提示文案、`min/max/step` 与「全天任务」的说明两处必须一致 ——
 * 同一字段两个入口两套说法迟早打架。改这里请对照 `EditTaskModal.tsx`。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import { WorkspacePicker } from '../WorkspacePicker.js'
import type { Dict } from '../../viewTypes.js'
import type { WorkspaceCandidate } from '../../workspacePicker.js'

export interface NewTaskModalProps {
  typeOptions: readonly Dict[]
  priorityOptions: readonly Dict[]
  statusOptions: readonly Dict[]
  /** 耗时留空时的默认分钟数，只用于占位文案（口径在共享常量里）。 */
  defaultEstimateMinutes: number
  workspace: string
  onWorkspaceChange: (path: string) => void
  workspaceCandidates: readonly WorkspaceCandidate[]
  /** 未设置默认工作区时的占位提示。 */
  workspacePlaceholder: string
  busy: boolean
  onBrowse: () => void
  onClose: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}

export function NewTaskModal({
  typeOptions, priorityOptions, statusOptions, defaultEstimateMinutes,
  workspace, onWorkspaceChange, workspaceCandidates, workspacePlaceholder,
  busy, onBrowse, onClose, onSubmit,
}: NewTaskModalProps): JSX.Element {
  return (
    <Modal
      title={<><Icon name="plus" />新建任务</>}
      size="md"
      onClose={onClose}
    >
      <form className="wb-form" id="wb-new-task-form" onSubmit={onSubmit}>
        <label className="full">标题<input name="title" required placeholder="要做什么？" /></label>
        <label>类型<select name="type" defaultValue="client_meeting">{typeOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>优先级<select name="priority" defaultValue="p2">{priorityOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>状态<select name="status" defaultValue="todo">{statusOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>截止时间<input name="due" type="datetime-local" /></label>
        {/* 与编辑弹窗同一套字段与文案：同一字段两个入口两套说法 = 迟早打架 */}
        <label>耗时（分钟）<input name="estimatedMinutes" type="number" min={1} max={1440} step={5} placeholder={`留空 = 默认 ${defaultEstimateMinutes} 分钟`} /></label>
        <label style={{ alignSelf: 'end' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <input name="allDay" type="checkbox" />
            全天任务
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>只影响显示，不改变候选排序</span>
        </label>
        {/**
          * 批次2 #2：与快速录入、编辑任务**同一个组件**（两种选法：已有工作区下拉 + 浏览文件夹）。
          * 表单本身是非受控的（提交时读 FormData），所以这里用一个 hidden 输入承接值 ——
          * 受控的可见输入没法直接进 FormData 的可读列表之外的地方，用 hidden 更直白。
          */}
        <div className="full">
          <WorkspacePicker
            value={workspace}
            touched={false}
            sourceLabel="留空 = 用默认工作区"
            candidates={workspaceCandidates}
            disabled={busy}
            placeholder={workspacePlaceholder}
            onChange={onWorkspaceChange}
            onBrowse={onBrowse}
          />
          <input type="hidden" name="workspacePath" value={workspace} />
        </div>
        <label className="full">描述<textarea name="description" rows={2} placeholder="背景 / 目标 / 验收标准（Markdown）" /></label>
        <div className="full" style={{ display: 'flex', gap: 8 }}>
          <button className="wb-btn primary lg" type="submit"><Icon name="check" />保存任务</button>
          <button className="wb-btn" type="button" onClick={onClose}>取消</button>
        </div>
      </form>
    </Modal>
  )
}
