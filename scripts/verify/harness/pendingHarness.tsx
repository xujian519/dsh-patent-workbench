/**
 * H4-8（第 4 批）的真浏览器验证脚手架：「待你处理（N）」弹窗。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * - 调用点**逐字照抄容器的写法**：`pendingDrafts={allPendingDrafts.filter((d) => d.deferredAt === null)}`
 *   与 `activeDraftOpen={pendingDraft !== null}` —— 于是"过滤留在容器"和"小节间距跟着在编草稿"
 *   这两件事测的都是真实装配，不是复制品；
 * - `pendingCount` 按容器同一式子现算（`allPendingDrafts.length + reminders.length`），
 *   于是标题计数会随"点掉一条提醒"真的变化；
 * - 期望文案用**生产的 `fmtTime`** 现算并暴露（`labels`）—— 驱动不手写"10/3 09:00"这种随时区漂移的值；
 * - 服务端事实照真库形状：`allPendingDrafts` = 待确认 + 已暂存（`index.tsx` 里就是
 *   `[res.draft, ...(res.deferredDrafts ?? [])]`），所以"已暂存的不会被重复画成待确认行"
 *   可以被真的验到；`deferred_at` 非空是服务端清单的过滤条件（`repo/drafts.ts`）。
 *
 * 退化成记录器的只有"意图 → 请求"三处（真容器会发 POST / 刷新）：
 * `resumePendingDraft` / `resumeDeferredDraft` 都会**关掉弹窗**（容器里就是 `setPendingOpen(false)`），
 * 这里照做；`resumePendingDraft` 还会 `setPendingDraft(draft)`，也照做 —— 那是间距的输入。
 *
 * ⚠️ 未覆盖：`fmtTime(draft.deferredAt ?? draft.updatedAt)` 的兜底分支。服务端清单按
 * `deferred_at IS NOT NULL` 过滤，`deferredAt` 为空的条目进不了这里 —— 不可达，不造合成装置。
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PendingModal } from '../../../src/client/components/dialogs/PendingModal.js'
import { fmtTime } from '../../../src/client/format.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { DraftView } from '../../../src/shared/contracts.js'

/** 照真库形状造一条草稿（`status_code` 都是 pending，差在 `deferred_at`）。 */
function draft(id: string, kindCode: string, deferredAt: string | null, deferCount: number, updatedAt: string): DraftView {
  return { id, kindCode, sessionId: null, payload: {}, statusCode: 'pending', deferredAt, deferCount, createdAt: '2026-10-01T00:00:00.000Z', updatedAt }
}

/** 待确认（`deferred_at` 为空）—— 会被画成「待确认的…」行。 */
const ACTIVE = draft('d-active', 'task', null, 0, '2026-10-03T01:00:00.000Z')
/** 已暂存两条：`deferCount` 一条为 1（不显示「第 N 次」）、一条为 3（显示）。 */
const DEFERRED1 = draft('d-defer-1', 'knowledge', '2026-10-03T01:20:00.000Z', 1, '2026-10-03T01:20:00.000Z')
const DEFERRED2 = draft('d-defer-2', 'daily_plan', '2026-10-02T23:30:00.000Z', 3, '2026-10-02T23:30:00.000Z')

const REMINDERS = [
  { reminderId: 'r1', taskId: 't-1', title: '答复第一次审查意见', dueAt: '2026-10-04T09:30:00.000Z', methodCode: 'inapp' },
  { reminderId: 'r2', taskId: 't-2', title: '提交年费', dueAt: '2026-10-05T18:00:00.000Z', methodCode: 'inapp' },
]
const REMINDERS_SINGLE = [REMINDERS[0]]

const calls: Array<{ name: string; args: unknown[] }> = []

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [allPendingDrafts, setAllPendingDrafts] = useState<DraftView[]>([])
  const [deferredDrafts, setDeferredDrafts] = useState<DraftView[]>([])
  const [reminders, setReminders] = useState<typeof REMINDERS>([])
  /** 与容器同名同义：正在弹框里编辑的那份草稿（只影响「已暂存」小节的上边距）。 */
  const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)

  const pendingCount = allPendingDrafts.length + reminders.length

  const labels = useMemo(() => ({
    reminders: REMINDERS.map((r) => `${r.title} · ${fmtTime(r.dueAt)}`),
    deferred: [DEFERRED1, DEFERRED2].map((d) => `暂存于 ${fmtTime(d.deferredAt ?? d.updatedAt)}`),
  }), [])

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      /** 三种初始态：全量 / 只有一条提醒（用来"点掉最后一条 → 空态"，不就关窗）/ 全空。 */
      show: (mode: 'all' | 'only-reminder' | 'empty' | null): void => {
        calls.push({ name: 'show', args: [mode] })
        if (mode === null) { setOpen(false); return }
        if (mode === 'empty') {
          setAllPendingDrafts([]); setDeferredDrafts([]); setReminders([])
        } else if (mode === 'only-reminder') {
          setAllPendingDrafts([]); setDeferredDrafts([]); setReminders(REMINDERS_SINGLE)
        } else {
          setAllPendingDrafts([ACTIVE, DEFERRED1, DEFERRED2]); setDeferredDrafts([DEFERRED1, DEFERRED2]); setReminders(REMINDERS)
        }
        setPendingDraft(null)
        setOpen(true)
      },
      setActiveDraftOpen: (value: boolean): void => setPendingDraft(value ? ACTIVE : null),
      /** 只开关弹窗，**不动**夹具与 `pendingDraft`（用来验"关窗→重开"后间距还在）。 */
      open: (value: boolean): void => setOpen(value),
      ids: { active: ACTIVE.id, deferred1: DEFERRED1.id, deferred2: DEFERRED2.id, reminder1: REMINDERS[0].reminderId, reminder2: REMINDERS[1].reminderId },
      labels,
      state: () => ({ open, pendingCount, pendingDraftId: pendingDraft === null ? null : pendingDraft.id, all: allPendingDrafts.length, deferred: deferredDrafts.length, reminders: reminders.length }),
    }
  })

  return (
    <div className="wb-body" style={{ height: '100vh' }}>
      {open && (
        <PendingModal
          pendingCount={pendingCount}
          pendingDrafts={allPendingDrafts.filter((d) => d.deferredAt === null)}
          deferredDrafts={deferredDrafts}
          reminders={reminders}
          activeDraftOpen={pendingDraft !== null}
          onResumePending={(draft) => {
            // 容器 `resumePendingDraft`：记录意图 → 关窗 → 把这份草稿交给编辑弹框。
            calls.push({ name: 'resumePending', args: [draft.id, draft.kindCode] })
            setOpen(false)
            setPendingDraft(draft)
          }}
          onResumeDeferred={(draftId) => {
            calls.push({ name: 'resumeDeferred', args: [draftId] })
            setOpen(false)
          }}
          onAckReminder={(reminderId) => {
            calls.push({ name: 'ackReminder', args: [reminderId] })
            // 容器 ack 后会刷新列表 → 那一行消失；这里用同一口径（过滤）替代。
            setReminders((prev) => prev.filter((r) => r.reminderId !== reminderId))
          }}
          onClose={() => { calls.push({ name: 'close', args: [] }); setOpen(false) }}
        />
      )}
    </div>
  )
}

const style = document.createElement('style')
style.textContent = WORKBENCH_CSS
document.head.appendChild(style)
const host = document.createElement('div')
host.id = 'root'
document.body.appendChild(host)
createRoot(host).render(<Harness />)
