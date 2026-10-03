/**
 * H4-5 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-matters.mjs` 现打包）。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * 时间线用**生产函数** `buildMatterTimeline()` 现算（含字典 `labelOf` 注入）——
 * 也就是容器里那个 `useMemo` 的逐字复刻，所以"事件/官文/期限三份源 → 时间线"这条链
 * 在浏览器里跑的是产品实现，不是我在脚手架里手搓的假数据。
 * 退化成记录器的只有"意图 → 请求"那几个回调（那是容器测试的事）。
 *
 * 容器侧状态（`selectedMatterId` / 三份明细 / 引擎可用性 / 列表空）在这里用 `useState`
 * 复刻，因为真容器是 `index.tsx`（跑不起来）。它复刻的是**数据流向**，不是画法。
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MatterPane } from '../../../src/client/components/views/MatterPane.js'
import { buildMatterTimeline, type MatterTimelineEvent } from '../../../src/client/matterTimeline.js'
import type { MatterDeadlineView, MatterNoticeView, MatterView } from '../../../src/client/components/MattersView.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { Dict } from '../../../src/client/viewTypes.js'

function dict(kind: string, code: string, name: string): Dict {
  return { kind, code, name, config: {} }
}
const DICTS: Dict[] = [
  dict('matter_type', 'invention', '发明专利'),
  dict('matter_type', 'utility', '实用新型'),
  dict('matter_stage', 'drafting', '撰写中'),
  dict('matter_stage', 'open', '立案'),
  dict('patent_kind', 'inv', '发明专利'),
  dict('notice_kind', 'oa1', '第一次审查意见通知书'),
  dict('delivery_mode', 'electronic', '电子送达'),
]

const MATTERS: MatterView[] = [
  {
    id: 'm1', caseNumber: '2026-INV-001', title: '一种检索式构建方法', clientId: 'c1', matterType: 'invention',
    patentKind: 'inv', stageCode: 'drafting', applicationNo: '202610000001.0', publicationNo: null, patentNo: null,
    filingDate: '2026-09-20', priorityDate: null, claimsPriority: 1, isPctNationalPhase: false, ipc: 'G06F',
    techField: '信息检索', inventors: '张三', applicant: '某公司', attorney: '李四', workspacePath: '/tmp/m1',
    closedAt: null, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    // 客户字段缺失（null）→ 详情必须显示 "—" 而不是 undefined
    id: 'm2', caseNumber: '2026-UM-002', title: '一种兽用中药智能熬制设备', clientId: null, matterType: 'utility',
    patentKind: null, stageCode: 'open', applicationNo: null, publicationNo: null, patentNo: null,
    filingDate: null, priorityDate: null, claimsPriority: 0, isPctNationalPhase: false, ipc: null,
    techField: null, inventors: null, applicant: null, attorney: null, workspacePath: null,
    closedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'm3', caseNumber: '2026-INV-003', title: '第三种案卷', clientId: null, matterType: 'invention',
    patentKind: null, stageCode: 'open', applicationNo: null, publicationNo: null, patentNo: null,
    filingDate: null, priorityDate: null, claimsPriority: 0, isPctNationalPhase: false, ipc: null,
    techField: null, inventors: null, applicant: null, attorney: null, workspacePath: null,
    closedAt: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  },
]

const NOTICES: MatterNoticeView[] = [
  {
    id: 'n1', noticeKind: 'oa1', dispatchDate: '2026-10-05', deliveryMode: 'electronic',
    deliveryDate: null, designatedMonths: 4, fileLink: 'file:///tmp/oa1.pdf', note: null,
  },
  // 送达日与指定月数缺失 → 那两段文案不该出现（不是 "undefined 个月"）
  { id: 'n2', noticeKind: 'oa1', dispatchDate: '2026-10-06', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: null, fileLink: null, note: null },
]

const DEADLINES: MatterDeadlineView[] = [
  {
    id: 'd1', label: '答复第一次审查意见', dueDate: '2026-12-15', dueDateRaw: '2026-12-10',
    basis: '专利法实施细则', status: 'pending', computedFrom: { calendarCaveat: '2026-12-15 不在工作日历里' },
  },
  { id: 'd2', label: '年费缴纳', dueDate: '2026-10-20', dueDateRaw: '2026-10-20', basis: null, status: 'done' },
]

const EVENTS: MatterTimelineEvent[] = [
  { id: 'e1', action: '提交', artifact: '说明书', approver: null, note: null, at: '2026-09-30' },
  // 无日期 → 必须落进 "没有可用日期" 那一段，不许被静默丢掉
  { id: 'e2', action: '导入', artifact: null, approver: null, note: null, at: '' },
]

const calls: Array<{ name: string; args: unknown[] }> = []
/** 无参入口：容器侧就是"摊开一份空草稿"，这里只记一次调用。
 *  ⚠️ 不能写成 `onCreate={record('create')}` —— 它挂在 `onClick` 上，React 会把**点击事件**
 *  传进来，`api.evaluate` 序列化那个合成事件时会直接报 "Object reference chain is too long"。 */
const noArgs = (name: string) => (): void => { calls.push({ name, args: [] }) }

function Harness(): JSX.Element {
  const [matters, setMatters] = useState<MatterView[]>(MATTERS)
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null)
  const [engineAvailable, setEngineAvailable] = useState(true)

  const selectedMatter = selectedMatterId === null ? null : (matters.find((matter) => matter.id === selectedMatterId) ?? null)
  /** 与容器同一处调用：三份源 + 字典 labelOf → 时间线（排序/判定都在纯模块里）。 */
  const timeline = useMemo(() => buildMatterTimeline({
    events: EVENTS,
    notices: NOTICES,
    deadlines: DEADLINES,
    labelOf: (kind, code) => DICTS.find((item) => item.kind === kind && item.code === code)?.name ?? code,
  }), [])

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      selectedId: () => selectedMatterId,
      setMattersEmpty: (empty: boolean) => { setMatters(empty ? [] : MATTERS); setSelectedMatterId(null) },
      setEngineAvailable,
    }
  })

  return (
    <div className="wb-body" style={{ display: 'flex', height: '100vh' }}>
      <div className="wb-nav" style={{ width: '62%', overflow: 'auto' }}>
        <MatterPane
          matters={matters}
          dicts={DICTS}
          selectedMatterId={selectedMatterId}
          selectedMatter={selectedMatter}
          timeline={timeline}
          notices={NOTICES}
          deadlines={DEADLINES}
          engineAvailable={engineAvailable}
          recomputeNote={selectedMatterId === null ? '' : '重算完成：2 条真日期期限'}
          syncNote={selectedMatterId === null ? '' : '已从 /tmp/m2/_matter-log.md 同步：新增 1 条。'}
          busy={false}
          onOpen={(matter) => { calls.push({ name: 'open', args: [matter.id] }); setSelectedMatterId(matter.id) }}
          onCreate={noArgs('create')}
          onEdit={(matter) => { calls.push({ name: 'edit', args: [matter.id] }) }}
          onAddNotice={noArgs('addNotice')}
          onDeleteNotice={(noticeId) => { calls.push({ name: 'deleteNotice', args: [noticeId] }) }}
          onRecompute={(matterId) => { calls.push({ name: 'recompute', args: [matterId] }) }}
          onSetDeadlineStatus={(deadlineId, status) => { calls.push({ name: 'setDeadlineStatus', args: [deadlineId, status] }) }}
          onSyncEvents={(matterId) => { calls.push({ name: 'syncEvents', args: [matterId] }) }}
        />
      </div>
      <div className="wb-detail" style={{ width: '38%' }} />
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
