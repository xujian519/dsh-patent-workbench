/**
 * 「待你处理」弹窗 —— H4-8 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **传进来的**：已按 `deferredAt === null` 挑好的待确认清单、已暂存清单、要一并
 *   展示的提醒、以及在编草稿是否正开着（决定「已暂存」小节的上边距）。
 *   **没有一处 `useState`** —— `pendingOpen` / `allPendingDrafts` / `deferredDrafts` /
 *   `reminders` / `pendingDraft` 全住容器（轮询与调度器都会写它们）。
 * - **不发请求**：三个按钮只发意图（`onResumePending` / `onResumeDeferred` /
 *   `onAckReminder`），请求由容器里的 `resumePendingDraft` / `resumeDeferredDraft` /
 *   `ackReminder` 发。
 * - 清单的过滤（`deferredAt === null`）留在容器：这里是**画**，不是**判**。
 * - `draftKindLabel` / `fmtTime` 直接 import：共享的**纯**格式化函数，不是第二份实现。
 *
 * ⚠️ 「提醒行」的画法与 `ReminderModal` 现在各有一份（搬之前 `index.tsx` 里同样是两份）。
 * 抽公共行会同时改两个弹窗的画法，不属纯搬运 —— 记为待办，不在本步做。
 */
import { Modal } from '../Modal.js'
import { draftKindLabel, fmtTime } from '../../format.js'
import type { DraftView } from '../../../shared/contracts.js'

/** 弹窗只关心这三个字段（容器那边的条目还带 taskId / methodCode，结构兼容）。 */
export interface PendingReminderItem {
  reminderId: string
  title: string
  dueAt: string
}

export interface PendingModalProps {
  pendingCount: number
  /** 已经滤掉 `deferredAt !== null` 的部分（过滤留在容器）。 */
  pendingDrafts: readonly DraftView[]
  deferredDrafts: readonly DraftView[]
  reminders: readonly PendingReminderItem[]
  /** 容器传 `pendingDraft !== null`：真时「已暂存」小节与上方间隔 10px。 */
  activeDraftOpen: boolean
  onResumePending: (draft: DraftView) => void
  onResumeDeferred: (draftId: string) => void
  onAckReminder: (reminderId: string) => void
  onClose: () => void
}

export function PendingModal({
  pendingCount, pendingDrafts, deferredDrafts, reminders, activeDraftOpen,
  onResumePending, onResumeDeferred, onAckReminder, onClose,
}: PendingModalProps): JSX.Element {
  return (
    <Modal
      title={<>待你处理（{pendingCount}）</>}
      size="sm"
      onClose={onClose}
      footer={<button className="wb-btn" onClick={onClose}>关闭</button>}
    >
      <div className="wb-scroll-area">
        {/**
          * 待确认草稿一律**按服务端清单**列出（含"关掉横幅先收起"的）：
          * 用户收起横幅只是"别挡着我"，不代表决定过了 —— 必须还能从这里找到。
          */}
        {pendingDrafts.map((draft) => (
          <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>
              <b>待确认的{draftKindLabel(draft.kindCode)}</b>
              <span className="wb-switch-desc">AI 已提交，确认后才会写入工作台。</span>
            </span>
            <button className="wb-btn" onClick={() => onResumePending(draft)}>打开弹框</button>
          </div>
        ))}
        {deferredDrafts.length > 0 && (
          <div style={{ marginTop: activeDraftOpen ? 10 : 0 }}>
            <div className="wb-hint" style={{ marginBottom: 4 }}>已暂存（{deferredDrafts.length}）· 做完手上的事再从这里唤回</div>
            {deferredDrafts.map((draft) => (
              <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}>
                  <b>{draftKindLabel(draft.kindCode)}</b>
                  <span className="wb-switch-desc">
                    暂存于 {fmtTime(draft.deferredAt ?? draft.updatedAt)}
                    {draft.deferCount > 1 ? ` · 第 ${draft.deferCount} 次` : ''}
                  </span>
                </span>
                <button className="wb-btn primary" onClick={() => onResumeDeferred(draft.id)}>唤回处理</button>
              </div>
            ))}
          </div>
        )}
        {reminders.map((r) => (
          <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
            <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
            <button className="wb-btn" onClick={() => onAckReminder(r.reminderId)}>知道了</button>
          </div>
        ))}
        {pendingCount === 0 && <p className="wb-hint">暂无待处理事项。</p>}
      </div>
    </Modal>
  )
}
