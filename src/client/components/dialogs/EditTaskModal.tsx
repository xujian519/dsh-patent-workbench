/**
 * 编辑任务（H4-8 第 3 批）—— 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **没有一处 `useState`**：整份草稿 `editDraft` 住容器，原因是写入口在容器 ——
 *   `beginEditTask` 摊草稿（时区口径只在那里做一次）、`saveEditDraft` 要从整份草稿拼
 *   payload 并做乐观更新。搬进来就会出现"弹窗一份、列表一份"的双写。
 * - **`EditTaskDraft` 的类型定义在这里、由容器 import**：草稿形状只有这一处定义，
 *   容器不许再抄一份（"同一语义两处实现"是本项目的头号 bug 类别）。
 * - **判定不在这里**：字典切片由容器切好传入；改父任务的候选（已排除自身与后代）
 *   由容器 `reparentCandidates` 算好；耗时越界校验在 `saveEditDraft` 里。
 * - **不发请求**：`onSave` 只是意图，真正发 PATCH 的是容器的 `saveEditDraft`。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import { WorkspacePicker } from '../WorkspacePicker.js'
import type { Dict } from '../../viewTypes.js'
import type { WorkspaceCandidate } from '../../workspacePicker.js'

/** 编辑草稿的字段形状（容器 `useState` 与 `beginEditTask` 都吃这一份）。 */
export interface EditTaskDraft {
  title: string
  description: string
  typeCode: string
  priorityCode: string
  statusCode: string
  aiPolicyCode: string
  dueLocal: string
  workspacePath: string
  parentId: string
  estimatedMinutes: string
  allDay: boolean
}

/** 改父任务的候选项：容器已排除自身与自身后代（选到必然被服务端 400 拒绝）。 */
export interface ReparentCandidate {
  id: string
  title: string
  depth: number
}

export interface EditTaskModalProps {
  draft: EditTaskDraft
  onChange: (next: EditTaskDraft) => void
  typeOptions: readonly Dict[]
  priorityOptions: readonly Dict[]
  statusOptions: readonly Dict[]
  aiPolicyOptions: readonly Dict[]
  /** 耗时留空时的默认分钟数，只用于占位与下方说明文案。 */
  defaultEstimateMinutes: number
  workspaceCandidates: readonly WorkspaceCandidate[]
  /** 未设置默认工作区时的占位提示。 */
  workspacePlaceholder: string
  parentCandidates: readonly ReparentCandidate[]
  busy: boolean
  onBrowse: () => void
  onClose: () => void
  onSave: () => void
}

export function EditTaskModal({
  draft, onChange, typeOptions, priorityOptions, statusOptions, aiPolicyOptions,
  defaultEstimateMinutes, workspaceCandidates, workspacePlaceholder, parentCandidates,
  busy, onBrowse, onClose, onSave,
}: EditTaskModalProps): JSX.Element {
  /** 改一个字段：整份草稿一起写回容器（一份 state，不在这里分叉）。 */
  const set = <K extends keyof EditTaskDraft>(field: K, value: EditTaskDraft[K]): void =>
    onChange({ ...draft, [field]: value })
  return (
    <Modal
      title={<><Icon name="edit" />编辑任务</>}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <button className="wb-btn" onClick={onClose}>取消</button>
          <button className="wb-btn primary" disabled={draft.title.trim() === ''} onClick={onSave}>
            <Icon name="check" />保存
          </button>
        </>
      )}
    >
      <div className="wb-form" style={{ border: 'none', padding: 0 }}>
        <label className="full">标题<input value={draft.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label>类型<select value={draft.typeCode} onChange={(e) => set('typeCode', e.target.value)}>{typeOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>优先级<select value={draft.priorityCode} onChange={(e) => set('priorityCode', e.target.value)}>{priorityOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>状态<select value={draft.statusCode} onChange={(e) => set('statusCode', e.target.value)}>{statusOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>AI 策略<select value={draft.aiPolicyCode} onChange={(e) => set('aiPolicyCode', e.target.value)}>{aiPolicyOptions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>截止时间<input type="datetime-local" value={draft.dueLocal} onChange={(e) => set('dueLocal', e.target.value)} /></label>
        {/* ---------------- 预计耗时 / 全天任务（v1.15.1） ---------------- */}
        <label>耗时（分钟）<input type="number" min={1} max={1440} step={5} value={draft.estimatedMinutes} placeholder={`留空 = 默认 ${defaultEstimateMinutes} 分钟`} onChange={(e) => set('estimatedMinutes', e.target.value)} /></label>
        <label style={{ alignSelf: 'end' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <input type="checkbox" checked={draft.allDay} onChange={(e) => set('allDay', e.target.checked)} />
            全天任务
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>只影响显示，不改变候选排序</span>
        </label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: '0 0 4px' }}>
          {`耗时参与当日候选排序；留空 = 按默认 ${defaultEstimateMinutes} 分钟计入。`}
        </p>
        <div className="full">
          <WorkspacePicker
            value={draft.workspacePath}
            touched={false}
            sourceLabel="留空 = 继承父任务，父任务也没有才用默认"
            candidates={workspaceCandidates}
            disabled={busy}
            placeholder={workspacePlaceholder}
            onChange={(path) => set('workspacePath', path)}
            onBrowse={onBrowse}
          />
        </div>
        <label className="full">描述（Markdown）<textarea rows={6} value={draft.description} onChange={(e) => set('description', e.target.value)} /></label>
        {/* ---------------- 改父任务（v1.14.0） ---------------- */}
        <label className="full">
          父任务
          <select
            value={draft.parentId}
            onChange={(e) => set('parentId', e.target.value)}
          >
            <option value="">（顶层）</option>
            {parentCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {'\u00a0'.repeat(candidate.depth * 2)}{candidate.title}
              </option>
            ))}
          </select>
        </label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: '0 0 4px' }}>
          移动子树：后代跟随一起移动。候选里不列出自身与自身后代（会形成环）；
          服务端另有独立防环校验，失败会给出中文原因。移动会写入任务详情的「记录」页签。
        </p>
      </div>
    </Modal>
  )
}
