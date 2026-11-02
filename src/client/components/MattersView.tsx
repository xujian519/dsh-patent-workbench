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
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Dict } from '../viewTypes.js'
import type { MatterTimeline, MatterTimelineEntry } from '../matterTimeline.js'
import { groupUpcomingDeadlines } from '../deadlineBoard.js'
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

/**
 * 重拉案卷列表后该选中哪一个：列表里还有这个 id 就留着，已经没了就清成 `null`。
 *
 * 为什么必须有：案卷可能在**别处**被删（AI 会话、另一个 profile 写同一个库、手工删档），
 * 而 `selectedMatterId` 住容器、重拉列表不会碰它。留着失效 id 会让两块自相矛盾 ——
 * 左栏写「（已选 1 个）」、右栏写「← 从左侧选择一个案卷查看详情」
 *（那三个明细 GET 对不存在的案卷返回空列表、不报错，所以矛盾是这里唯一的症状）。
 * 反过来，"列表里还有"**必须**留着：每次重拉都清空，会把用户的选中无端弄丢。
 */
export function retainSelectedMatterId(prev: string | null, matters: readonly MatterView[]): string | null {
  return prev !== null && matters.some((matter) => matter.id === prev) ? prev : null
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
 * 案卷列表的轻量搜筛（方案 A）。
 *
 * 只匹配案号与名称，大小写不敏感；阶段用字典里的 `matter_stage` 码，空串 = 全部。
 * **不重排**：未筛时原样返回同一数组（后端 `updated_at DESC` 的顺序一个字不动）。
 * 筛是前端内存过滤，状态住在 `MatterPane`，不进 `WorkbenchApp`。
 */
export function isMatterFilterActive(query: string, stageCode: string): boolean {
  return query.trim() !== '' || stageCode !== ''
}

export function filterMatters(matters: readonly MatterView[], query: string, stageCode: string): readonly MatterView[] {
  const needle = query.trim().toLowerCase()
  if (needle === '' && stageCode === '') return matters
  return matters.filter((matter) => {
    if (stageCode !== '' && matter.stageCode !== stageCode) return false
    if (needle === '') return true
    return matter.caseNumber.toLowerCase().includes(needle) || matter.title.toLowerCase().includes(needle)
  })
}

/** 阶段下拉：全部之外的选项，顺序与字典给出的一致（不另排）。 */
export function matterStageOptions(dicts: readonly Dict[]): Array<{ code: string; name: string }> {
  const options: Array<{ code: string; name: string }> = []
  for (const dict of dicts) {
    if (dict.kind !== 'matter_stage') continue
    options.push({ code: dict.code, name: dict.name === '' ? dict.code : dict.name })
  }
  return options
}

/** 工具条计数。未筛保持「案卷 N 个」；有筛时在后面加上「已筛 M」。 */
export function matterListCountLabel(total: number, shown: number, filtering: boolean, selected: boolean): string {
  const base = filtering ? `案卷 ${total} 个 · 已筛 ${shown}` : `案卷 ${total} 个`
  return selected ? `${base}（已选 1 个）` : base
}

/** 详情四区。字段 / 官文 / 期限 / 时间线，开合只影响显隐，不碰数据。 */
export type MatterSectionId = 'fields' | 'notices' | 'deadlines' | 'timeline'

export interface MatterSectionCounts {
  notices: number
  deadlines: number
  timeline: number
}

export interface MatterSectionOpen {
  fields: boolean
  notices: boolean
  deadlines: boolean
  timeline: boolean
}

export interface MatterSectionState {
  matterId: string
  counts: MatterSectionCounts
  open: MatterSectionOpen
}

/**
 * 四区统一默认展开。
 *
 * 空区里有现在就要看见的说明（官文是期限的输入源、引擎降级、时间线方向），
 * 折起来等于把这些话藏掉。用户要减噪再自己折。
 */
export function initialMatterSectionOpen(): MatterSectionOpen {
  return { fields: true, notices: true, deadlines: true, timeline: true }
}

export function createMatterSectionState(matterId: string, counts: MatterSectionCounts): MatterSectionState {
  return { matterId, counts, open: initialMatterSectionOpen() }
}

/**
 * 切到另一卷：开合重置为默认展开。
 * 同一卷里某一区从 0 条变成有内容（刚登记官文 / 刚算出期限 / 刚同步进事件）：
 * 若当时是折合的，展开，避免人点完按钮却看不见新行。
 * 已经有内容时再增减，不打断用户自己折上的状态。
 */
export function reconcileMatterSectionState(prev: MatterSectionState, matterId: string, counts: MatterSectionCounts): MatterSectionState {
  if (prev.matterId !== matterId) return createMatterSectionState(matterId, counts)
  if (prev.counts.notices === counts.notices && prev.counts.deadlines === counts.deadlines && prev.counts.timeline === counts.timeline) {
    return prev
  }
  return {
    matterId,
    counts,
    open: {
      fields: prev.open.fields,
      notices: prev.counts.notices === 0 && counts.notices > 0 ? true : prev.open.notices,
      deadlines: prev.counts.deadlines === 0 && counts.deadlines > 0 ? true : prev.open.deadlines,
      timeline: prev.counts.timeline === 0 && counts.timeline > 0 ? true : prev.open.timeline,
    },
  }
}

export function toggleMatterSection(state: MatterSectionState, id: MatterSectionId): MatterSectionState {
  return { ...state, open: { ...state.open, [id]: !state.open[id] } }
}

/**
 * 案卷列表。
 *
 * 排序由父级给（后端按 `updated_at DESC`）；这里**不重排** —— 列表顺序换了用户会以为丢案子，
 * 而要改排序就该改一处（后端 SQL），不该在渲染里再插一层规则。
 * `noMatch`：父级筛过且一条都没剩。库本身是空的仍走「还没有案卷」，两句不混。
 */
export function MatterList({ matters, dicts, selectedId, onOpen, noMatch = false }: {
  matters: readonly MatterView[]
  dicts: readonly Dict[]
  selectedId: string | null
  onOpen: (matter: MatterView) => void
  noMatch?: boolean
}): JSX.Element {
  if (matters.length === 0) {
    if (noMatch) {
      return <div className="wb-empty" data-matter-filter-empty>没有匹配的案卷。试试清空筛选。</div>
    }
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

/** 看板一行：届满日、期限名、案号、发明名称。过期必须有文字「已过期」，不能只靠颜色。 */
function DeadlineRow({ deadline, onOpenMatter }: {
  deadline: UpcomingDeadlineView
  onOpenMatter: (matterId: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={deadline.overdue ? 'wb-dl-row overdue' : 'wb-dl-row'}
      data-deadline-row={deadline.id}
      data-matter-id={deadline.matterId}
      onClick={() => onOpenMatter(deadline.matterId)}
    >
      <span className="wb-dl-date">{deadline.dueDate}</span>
      <span className="wb-dl-main">
        <span className="wb-dl-label">{deadline.label}</span>
        <span className="wb-dl-meta">{deadline.caseNumber} · {deadline.matterTitle}</span>
      </span>
      {deadline.overdue ? <span className="wb-dl-flag">已过期</span> : null}
    </button>
  )
}

function DeadlineGroup({ code, title, items, onOpenMatter }: {
  code: 'overdue' | 'due-today' | 'rest'
  title: string
  items: readonly UpcomingDeadlineView[]
  onOpenMatter: (matterId: string) => void
}): JSX.Element {
  return (
    <div className="wb-dl-group" data-deadline-group={code}>
      <div className="wb-dl-group-title">{title}</div>
      {items.map((deadline) => (
        <DeadlineRow key={deadline.id} deadline={deadline} onOpenMatter={onOpenMatter} />
      ))}
    </div>
  )
}

/**
 * 期限看板（跨案卷的"近 N 天到期"）——放在「今日」视图里。
 *
 * 为什么放今日而不是另开一个顶级页签：**期限是"今天要办的事"的一部分**。
 * 用户在今日视图的工作流是"看今天该做什么"，而"三天后要交答复"正属于这个判断；
 * 另开一页会变成"要记得去看"的另一处（决策 D5-3 的推荐口径）。
 *
 * 分组在 `deadlineBoard.ts`：已过期（服务端字段）→ 今日届满（`dueDate === todayKey`）
 * → 其余默认折叠。`todayKey` 由调用方传入，与日期面板同一日键。
 */
export function UpcomingDeadlines({ deadlines, days, todayKey, engineAvailable, onRecomputeAll, onOpenMatter, busy, expandToken = 0 }: {
  deadlines: readonly UpcomingDeadlineView[]
  days: number
  /** 面板日键（YYYY-MM-DD）。「今日届满」只跟它比相等，不在这里取时钟。 */
  todayKey: string
  /** 引擎是否可用（软探测结果）；不可用时明确说明"为什么这里没有期限"。 */
  engineAvailable: boolean
  onRecomputeAll: () => void
  onOpenMatter: (matterId: string) => void
  busy: boolean
  /**
   * 外部请求展开「其余」并滚到看板（紧迫条「期限紧迫」）。
   * 0 = 没有请求；每次点击递增。折叠本身仍是这块的本地 state。
   */
  expandToken?: number
}): JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null)
  const [restExpanded, setRestExpanded] = useState(false)
  const groups = groupUpcomingDeadlines(deadlines, todayKey)

  useEffect(() => {
    if (expandToken <= 0) return
    setRestExpanded(true)
    boardRef.current?.scrollIntoView({ block: 'start' })
  }, [expandToken])

  return (
    <div className="wb-card wb-dl-board" data-deadline-board ref={boardRef}>
      <div className="wb-matter-head">
        <h3 className="wb-matter-title">
          法定期限 · 近 {days} 天 <span className="wb-matter-count">含已过期</span>
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
            {groups.overdue.length === 0 ? null : (
              <DeadlineGroup code="overdue" title="已过期" items={groups.overdue} onOpenMatter={onOpenMatter} />
            )}
            {groups.dueToday.length === 0 ? null : (
              <DeadlineGroup code="due-today" title="今日届满" items={groups.dueToday} onOpenMatter={onOpenMatter} />
            )}
            {groups.rest.length === 0 ? null : restExpanded
              ? (
                <>
                  <DeadlineGroup code="rest" title={`近 ${days} 天其余`} items={groups.rest} onOpenMatter={onOpenMatter} />
                  <button type="button" className="wb-dl-more" data-deadline-collapse onClick={() => setRestExpanded(false)}>收起</button>
                </>
              )
              : (
                <button type="button" className="wb-dl-more" data-deadline-more onClick={() => setRestExpanded(true)}>
                  另有 {groups.rest.length} 条未展开
                </button>
              )}
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

/** 抬头摘要：案型 · 申请号 · 客户。缺的写成「—」，不把 undefined 露出去。 */
function displayOrDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : value
}

function matterHeaderSummary(matter: MatterView, dicts: readonly Dict[]): string {
  return `${dictLabel(dicts, 'matter_type', matter.matterType)} · ${displayOrDash(matter.applicationNo)} · ${displayOrDash(matter.clientId)}`
}

/**
 * 可折的一区。标题行（含原有按钮）始终在；折合时身体加 `hidden`，子树不卸载。
 * 再展开拿到的是同一份 props，不是另一份副本。
 */
function MatterSection({ id, title, count, open, onToggle, actions, children }: {
  id: MatterSectionId
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="wb-card wb-matter-section" data-matter-section={id} data-matter-open={open ? '1' : '0'}>
      <div className="wb-matter-head">
        <button type="button" className="wb-matter-fold" aria-expanded={open} data-matter-fold={id} onClick={onToggle}>
          <Icon name="chevron" />
          <span className="wb-matter-title">
            {title}
            {count === undefined ? null : <> <span className="wb-matter-count">{count}</span></>}
          </span>
        </button>
        {actions}
      </div>
      <div id={`wb-matter-section-${id}`} className="wb-matter-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

/**
 * 案卷详情：固定抬头 + 四区（字段 / 官文 / 期限 / 时间线）。
 *
 * ⚠️ **没有**任何"期限只剩 N 天"或完成度百分比 —— 那是 `patent-deadline` 的职责（决策 3 / D2），
 * 界面只显示引擎算出来的 `due_date`。完成 / 免除仍是人点的两个按钮。
 * 开合是纯 UI：默认四区都展开（空态说明要看得见）；`sectionOpen` 只覆盖显隐，不改数据。
 */
export function MatterDetail({ matter, dicts, timeline, notices, deadlines, engineAvailable, recomputeNote, onEdit, onAddNotice, onDeleteNotice, onRecompute, onSetDeadlineStatus, onSyncEvents, syncNote, busy, sectionOpen }: {
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
  /** 同步 `_matter-log.md` → 事件（阶段 6）。 */
  onSyncEvents: () => void
  /** 上次同步的回执（含"没解析出来的行"），空串 = 还没同步过。 */
  syncNote: string
  busy: boolean
  /** 覆盖某一区的开合。不传则用本组件状态（默认展开，切到另一卷重置）。 */
  sectionOpen?: Partial<MatterSectionOpen>
}): JSX.Element {
  const counts: MatterSectionCounts = {
    notices: notices.length,
    deadlines: deadlines.length,
    timeline: timeline.entries.length + timeline.undated.length,
  }
  const [sectionState, setSectionState] = useState(() => createMatterSectionState(matter.id, counts))
  const reconciled = reconcileMatterSectionState(sectionState, matter.id, counts)
  // 案卷 id 或条数变了就在这次渲染里对齐。用 effect 会多一帧把上一卷的折合套到新卷上。
  if (reconciled !== sectionState) setSectionState(reconciled)
  const open: MatterSectionOpen = sectionOpen === undefined ? reconciled.open : { ...reconciled.open, ...sectionOpen }
  const toggleSection = (id: MatterSectionId): void => {
    setSectionState((prev) => toggleMatterSection(reconcileMatterSectionState(prev, matter.id, counts), id))
  }
  return (
    <div className="wb-matter-detail" data-matter-detail={matter.caseNumber}>
      <div className="wb-matter-sticky" data-matter-sticky>
        <div className="wb-matter-head">
          <h3 className="wb-matter-title">{matter.caseNumber} · {matter.title}</h3>
          <StageBadge dicts={dicts} code={matter.stageCode} />
          <button className="wb-btn" disabled={busy} onClick={onEdit} data-matter-edit><Icon name="edit" />编辑</button>
        </div>
        <p className="wb-matter-summary" data-matter-summary>{matterHeaderSummary(matter, dicts)}</p>
      </div>
      <MatterSection id="fields" title="字段" open={open.fields} onToggle={() => toggleSection('fields')}>
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
      </MatterSection>

      <MatterSection
        id="notices"
        title="官文登记"
        count={notices.length}
        open={open.notices}
        onToggle={() => toggleSection('notices')}
        actions={<button className="wb-btn" disabled={busy} onClick={onAddNotice} data-matter-add-notice><Icon name="plus" />登记官文</button>}
      >
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
      </MatterSection>

      <MatterSection
        id="deadlines"
        title="期限"
        count={deadlines.length}
        open={open.deadlines}
        onToggle={() => toggleSection('deadlines')}
        actions={
          /**
           * 重算按钮：**只调引擎**，不在界面算任何期限（决策 3：计算权威在 patent-deadline）。
           * 引擎缺失时按钮禁用并说明原因 —— 不让用户点一个必然 409 的按钮还不知为何。
           */
          <button className="wb-btn" disabled={busy || !engineAvailable} onClick={onRecompute} data-matter-recompute>
            <Icon name="refresh" />重算期限
          </button>
        }
      >
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
      </MatterSection>

      <MatterSection
        id="timeline"
        title="时间线"
        count={timeline.entries.length}
        open={open.timeline}
        onToggle={() => toggleSection('timeline')}
        actions={
          /**
           * 「同步事件日志」（阶段 6）：把案卷目录里的 `_matter-log.md` 投影成事件。
           * 按钮文案说清方向（**读日志**），因为反方向（库 → 磁盘）是被明令禁止的：
           * 用户得能一眼看出这不会改他的案卷目录。
           */
          <button className="wb-btn" disabled={busy} onClick={onSyncEvents} data-matter-sync-events>
            <Icon name="refresh" />同步事件日志
          </button>
        }
      >
        <div className="wb-field-note" data-matter-sync-hint>
          事件的唯一事实源是案卷目录里的 <code>_matter-log.md</code>（DSH Patent 只追加写入）。
          这个按钮只**读**它并把新行补进时间线 —— 不改写文件、不改已有事件。
        </div>
        {syncNote === '' ? null : <div className="wb-field-note" data-matter-sync-note>{syncNote}</div>}
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
      </MatterSection>
    </div>
  )
}
