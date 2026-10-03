/**
 * 「库里已有同名任务」选择框（2026-09-13 重复建单事故的界面侧收口）—— H4-8 搬出来的纯画法。
 *
 * ## 业务边界（原注释一并搬过来，别丢）
 *
 * 服务端**只告警、不静默合并**：同名任务可能是正当需求（例如每周例会），
 * 所以这里必须由用户明确选一次 —— 要么保留两条，要么把这次的产出收口到已有那条上。
 *
 * ## 代码边界（plan §3）
 *
 * - **传进来的**：四个判据（已有标题 / 已有 id / 描述是否逐字相同 / 工作区是否相同）。
 *   **没有一处 `useState`** —— `duplicatePrompt` 住容器（`reuseExistingTask` 要用它整份对象）。
 * - **不发请求**：两个按钮只发 `onClose` / `onReuseExisting` 意图。
 */
import { Modal } from '../Modal.js'

export interface DuplicatePromptModalProps {
  existingTitle: string
  existingTaskId: string
  sameDescription: boolean
  sameWorkspace: boolean
  onClose: () => void
  onReuseExisting: () => void
}

export function DuplicatePromptModal({
  existingTitle, existingTaskId, sameDescription, sameWorkspace, onClose, onReuseExisting,
}: DuplicatePromptModalProps): JSX.Element {
  return (
    <Modal
      title={<>⚠️ 库里已经有一条同名任务</>}
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <button className="wb-btn" onClick={onClose}>保留两条，我自己处理</button>
          <button className="wb-btn primary" onClick={onReuseExisting}>
            就用已有那条（归档本次新建的那条）
          </button>
        </>
      )}
    >
      <div style={{ fontSize: 13, lineHeight: 1.8 }}>
        <div style={{ marginBottom: 6 }}>标题：<b>{existingTitle}</b></div>
        <div style={{ marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' }}>
          本次草稿确认后，库里现在有两条同名任务。已有那条 id：{existingTaskId.slice(0, 8)}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>
          {sameDescription
            ? '两条的**描述逐字相同** —— 很可能是同一件事被提交了两次（例如执行会话又交了一份草稿）。'
            : '两条的描述**不同** —— 可能是两次独立录入，也可能是执行会话重复提交，请自行判断。'}
          {sameWorkspace ? ' 工作区相同。' : ' 工作区不同。'}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          「就用已有那条」会把这条草稿收口到已有任务上，并归档本次新建的那条
          （可在任务列表页「查看归档」恢复，不会丢数据）。
        </div>
      </div>
    </Modal>
  )
}
