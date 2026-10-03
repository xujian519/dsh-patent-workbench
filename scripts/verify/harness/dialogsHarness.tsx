/**
 * H4-8 的真浏览器验证脚手架（四张弹窗：建档/编辑案卷、登记官文、到期提醒、同名任务选择）。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * - 初始草稿**逐字照抄容器的 `openMatterForm` / `openNoticeForm`**（含默认 code 的取法），
 *   所以"打开时有值 / 编辑态带出原值"测的是真实装配；
 * - 提醒行的期望文案由**生产的 `fmtTime`** 现算并暴露给驱动（`reminderLabels`）——
 *   驱动不手写"10/4 17:30"这种随时区变化的期望值；
 * - 字典取自 `src/db/schema.ts` 的出厂值（matter_type 9 / matter_stage 6 / patent_kind 3 /
 *   notice_kind 7）。
 *
 * ⚠️ `delivery_mode` **出厂没有字典行**（`seed.ts` 里没有这一组）—— 真机上那个下拉是空的，
 * 属既有缺口，与 H4-8 无关。这里给两条合成条目，好让"选项来自传入的字典切片"这条断言有对照物；
 * 不因此宣称产品里有这两项。
 *
 * 退化成记录器的只有"意图 → 请求"那几处（真容器会发请求）：
 * `saveMatter` / `saveNotice`（POST/PUT）、`ackReminder`（POST + 刷新）、`reuseExistingTask`（归档）。
 * 它们都记录了**事件是否可被 preventDefault**（表单必须拦住浏览器默认提交，否则整页跳走）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MatterDraftModal } from '../../../src/client/components/dialogs/MatterDraftModal.js'
import { NoticeDraftModal } from '../../../src/client/components/dialogs/NoticeDraftModal.js'
import { ReminderModal, type ReminderModalItem } from '../../../src/client/components/dialogs/ReminderModal.js'
import { DuplicatePromptModal } from '../../../src/client/components/dialogs/DuplicatePromptModal.js'
import { fmtTime } from '../../../src/client/format.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { Dict } from '../../../src/client/viewTypes.js'

/** 字典照 `src/db/schema.ts` 的出厂值（`delivery_mode` 例外，见文件头）。 */
function dict(kind: string, code: string, name: string): Dict {
  return { kind, code, name, config: {} }
}
const DICTS: Dict[] = [
  dict('matter_type', 'drafting', '撰写案'), dict('matter_type', 'oa_response', '审查意见答复案'),
  dict('matter_type', 'search', '检索案'), dict('matter_type', 'patentability', '专利性分析案'),
  dict('matter_type', 'invalidation', '无效宣告案'), dict('matter_type', 'reexamination', '复审案'),
  dict('matter_type', 'infringement', '侵权比对案'), dict('matter_type', 'annuity', '年费维持案'),
  dict('matter_type', 'other', '其他'),
  dict('matter_stage', 'open', '建案'), dict('matter_stage', 'retrieving', '检索中'),
  dict('matter_stage', 'analyzing', '分析中'), dict('matter_stage', 'drafting', '撰写中'),
  dict('matter_stage', 'review', '门禁/审批中'), dict('matter_stage', 'closed', '归档'),
  dict('patent_kind', 'invention', '发明专利'), dict('patent_kind', 'utility-model', '实用新型专利'),
  dict('patent_kind', 'design', '外观设计专利'),
  dict('notice_kind', 'office-action-first', '第一次审查意见通知书'),
  dict('notice_kind', 'office-action-subsequent', '后续审查意见通知书'),
  dict('notice_kind', 'substantive-exam-notice', '实质审查通知书'),
  dict('notice_kind', 'rejection-decision', '驳回决定'),
  dict('notice_kind', 'grant-notice', '授予专利权通知书'),
  dict('notice_kind', 'reexamination-notice', '复审通知书'),
  dict('notice_kind', 'invalidation-transfer', '无效宣告转送文件'),
  dict('delivery_mode', 'electronic', '电子送达'), dict('delivery_mode', 'paper', '纸件送达'),
]
const dictOf = (kind: string): Dict[] => DICTS.filter((d) => d.kind === kind)

