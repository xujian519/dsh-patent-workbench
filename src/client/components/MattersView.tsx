/**
 * 案卷视图（阶段 5 · 5B）——列表 + 详情 + 时间线 + 建档/编辑表单。
 *
 * ## 组件边界
 *
 * 这个文件只做**渲染与本地表单状态**：数据从哪来、什么时候拉，全在 `index.tsx`
 * （与 `DayPanel` / `KnowledgeList` 同一条分工）。判定类逻辑一律在纯模块里：
 *
 * - 时间线合成与排序 → `client/matterTimeline.ts`（有单测）；
 * - 阶段/案型/专利类型/官文类型的显示名 → 字典（`dictOf` 由父级注入）。
 *
 * ## 为什么案卷要有一等视图
 *
 * 决策 1 把案卷做成一等实体（不再是"顶层任务 + extra"）。一等实体就该有自己的一屏：
 * 它的字段（申请号/公开号/申请日/优先权要求/技术领域…）根本不适合塞进任务详情，
 * 而任务语义（今日/优先级/重复）对案卷也不成立 —— 混着放的结果是两边都别扭。
 */
import type { Dict } from '../viewTypes.js'
import type { MatterTimeline, MatterTimelineEntry } from '../matterTimeline.js'
import { Icon } from './Icon.js'

/** 案卷行（与 `MatterRow` 同形；字段可空性照抄后端，避免"界面比库里更乐观"）。 */
export interface MatterView {
  id: string
  caseNumber: string
  title: string
  clientId: string | null
  matterType: string
  patentKind: string | null
  stageCode: string
  applicationNo: string | null
  publicationNo: string | null
  patentNo: string | null
  filingDate: string | null
  priorityDate: string | null
  claimsPriority: number
  /** ⚠️ 字段名与 `MatterInput`/`MatterPatch` 一致：`isPctNationalPhase`（写错会被服务端静默忽略）。 */
  isPctNationalPhase: boolean
  ipc: string | null
  techField: string | null
  inventors: string | null
  applicant: string | null
  attorney: string | null
  workspacePath: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MatterNoticeView {
  id: string
  noticeKind: string
  dispatchDate: string
  deliveryMode: string
  deliveryDate: string | null
  designatedMonths: number | null
  fileLink: string | null
  note: string | null
}

export interface MatterDeadlineView {
  id: string
  label: string
  dueDate: string
  dueDateRaw: string
  basis: string | null
  status: string | null
  /** 计算输入快照（可复算/可申诉）。`calendarCaveat` 在时说明**日历未覆盖该日期**。 */
  computedFrom?: Record<string, unknown>
}

/**
 * 期限看板的一行（`GET /matter-deadlines/upcoming`）——跨案卷，已带 `overdue`。
 *
 * `overdue` 由**服务端**给出（`due_date < 今天`）：日期比较的时区口径只该有一处实现，
 * 界面自己 `new Date()` 比一遍就会出现"服务端说没过期、界面标红"。
 */
export interface UpcomingDeadlineView {
  id: string
  matterId: string
  caseNumber: string
  matterTitle: string
  label: string
  dueDate: string
  status: string | null
  overdue: boolean
}

/** 码 → 中文名；查不到原样返回 code（与 `matterTimeline.labelOf` 同一约定）。 */
export function dictLabel(dicts: readonly Dict[], kind: string, code: string): string {
  return dicts.find((dict) => dict.kind === kind && dict.code === code)?.name ?? code
}

/**
 * 期限状态的显示名。
 *
 * 为什么**不**做成字典：这四个值是**闭集**（写入口只有 `repo/matters.ts#setMatterDeadlineStatus`
 * 的 `allowed` 列表；引擎交回来的行不带状态，由仓储按 `pending` 落库），不是用户该配置的东西 ——
 * 做成字典会让"设置页能改名"与"按值判断"两套口径打架。
 * 闭集只写在唯一一处，查不到原样显示码（不猜、不留空）；`test/matterView.test.mjs` 有一条
 * 跨文件判据钉住"客户端这张表 == 仓储的 allowed 列表"。
 *
 * ⚠️ 设计文档 §6 的 SQL 注释里还列过一个 `calendar-uncovered` —— **没有任何代码产出它**，
 * 所以这里不放这个标签（放上去等于告诉用户"系统会这么说"，而它永远不会说）。
 * "日历未覆盖"是 `computedFrom.calendarCaveat`（**每条期限各自的**输入快照字段），
 * 由下面那行 `calendarCaveat` 提示如实显示。
 */
const DEADLINE_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  done: '已完成',
  waived: '已免除',
  overdue: '已过期',
}

