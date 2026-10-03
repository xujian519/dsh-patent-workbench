/**
 * 到期提醒弹窗 —— H4-8 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **传进来的**：要显示的提醒列表（容器传它用得到的三个字段即可）。
 *   **没有一处 `useState`** —— `reminders` / `reminderModalOpen`
 *   住容器（轮询与调度器都会写它们）。
 * - **不发请求**：「知道了」只发 `onAck(reminderId)` 意图，回执请求由容器的 `ackReminder` 发。
 * - `fmtTime` 直接 import：它是共享的**纯**格式化函数，不是第二份实现（容器别处也在用）。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import { fmtTime } from '../../format.js'

/** 弹窗只关心这三个字段（容器那边的条目还带 taskId / methodCode，结构兼容）。 */
export interface ReminderModalItem {
  reminderId: string
  title: string
  dueAt: string
}

export interface ReminderModalProps {
  reminders: readonly ReminderModalItem[]
  onClose: () => void
  onAck: (reminderId: string) => void
}

export function ReminderModal({ reminders, onClose, onAck }: ReminderModalProps): JSX.Element {
  return (
    <Modal
      title={<><Icon name="bell" />到期提醒（{reminders.length}）</>}
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">点「知道了」后不再提示；host 侧已推送的不会重复出现</span>
          <button className="wb-btn" onClick={onClose}>稍后处理</button>
        </>
      )}
    >
      <div className="wb-scroll-area">
        {reminders.map((r) => (
          <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
            <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
            <button className="wb-btn" onClick={() => onAck(r.reminderId)}>知道了</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