/** 一条已存在的案卷（编辑态用；字段取真库里的形状）。 */
const MATTER = {
  id: 'm-1', caseNumber: '2025-UM-118', title: '一种折叠式光伏支架', clientId: 'client-a',
  matterType: 'oa_response', patentKind: 'utility-model', stageCode: 'review',
  applicationNo: 'CN202520000000.0', publicationNo: 'CN222000000U', patentNo: '',
  filingDate: '2025-03-01', priorityDate: '', claimsPriority: 1, isPctNationalPhase: true,
  techField: '光伏支架', ipc: 'H02S20/30', inventors: '张三,李四', applicant: '某某科技',
  attorney: '王五', workspacePath: '/Users/xujian/projects/matters/2025-UM-118',
}

/** 逐字照抄容器的 `openMatterForm`（`matter` 为空 = 新建）。 */
function matterDraftOf(matter: typeof MATTER | null): Record<string, string> {
  return {
    caseNumber: matter?.caseNumber ?? '',
    title: matter?.title ?? '',
    clientId: matter?.clientId ?? '',
    matterType: matter?.matterType ?? (dictOf('matter_type')[0]?.code ?? 'drafting'),
    patentKind: matter?.patentKind ?? '',
    stageCode: matter?.stageCode ?? (dictOf('matter_stage')[0]?.code ?? 'open'),
    applicationNo: matter?.applicationNo ?? '',
    publicationNo: matter?.publicationNo ?? '',
    patentNo: matter?.patentNo ?? '',
    filingDate: matter?.filingDate ?? '',
    priorityDate: matter?.priorityDate ?? '',
    claimsPriority: matter?.claimsPriority === 1 ? '1' : '0',
    isPctNationalPhase: matter?.isPctNationalPhase === true ? '1' : '0',
    techField: matter?.techField ?? '',
    ipc: matter?.ipc ?? '',
    inventors: matter?.inventors ?? '',
    applicant: matter?.applicant ?? '',
    attorney: matter?.attorney ?? '',
    workspacePath: matter?.workspacePath ?? '',
  }
}

/** 逐字照抄容器的 `openNoticeForm`。 */
function noticeDraftOf(): Record<string, string> {
  return {
    noticeKind: dictOf('notice_kind')[0]?.code ?? '',
    dispatchDate: '2026-10-03',
    deliveryMode: dictOf('delivery_mode')[0]?.code ?? 'electronic',
    deliveryDate: '',
    designatedMonths: '',
    fileLink: '',
    note: '',
  }
}

const REMINDERS: ReminderModalItem[] = [
  { reminderId: 'r1', title: '答复第一次审查意见', dueAt: '2026-10-04T09:30:00.000Z' },
  { reminderId: 'r2', title: '提交年费', dueAt: '2026-10-05T18:00:00.000Z' },
]

const calls: Array<{ name: string; args: unknown[] }> = []

type Which = 'matter' | 'notice' | 'reminder' | 'duplicate' | null
type DuplicatePrompt = { draftId: string; existingTaskId: string; existingTitle: string; sameDescription: boolean; sameWorkspace: boolean; newTaskId: string }