export function deadlineStatusLabel(status: string | null): string {
  if (status === null || status === '') return DEADLINE_STATUS_LABELS.pending
  return DEADLINE_STATUS_LABELS[status] ?? status
}

/** 阶段徽标（字典名 + 码，用户能对着《专利审查指南》里的案卷生命周期念出来）。 */
function StageBadge({ dicts, code }: { dicts: readonly Dict[]; code: string }): JSX.Element {
  const entry = dicts.find((dict) => dict.kind === 'matter_stage' && dict.code === code)
  const color = String(entry?.config.color ?? '')
  return (
    <span className="wb-matter-stage" data-stage={code} style={color === '' ? undefined : { borderColor: color, color }}>
      {entry?.name ?? code}
    </span>
  )
}

/**
 * 案卷列表。
 *
 * 排序由父级给（后端按 `updated_at DESC`）；这里**不重排** —— 列表顺序换了用户会以为丢案子，
 * 而要改排序就该改一处（后端 SQL），不该在渲染里再插一层规则。
 */
export function MatterList({ matters, dicts, selectedId, onOpen }: {
  matters: readonly MatterView[]
  dicts: readonly Dict[]
  selectedId: string | null
  onOpen: (matter: MatterView) => void
}): JSX.Element {
  if (matters.length === 0) {
    return <div className="wb-empty" data-matter-empty>还没有案卷。点「新建案卷」建档；建档后才能登记官文、算期限、归入知识。</div>
  }
  return (
    <div className="wb-matter-list" data-matter-list>
      {matters.map((matter) => (
        <button
          key={matter.id}
          type="button"
          className={`wb-matter-row ${selectedId === matter.id ? 'on' : ''}`}
          data-matter-row={matter.caseNumber}
          onClick={() => onOpen(matter)}
        >
          <span className="wb-matter-row-main">
            <span className="wb-matter-case">{matter.caseNumber}</span>
            <span className="wb-matter-name">{matter.title}</span>
          </span>
          <span className="wb-matter-row-meta">
            <StageBadge dicts={dicts} code={matter.stageCode} />
            <span>{dictLabel(dicts, 'matter_type', matter.matterType)}</span>
            {matter.patentKind === null || matter.patentKind === '' ? null : <span>{dictLabel(dicts, 'patent_kind', matter.patentKind)}</span>}
            {matter.filingDate === null || matter.filingDate === '' ? null : <span>申请日 {matter.filingDate}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** 详情里的一个字段（值缺失时写「—」，不留空 —— 空着看不出是"没有"还是"界面没渲染"）。 */
function Field({ label, value }: { label: string; value: string | null | undefined }): JSX.Element {
  const text = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="wb-matter-field">
      <span className="wb-matter-field-k">{label}</span>
      <span className="wb-matter-field-v" data-matter-field={label}>{text}</span>
    </div>
  )
}

/**
 * 期限看板（跨案卷的"近 N 天到期"）——放在「今日」视图里。
 *
 * 为什么放今日而不是另开一个顶级页签：**期限是"今天要办的事"的一部分**。
 * 用户在今日视图的工作流是"看今天该做什么"，而"三天后要交答复"正属于这个判断；
 * 另开一页会变成"要记得去看"的另一处（决策 D5-3 的推荐口径）。
 */
export function UpcomingDeadlines({ deadlines, days, engineAvailable, onRecomputeAll, busy }: {
  deadlines: readonly UpcomingDeadlineView[]
  days: number
  /** 引擎是否可用（软探测结果）；不可用时明确说明"为什么这里没有期限"。 */
  engineAvailable: boolean
  onRecomputeAll: () => void
  busy: boolean
}): JSX.Element {
  return (
    <div className="wb-card wb-dl-board" data-deadline-board>
      <div className="wb-matter-head">
        <h3 className="wb-matter-title">
          期限 <span className="wb-matter-count">近 {days} 天 {deadlines.length} 条（含已过期）</span>
        </h3>
        <button className="wb-btn" disabled={busy || !engineAvailable} onClick={onRecomputeAll} data-deadline-recompute>
          <Icon name="refresh" />重算全部
        </button>
      </div>
      {!engineAvailable && (
        /**
         * 引擎缺失时**必须说出来**（决策 3 / D2 的降级口径）：否则用户看到空看板
         * 会以为"我没有期限"，而不是"这台机器上没装期限引擎"。
         */
        <div className="wb-field-note" data-deadline-degraded>
          未探测到期限引擎（DSH Patent 的 patentDeadline 服务），所以下面没有自动算出的期限。
          登记官文不会自动产生期限 —— 这是**明确降级**，不是算不出来。装好引擎后可点「重算全部」。
        </div>
      )}
      {deadlines.length === 0
        ? <div className="wb-empty">{engineAvailable ? '近 ' + days + ' 天内没有待办期限。' : '（引擎不可用，无法列出自动期限）'}</div>
        : (
          <div className="wb-dl-list">
            {deadlines.map((deadline) => (
              <div key={deadline.id} className={`wb-dl-row ${deadline.overdue ? 'overdue' : ''}`} data-deadline-row={deadline.id}>
                <span className="wb-dl-date">{deadline.dueDate}</span>
                <span className="wb-dl-main">
                  <span className="wb-dl-label">{deadline.label}</span>
                  <span className="wb-dl-meta">{deadline.caseNumber} · {deadline.matterTitle}</span>
                </span>
                {deadline.overdue ? <span className="wb-dl-flag">已过期</span> : null}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

/** 时间线一条：类型徽标 + 日期 + 标题（+ 补充说明）。 */
function TimelineRow({ entry }: { entry: MatterTimelineEntry }): JSX.Element {
  return (
    <div className="wb-matter-tl-row" data-timeline-kind={entry.kind}>
      <span className={`wb-matter-tl-kind ${entry.kind}`}>{entry.kind === 'event' ? '事件' : entry.kind === 'notice' ? '官文' : '期限'}</span>
      <span className="wb-matter-tl-date">{entry.date === '' ? '无日期' : entry.date}</span>
      <span className="wb-matter-tl-main">
        <span className="wb-matter-tl-title">{entry.title}</span>
        {entry.detail === '' ? null : <span className="wb-matter-tl-detail">{entry.detail}</span>}
      </span>
    </div>
  )
}

/**
 * 案卷详情：字段区 + 时间线。
 *
 * ⚠️ **没有**任何"期限只剩 N 天"式的推断 —— 那是 `patent-deadline` 的职责（决策 3 / D2），
 * 界面只显示引擎算出来的 `due_date`。5C 会把重算按钮与期限看板加在这里。
 */
export function MatterDetail({ matter, dicts, timeline, notices, deadlines, engineAvailable, recomputeNote, onEdit, onAddNotice, onDeleteNotice, onRecompute, onSetDeadlineStatus, busy }: {
  matter: MatterView
  dicts: readonly Dict[]
  timeline: MatterTimeline
  notices: readonly MatterNoticeView[]
  deadlines: readonly MatterDeadlineView[]
  /** 引擎可用性（软探测）；不可用时说明降级原因，不给"看起来像没期限"的空看板。 */
  engineAvailable: boolean
  /** 上次重算的结果说明（含引擎给的 `pending` 与日历覆盖提示）。 */
  recomputeNote: string
  onEdit: () => void
  onAddNotice: () => void
  onDeleteNotice: (noticeId: string) => void
  onRecompute: () => void
  onSetDeadlineStatus: (deadlineId: string, status: string) => void
  busy: boolean
}): JSX.Element {
  return (
    <div className="wb-matter-detail" data-matter-detail={matter.caseNumber}>
      <div className="wb-card">
        <div className="wb-matter-head">
          <h3 className="wb-matter-title">{matter.caseNumber} · {matter.title}</h3>
          <StageBadge dicts={dicts} code={matter.stageCode} />
          <button className="wb-btn" disabled={busy} onClick={onEdit}><Icon name="edit" />编辑</button>
        </div>
        <div className="wb-matter-fields">
          <Field label="案型" value={dictLabel(dicts, 'matter_type', matter.matterType)} />
          <Field label="专利类型" value={matter.patentKind === null ? null : dictLabel(dicts, 'patent_kind', matter.patentKind)} />
          <Field label="客户" value={matter.clientId} />
          <Field label="申请号" value={matter.applicationNo} />
          <Field label="公开号" value={matter.publicationNo} />
          <Field label="授权号" value={matter.patentNo} />
          <Field label="申请日" value={matter.filingDate} />
          <Field label="优先权日" value={matter.priorityDate} />
          {/* 要求优先权是**起算日**的输入（引擎明确不推断），所以必须显式说出来 */}
          <Field label="要求优先权" value={matter.claimsPriority === 1 ? '是' : '否'} />
          <Field label="PCT 进入中国" value={matter.isPctNationalPhase ? '是' : '否'} />
          <Field label="技术领域" value={matter.techField} />
          <Field label="IPC" value={matter.ipc} />
          <Field label="发明人" value={matter.inventors} />
          <Field label="申请人" value={matter.applicant} />
          <Field label="代理师" value={matter.attorney} />
          <Field label="案卷目录" value={matter.workspacePath} />
        </div>
      </div>

      <div className="wb-card">
        <div className="wb-matter-head">
          <h3 className="wb-matter-title">官文登记 <span className="wb-matter-count">{notices.length}</span></h3>
          <button className="wb-btn" disabled={busy} onClick={onAddNotice} data-matter-add-notice><Icon name="plus" />登记官文</button>
        </div>
        {notices.length === 0
          ? <div className="wb-empty">还没有登记官文。官文是期限的**输入源** —— 没登记就不会有期限。</div>
          : (
            <div className="wb-matter-notices">
              {notices.map((notice) => (
                <div key={notice.id} className="wb-matter-notice" data-matter-notice={notice.id}>
                  <span className="wb-matter-notice-kind">{dictLabel(dicts, 'notice_kind', notice.noticeKind)}</span>
                  <span className="wb-matter-notice-date">发文 {notice.dispatchDate}</span>
                  <span className="wb-matter-notice-mode">{dictLabel(dicts, 'delivery_mode', notice.deliveryMode)}</span>
                  {notice.deliveryDate === null ? null : <span>送达 {notice.deliveryDate}</span>}
                  {notice.designatedMonths === null ? null : <span>指定 {notice.designatedMonths} 个月</span>}
                  {notice.fileLink === null || notice.fileLink === '' ? null : <span className="wb-matter-notice-file">{notice.fileLink}</span>}
                  <button className="wb-btn" disabled={busy} onClick={() => onDeleteNotice(notice.id)} title="删除这条官文登记"><Icon name="trash" /></button>
                </div>
              ))}
            </div>
          )}
      </div>

      <div className="wb-card">
        <div className="wb-matter-head">
          <h3 className="wb-matter-title">期限 <span className="wb-matter-count">{deadlines.length}</span></h3>
          {/**
            * 重算按钮：**只调引擎**，不在界面算任何期限（决策 3：计算权威在 patent-deadline）。
            * 引擎缺失时按钮禁用并说明原因 —— 不让用户点一个必然 409 的按钮还不知为何。
            */}
          <button className="wb-btn" disabled={busy || !engineAvailable} onClick={onRecompute} data-matter-recompute>
            <Icon name="refresh" />重算期限
          </button>
        </div>
        {!engineAvailable && (
          <div className="wb-field-note" data-matter-engine-missing>
            未探测到期限引擎，所以这里只有手工/历史数据。登记官文**不会**自动产生期限 ——
            这是明确降级（不是算不出来）。装好引擎后再点「重算期限」。
          </div>
        )}
        {recomputeNote === '' ? null : <div className="wb-field-note" data-matter-recompute-note>{recomputeNote}</div>}
        {deadlines.length === 0
          ? <div className="wb-empty">还没有期限。登记官文后点「重算期限」由引擎算出。</div>
          : (
            <div className="wb-matter-notices">
              {deadlines.map((deadline) => (
                <div key={deadline.id} className="wb-matter-notice" data-matter-deadline={deadline.id}>
                  <span className="wb-matter-notice-kind">{deadline.label}</span>
                  <span className="wb-matter-notice-date">届满 {deadline.dueDate}</span>
                  {/* 顺延口径：两个日期不同就都写出来，否则用户会以为算错 */}
                  {deadline.dueDateRaw === deadline.dueDate ? null : <span>不顺延 {deadline.dueDateRaw}</span>}
                  {deadline.basis === null || deadline.basis === '' ? null : <span>{deadline.basis}</span>}
                  {/**
                    * 「日历未覆盖」是**真实存在**的信号（引擎把 `calendarCaveat` 写进 `computedFrom`），
                    * 必须显示出来：不显示的话用户会以为这个届满日是权威值，而它可能是按缺省规则顺延的。
                    */}
                  {typeof deadline.computedFrom?.calendarCaveat === 'string' && deadline.computedFrom.calendarCaveat !== ''
                    ? <span className="wb-dl-flag" data-deadline-caveat>日历未覆盖：{deadline.computedFrom.calendarCaveat}</span>
                    : null}
                  <span className="wb-matter-notice-mode">{deadlineStatusLabel(deadline.status)}</span>
                  <button className="wb-btn" disabled={busy} onClick={() => onSetDeadlineStatus(deadline.id, deadline.status === 'done' ? 'pending' : 'done')}>
                    {deadline.status === 'done' ? '标记未完成' : '标记完成'}
                  </button>
                  <button className="wb-btn" disabled={busy} onClick={() => onSetDeadlineStatus(deadline.id, deadline.status === 'waived' ? 'pending' : 'waived')}>
                    {deadline.status === 'waived' ? '取消免除' : '免除'}
                  </button>
                </div>
              ))}
            </div>
          )}
      </div>

      <div className="wb-card">
        <div className="wb-matter-head">
          <h3 className="wb-matter-title">时间线 <span className="wb-matter-count">{timeline.entries.length}</span></h3>
        </div>
        {timeline.entries.length === 0 && timeline.undated.length === 0
          ? <div className="wb-empty">还没有可上时间线的记录（事件 / 官文 / 期限）。</div>
          : (
            <>
              <div className="wb-matter-tl">
                {timeline.entries.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
              </div>
              {timeline.undated.length === 0 ? null : (
                /**
                 * 无日期的条目**单独列出来并说明**：它们大多是历史数据或导入的半成品。
                 * 静默丢弃会让用户以为"我明明记得登记过这条官文"。
                 */
                <div className="wb-matter-tl-undated" data-matter-undated>
                  <div className="wb-matter-tl-undated-head">以下 {timeline.undated.length} 条没有可用日期（不参与排序，但仍列出来）：</div>
                  {timeline.undated.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
}