function Harness(): JSX.Element {
  const [which, setWhich] = useState<Which>(null)
  const [busy, setBusy] = useState(false)
  const [matterDraft, setMatterDraft] = useState<Record<string, string> | null>(null)
  const [matterEditing, setMatterEditing] = useState(false)
  const [noticeDraft, setNoticeDraft] = useState<Record<string, string> | null>(null)
  const [reminders, setReminders] = useState<ReminderModalItem[]>(REMINDERS)
  const [reminderOpen, setReminderOpen] = useState(false)
  const [duplicate, setDuplicate] = useState<DuplicatePrompt | null>(null)

  /** 复刻容器里"哪个入口打开哪张弹窗"（含各自初始值）。 */
  const show = useCallback((target: string | null): void => {
    if (target === 'matter-create') { setMatterEditing(false); setMatterDraft(matterDraftOf(null)); setWhich('matter'); return }
    if (target === 'matter-edit') { setMatterEditing(true); setMatterDraft(matterDraftOf(MATTER)); setWhich('matter'); return }
    if (target === 'notice') { setNoticeDraft(noticeDraftOf()); setWhich('notice'); return }
    if (target === 'reminder') { setReminders(REMINDERS); setReminderOpen(true); setWhich('reminder'); return }
    if (target === 'duplicate') {
      setDuplicate({ draftId: 'd-1', existingTaskId: 'task-1234567890ab', existingTitle: '答复第一次审查意见', sameDescription: true, sameWorkspace: true, newTaskId: 'task-new' })
      setWhich('duplicate')
      return
    }
    setWhich(null)
  }, [])

  const reminderLabels = useMemo(() => REMINDERS.map((r) => `${r.title} · ${fmtTime(r.dueAt)}`), [])

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      show,
      setBusy,
      /** 只切"同名/同工作区"两个判据，用来验两句话真的分叉。 */
      setDuplicateFlags: (flags: { sameDescription: boolean; sameWorkspace: boolean }) => setDuplicate((prev) => prev === null ? prev : { ...prev, ...flags }),
      /** 清空提醒列表（保持 `which`/open 不变）—— 用来验容器那条"非空才挂载"的必要条件。 */
      clearReminders: () => { setReminders([]); setReminderOpen(true) },
      reminders,
      reminderLabels,
      state: () => ({ which, busy, matterDraft, matterEditing, noticeDraft, reminderOpen, duplicate }),
    }
  })

  return (
    <div className="wb-body" style={{ height: '100vh' }}>
      {which === 'matter' && matterDraft !== null && (
        <MatterDraftModal
          title={matterEditing ? '编辑案卷' : '新建案卷'}
          draft={matterDraft}
          onChange={setMatterDraft}
          matterTypeOptions={dictOf('matter_type')}
          patentKindOptions={dictOf('patent_kind')}
          stageOptions={dictOf('matter_stage')}
          busy={busy}
          onClose={() => { calls.push({ name: 'matterClose', args: [] }); setMatterDraft(null); setMatterEditing(false) }}
          onSubmit={(event) => {
            // 容器 `saveMatter` 的第一件事就是 preventDefault；这里记录"拦得住吗"。
            event.preventDefault()
            calls.push({ name: 'matterSubmit', args: [{ cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, caseNumber: matterDraft.caseNumber, claimsPriority: matterDraft.claimsPriority, pct: matterDraft.isPctNationalPhase }] })
          }}
        />
      )}
      {which === 'notice' && noticeDraft !== null && (
        <NoticeDraftModal
          draft={noticeDraft}
          onChange={setNoticeDraft}
          noticeKindOptions={dictOf('notice_kind')}
          deliveryModeOptions={dictOf('delivery_mode')}
          busy={busy}
          onClose={() => { calls.push({ name: 'noticeClose', args: [] }); setNoticeDraft(null) }}
          onSubmit={(event) => {
            event.preventDefault()
            calls.push({ name: 'noticeSubmit', args: [{ cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, noticeKind: noticeDraft.noticeKind, dispatchDate: noticeDraft.dispatchDate, designatedMonths: noticeDraft.designatedMonths }] })
          }}
        />
      )}
      {which === 'reminder' && reminders.length > 0 && reminderOpen && (
        <ReminderModal
          reminders={reminders}
          onClose={() => { calls.push({ name: 'reminderClose', args: [] }); setReminderOpen(false) }}
          onAck={(reminderId) => {
            calls.push({ name: 'reminderAck', args: [reminderId] })
            // 真容器 ack 后会刷新列表 → 那一行消失；这里用同一口径（过滤）替代。
            setReminders((prev) => prev.filter((r) => r.reminderId !== reminderId))
          }}
        />
      )}
      {which === 'duplicate' && duplicate !== null && (
        <DuplicatePromptModal
          existingTitle={duplicate.existingTitle}
          existingTaskId={duplicate.existingTaskId}
          sameDescription={duplicate.sameDescription}
          sameWorkspace={duplicate.sameWorkspace}
          onClose={() => { calls.push({ name: 'duplicateClose', args: [] }); setDuplicate(null) }}
          onReuseExisting={() => calls.push({ name: 'duplicateReuseExisting', args: [duplicate.existingTaskId] })}
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
