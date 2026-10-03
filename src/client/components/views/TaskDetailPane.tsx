/**
 * 任务详情（H4-3）：右栏「选中一个任务」时要画的一切 —— 任务卡、进度卡、动作行，
 * 以及描述 / 子任务 / 会话 / 记录四个页签。
 *
 * ## 边界（为什么这份 props 长）
 *
 * 右栏今天**常驻挂载**，所以它用到的那些 UI 状态（当前页签、会话选择器、变更历史是否展开）
 * 在容器里活得比任何视图都久。按 H4 plan §3 的规则，这类"切走再切回要不要保持"的状态
 * **不许**搬进视图组件 —— 等 H4-4 把知识详情也拆成独立视图、右栏开始按 `view` 分支挂载时，
 * 搬进来的状态会在切页签时被重置，那是一次没人要求的行为回归。
 * 于是它们逐个作为 props 进来：**长是刻意的，显式的长好过隐式的共享**。
 *
 * ## 视图只发意图，写动作留在容器
 *
 * 本组件**不发任何请求**：编辑 / 归档 / 恢复 / 改状态 / 存进度 / 完成任务 / 加提醒 / 关联会话
 * 都是回调解意图（`onPatch` / `onSaveProgress` / `onCreateSubtask` …），由容器决定打哪个端点、
 * 用什么文案。这样"这个界面会写哪些端点"在容器里一眼可数。
 *
 * ## 这里的判定都在别处
 *
 * - 进度条画不画、画多少、徽标写什么 → `taskProgressView()`（本组件不写 `statusCode === 'done' ? …`）；
 * - 会话能不能复用 → 容器注入的 `isSessionUsable`（它要读宿主快照，本组件读不到）；
 * - 字典码 → 中文名 → 注入的 `dictOf`；时间格式 → `format.ts`。
 */
import { Icon } from '../Icon.js'
import { Badge } from '../TaskList.js'
import { MarkdownText } from '../MarkdownText.js'
import { TaskProgress } from '../TaskProgress.js'
import { taskProgressView } from '../../taskProgressView.js'
import { eventIcon, eventLabel, fmtTime, roleLabel, shortId } from '../../format.js'
import type { Dict, DshSessionListState, DshSessionSummary, KnowledgeEntry, Task, TaskDetail } from '../../viewTypes.js'

/** 详情页签（容器持有，见文件头"为什么这份 props 长"）。 */
export type TaskDetailTab = 'desc' | 'children' | 'sessions' | 'records'

/** 新建子任务表单折出来的字段（视图读表单，容器发请求）。 */
export interface SubtaskDraft {
  title: string
  typeCode: string
  priorityCode: string
  /** `datetime-local` 的本地串已转成 ISO；`null` = 没有截止时间。 */
  dueAt: string | null
}

/** 复盘记录 → 知识库的沉淀入口（知识草稿的形状由容器管，本组件不碰）。 */
export interface ReviewSinkInput {
  reviewId: string
  summaryMd: string
}

/** 「添加已有对话」选择器：状态在容器（`query` / `role` 还被容器自己的候选过滤与关联复用）。 */
export interface TaskSessionPickerState {
  open: boolean
  query: string
  role: string
  busy: boolean
  candidates: readonly DshSessionSummary[]
  linkedIds: ReadonlySet<string>
  /** 打开选择器（容器顺手清空搜索串）。 */
  onOpen: () => void
  onClose: () => void
  onQuery: (query: string) => void
  onRole: (role: string) => void
  onLink: (sessionId: string) => void
}

export interface TaskDetailPaneProps {
  /** 选中任务的详情；`null` = 还没选（画占位）。 */
  selected: TaskDetail | null
  busy: boolean
  /** 字典码 → 该 kind 的全部词条（容器注入的唯一查表口）。 */
  dictOf: (kind: string) => Dict[]
  /** 编辑表单是否正占着这一栏（编辑时下面的动作行与页签整体让位）。 */
  editing: boolean
  /** 会话是否还能复用（读宿主快照；容器注入）。 */
  isSessionUsable: (sessionId: string) => boolean
  detailTab: TaskDetailTab
  onDetailTab: (tab: TaskDetailTab) => void
  subtaskParent: Task | null
  /** 点「子任务」：容器记下父任务并切到子任务页签（两件事一起做，见容器注释）。 */
  onBeginSubtask: (task: Task) => void
  onEndSubtask: () => void
  onCreateSubtask: (draft: SubtaskDraft) => void
  eventsExpanded: boolean
  onToggleEvents: () => void
  sessionPicker: TaskSessionPickerState
  sessionListSnapshot: DshSessionListState
  /** 列表那次**共用查询**折出来的待验收投影（`null` = 服务端不支持）。 */
  pending: ReadonlyMap<string, { deferred: boolean }> | null
  /** 编辑（容器负责把任务摊成编辑草稿）。 */
  onEdit: () => void
  onArchive: () => void
  /** 恢复已归档任务（归档是任务级的动作，恢复同样走容器）。 */
  onRestore: () => void
  onPatch: (patch: Record<string, unknown>) => void
  /** 返回 Promise：`TaskProgress` 靠它把"正在保存"的态撑到落库回执（别改成 void）。 */
  onSaveProgress: (percent: number) => Promise<void>
  onCompleteFromProgress: () => Promise<void>
  /** AI 动作（`review` 含"复用已有复盘会话"的判据，所以由容器按 mode 决定做什么）。 */
  onStartAI: (mode: 'review' | 'execute' | 'consult' | 'breakdown') => void
  onOpenSession: (sessionId: string) => void
  onOpenTask: (task: Task) => void
  onAddReminder: (offsetMinutes: number) => void
  onResetReminder: (reminderId: string) => void
  /** 界面级告知（容器接管通知渠道）。 */
  notify: (message: string) => void
  /** 本任务已沉淀的知识条目（用来判断"已沉淀"还是"可沉淀"）。 */
  taskKnowledge: readonly KnowledgeEntry[]
  /** 打开已沉淀的知识条目。 */
  onOpenKnowledge: (entry: KnowledgeEntry) => void
  /** 把这条复盘沉淀为经验（容器拼草稿并切到知识库）。 */
  onSinkReview: (review: ReviewSinkInput) => void
  /** 未单独设置耗时时展示的默认值（与"按默认 N 分钟"同一份来源）。 */
  defaultEstimateMinutes: number
  defaultWorkspace: string
}

export function TaskDetailPane(props: TaskDetailPaneProps): JSX.Element {
  const {
    selected, busy, dictOf, editing, isSessionUsable, detailTab, onDetailTab,
    subtaskParent, onBeginSubtask, onEndSubtask, onCreateSubtask, eventsExpanded, onToggleEvents,
    sessionPicker, sessionListSnapshot, pending, onEdit, onArchive, onRestore, onPatch,
    onSaveProgress, onCompleteFromProgress, onStartAI, onOpenSession, onOpenTask,
    onAddReminder, onResetReminder, notify, taskKnowledge, onOpenKnowledge, onSinkReview,
    defaultEstimateMinutes, defaultWorkspace,
  } = props

  if (selected === null) {
    return (
      <div className="wb-empty">← 从左侧选择一个任务查看详情<br /><span style={{ fontSize: 12 }}>AI 澄清/咨询/拆解会跳转到官方会话区，完成后回这里确认草稿</span></div>
    )
  }
  const task = selected.task

  return (
    <>
      <div className="wb-card">
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h4 style={{ flex: 1, margin: 0 }}>{task.title}</h4>
            {/**
              * 「归档」移到详情页**右上角**（2026-10-01 用户要求）。
              * 原来它在下面那排 AI 动作按钮的最右边，一个低频且不可逆的动作
              * 混在高频动作里，还把那一行挤到换行（用户截图："归档掉到第二行"）。
              * 判定与确认弹窗一个字没改，只是位置和视觉权重变了：
              * 这里是 secondary + 危险色，与「编辑」并列。
              */}
            {!task.archived && (
              <button
                className="wb-btn"
                style={{ color: '#e0645c', borderColor: 'color-mix(in srgb, #e0645c 45%, transparent)' }}
                title="归档后任务会从工作台列表隐藏（其子任务也会一并从列表隐藏），可在列表页「查看归档」中恢复"
                onClick={onArchive}
              ><Icon name="archive" />归档</button>
            )}
            {!task.archived && <button className="wb-btn" onClick={onEdit}><Icon name="edit" />编辑</button>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            <Badge dict={dictOf('type')} code={task.typeCode} />
            <Badge dict={dictOf('priority')} code={task.priorityCode} />
            <Badge dict={dictOf('status')} code={task.statusCode} />
          </div>
          {!task.archived && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0 4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>状态
                <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={task.statusCode} onChange={(e) => onPatch({ statusCode: e.target.value })}>
                  {dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>AI 策略
                <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={task.aiPolicyCode} onChange={(e) => onPatch({ aiPolicyCode: e.target.value })}>
                  {dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                </select>
              </label>
            </div>
          )}
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>截止：{task.effectiveDueAt === null ? '无' : fmtTime(task.effectiveDueAt)}{task.dueAt === null && task.effectiveDueAt !== null ? '（继承父任务）' : ''}</div>
          {/* 预计耗时（v1.15.1）：参与当日候选排序，所以未填时必须说清"按默认算"。 */}
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>预计耗时：{task.estimatedMinutes === null ? `默认 ${defaultEstimateMinutes} 分钟（未单独设置）` : `${task.estimatedMinutes} 分钟`}{task.allDay ? ' · 全天' : ''}</div>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>AI 工作区：{task.effectiveWorkspacePath ?? (defaultWorkspace || '默认工作区未设置')}{task.workspacePath === null && task.effectiveWorkspacePath !== null ? '（继承父任务）' : ''}</div>
        </>
      </div>

      {/**
        * 进度卡（T1/D04）：**独立组件** `TaskProgress`，列表/详情/计划行共用同一份。
        * 判定全部来自纯模块 `taskProgressView()`——这里不写 `statusCode === 'done' ?` 这类分支。
        * `pending` 传的是列表那次**共用查询**折出来的 Map（避免 N+1），
        * 但详情页以自身 `pendingCompletion` 为准（它是最新的单任务读取）。
        */}
      <TaskProgress
        view={taskProgressView({
          task,
          children: selected.children,
          pending: selected.pendingCompletion !== undefined
            ? new Map([[task.id, selected.pendingCompletion]])
            : pending,
        })}
        onSave={task.statusCode === 'done' || task.statusCode === 'cancelled' || task.archived
          ? undefined
          : (percent) => onSaveProgress(percent)}
        onComplete={task.statusCode === 'done' || task.statusCode === 'cancelled' || task.archived
          ? undefined
          : () => onCompleteFromProgress()}
      />

      {!editing && (
        <>
          <div className="wb-detail-actions">
            {task.archived ? (
              <button className="wb-btn primary" onClick={onRestore}><Icon name="refresh" />恢复任务</button>
            ) : (
              <>
                {task.statusCode === 'done' || task.statusCode === 'cancelled'
                  ? <button className="wb-btn" disabled={busy} onClick={() => onStartAI('review')}><Icon name="report" />{selected.sessions.some((x) => x.role_code === 'review') ? '进入复盘会话' : 'AI 复盘'}</button>
                  : <>
                      {/**
                        * ⚠️ **文案精简**（2026-10-01 用户要求）。
                        *
                        * 原先把"父任务 / 新会话续作 / 需可执行"三件事全部拼进按钮文字，
                        * 父任务上就成了「AI 执行（父任务）（新会话续作）（需可执行）」——
                        * 一行放不下，整个动作行被挤到换行。用户明确要求精简。
                        *
                        * 精简口径：**按钮上只留"能不能点、点了干什么"**，
                        * 其余全放进 `title`（悬停可看，不占宽度）。唯一保留在文字里的是
                        * 「父任务」——它是**动作语义的一部分**（验收会级联子任务），
                        * 不适合只藏在悬停里。
                        */}
                      <button
                        className="wb-btn primary"
                        disabled={busy || task.aiPolicyCode !== 'execute'}
                        title={task.aiPolicyCode !== 'execute'
                          ? '请先在“AI 策略”里开启「可执行」'
                          : selected.children.length > 0
                            ? '执行父任务：验收通过后未完成子任务会级联完成；所有子节点完成后父节点也会自动完成'
                            : selected.sessions.some((x) => x.role_code === 'execute')
                              ? '新建执行会话并携带此前会话提示'
                              : '开始执行'}
                        onClick={() => onStartAI('execute')}
                      ><Icon name="ai" />AI 执行{selected.children.length > 0 ? '（父任务）' : ''}</button>
                      <button className="wb-btn" disabled={busy} title="就这个任务向 AI 咨询（不改任务状态）" onClick={() => onStartAI('consult')}><Icon name="ai" />AI 协助</button>
                      <button className="wb-btn" disabled={busy} title="让 AI 把任务拆成子任务提案（确认后才建）" onClick={() => onStartAI('breakdown')}><Icon name="ai" />AI 拆解</button>
                      <button className="wb-btn" title="手动添加子任务" onClick={() => onBeginSubtask(task)}><Icon name="subtask" />子任务</button>
                    </>}
                {/* 「归档」已移到详情页右上角（与「编辑」并列），见本卡片标题那一行 */}
              </>
            )}
          </div>
          {/**
            * ⚠️ 这里原本有一段独立提示（"执行父任务：验收通过后未完成子任务会级联完成…" /
            * "执行会话完成后，AI 会提交验收申请…"）。用户要求删除：它独占一行高度，
            * 而**同样的语义已经在两处说清**——
            * ① 点「完成任务」时的确认弹窗（`completeTaskFromProgress` 的 window.confirm 写明级联）；
            * ② 「AI 执行」按钮的 `title`（"执行父任务：验收通过后未完成子任务会级联完成"）。
            * 删掉它不丢语义，只是不再重复占高度。
            */}
          <div className="wb-detail-tabs">
            <button className={`wb-detail-tab ${detailTab === 'desc' ? 'on' : ''}`} onClick={() => onDetailTab('desc')}>描述</button>
            <button className={`wb-detail-tab ${detailTab === 'children' ? 'on' : ''}`} onClick={() => onDetailTab('children')}>子任务<span className="count">{selected.children.length}</span></button>
            <button className={`wb-detail-tab ${detailTab === 'sessions' ? 'on' : ''}`} onClick={() => onDetailTab('sessions')}>会话<span className="count">{selected.sessions.length}</span></button>
            <button className={`wb-detail-tab ${detailTab === 'records' ? 'on' : ''}`} onClick={() => onDetailTab('records')}>记录<span className="count">{selected.reminders.length + (selected.reviews?.length ?? 0) + (selected.events?.length ?? 0)}</span></button>
          </div>

          {detailTab === 'desc' && (
            <div className="wb-card">
              <MarkdownText text={task.description || '（无描述）'} />
            </div>
          )}

          {detailTab === 'children' && (
            <>
              {subtaskParent !== null && subtaskParent.id === task.id && (
                <form className="wb-form wb-form-panel" onSubmit={(e) => {
                  e.preventDefault()
                  const form = new FormData(e.currentTarget)
                  const title = String(form.get('title') ?? '').trim()
                  if (title === '') return
                  const due = String(form.get('due') ?? '')
                  onCreateSubtask({
                    title,
                    typeCode: String(form.get('type') ?? subtaskParent.typeCode),
                    priorityCode: String(form.get('priority') ?? subtaskParent.priorityCode),
                    dueAt: due === '' ? null : new Date(due).toISOString(),
                  })
                }}>
                  <h4 className="full" style={{ margin: 0 }}><Icon name="subtask" />新建子任务（父任务：{subtaskParent.title}）</h4>
                  <label className="full">标题<input name="title" required placeholder="子任务标题" /></label>
                  <label>类型<select name="type" defaultValue={subtaskParent.typeCode}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>优先级<select name="priority" defaultValue={subtaskParent.priorityCode}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>截止时间<input name="due" type="datetime-local" /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit">保存子任务</button><button className="wb-btn" type="button" onClick={() => onEndSubtask()}>取消</button></div>
                </form>
              )}
              <div className="wb-card">
                <h4>子任务（{selected.children.length}）{selected.children.length > 0 ? ` · ${selected.children.filter((c) => c.statusCode === 'done').length}/${selected.children.length} 已完成` : ''}</h4>
                {selected.children.map((c) => <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}><Badge dict={dictOf('status')} code={c.statusCode} /> <span onClick={() => onOpenTask(c)} style={{ cursor: 'pointer' }}>{c.title}</span></div>)}
                {selected.children.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>无</div>}
              </div>
            </>
          )}

          {detailTab === 'sessions' && (
            <div className="wb-card">
              <h4>关联会话（{selected.sessions.length}）<span style={{ flex: 1 }} />{!sessionPicker.open && <button className="wb-btn" onClick={() => sessionPicker.onOpen()}><Icon name="plus" />添加已有对话</button>}</h4>
              {selected.sessions.length > 0
                ? (
                    <div className="wb-session-list">
                      {selected.sessions.map((s) => {
                        const sid = typeof s.session_id === 'string' ? s.session_id : ''
                        const role = String(s.role_code ?? '')
                        const sessionInfo = sessionListSnapshot.byId[sid]
                        const name = sessionInfo?.displayTitle ?? shortId(sid)
                        return (
                          <button key={`${sid}-${role}`} className="wb-session-row" onClick={() => {
                            if (sid === '') return
                            /** 会话页签的行来自历史关联：那条会话可能已被归档或删除，裸切只会静默失败。 */
                            if (!isSessionUsable(sid)) { notify('这条会话已被归档或已删除，无法打开'); return }
                            onOpenSession(sid)
                          }} title={roleLabel(role)}>
                            <span className="wb-session-role">{roleLabel(role)}</span>
                            <span className="wb-session-name">{name}</span>
                            <span className="wb-session-open">打开 ↗</span>
                          </button>
                        )
                      })}
                    </div>
                  )
                : <div className="wb-empty">暂无关联会话；点击“添加已有对话”关联，或在任务上启动 AI 会话自动关联。</div>}
              {sessionPicker.open && (
                <div className="wb-session-picker">
                  <div className="wb-session-picker-bar">
                    <input className="wb-session-search" placeholder="搜索会话名称 / 工作区" value={sessionPicker.query} onChange={(e) => sessionPicker.onQuery(e.target.value)} autoFocus />
                    <select className="wb-session-role-select" value={sessionPicker.role} onChange={(e) => sessionPicker.onRole(e.target.value)}>
                      {dictOf('session_role').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                    </select>
                    <button className="wb-btn" onClick={() => sessionPicker.onClose()}>取消</button>
                  </div>
                  <div className="wb-session-picker-list">
                    {sessionPicker.candidates.length > 0
                      ? sessionPicker.candidates.map((item) => {
                          const linked = sessionPicker.linkedIds.has(item.id)
                          return (
                            <button key={item.id} className="wb-session-option" disabled={sessionPicker.busy || linked} onClick={() => sessionPicker.onLink(item.id)}>
                              <span className="wb-session-name">{item.displayTitle}</span>
                              {item.cwd !== undefined && <span className="wb-session-cwd">{item.cwd.split(/[\\/]/).filter(Boolean).pop() ?? item.cwd}</span>}
                              <span className="wb-session-add">{linked ? '已关联' : '添加'}</span>
                            </button>
                          )
                        })
                      : <div className="wb-empty">没有找到可添加的会话</div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {detailTab === 'records' && (
            <>
              <div className="wb-card">
                <h4>提醒（{selected.reminders.length}）</h4>
                {selected.reminders.map((r) => {
                  // 三种终态分开显示：已送达 / 已跳过（太旧）/ 用户已确认 —— 原先把它们都塞在 fired_at 里
                  const ackAt = r.acknowledgedAt ?? null
                  const skipAt = r.skippedAt ?? null
                  const state = ackAt !== null
                    ? `已确认 ${fmtTime(ackAt)}`
                    : skipAt !== null
                      ? '已跳过（超出补发窗口）'
                      : r.firedAt === null
                        ? '未触发'
                        : `已送达 ${fmtTime(r.firedAt)}`
                  const settled = ackAt !== null || skipAt !== null || r.firedAt !== null
                  return (
                    <div key={r.id} style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <Icon name="bell" size={13} />
                      {r.offsetMinutes === 0 ? '准时（截止时间）' : `提前 ${r.offsetMinutes} 分钟`} · {r.methodCode === 'os' ? '系统通知' : '页面/桌面通知'} · {state}
                      {settled && <button className="wb-btn" style={{ padding: '1px 7px', fontSize: 11 }} title="清掉终态、回到未处理，到点会再提醒一次" onClick={() => onResetReminder(r.id)}>重新武装</button>}
                    </div>
                  )
                })}
                {task.effectiveDueAt === null
                  ? <div style={{ fontSize: 12, color: '#999' }}>任务还没有截止时间，请先在详情里设置截止时间，再添加提醒。</div>
                  : task.statusCode === 'done' || task.statusCode === 'cancelled'
                    ? <div style={{ fontSize: 12, color: '#999' }}>已完成/已取消的任务不再提醒。</div>
                    : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {[{ offset: 0, label: '准时' }, { offset: 15, label: '提前15分' }, { offset: 30, label: '提前30分' }, { offset: 60, label: '提前1小时' }, { offset: 1440, label: '提前1天' }].map((item) => (
                          <button key={item.offset} className="wb-btn" disabled={busy} onClick={() => onAddReminder(item.offset)}>{item.label}</button>
                        ))}
                      </div>
                    )}
                <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>到提醒时间后：页内横幅 + 桌面通知（设置中授权）。超出补发窗口（默认 24 小时）的提醒会自动标为「已跳过」；任何一条只要显示为已送达 / 已跳过 / 已确认，都可以点「重新武装」让它重新提醒。</div>
              </div>
              <div className="wb-card">
                <h4>复盘记录（{selected.reviews?.length ?? 0}）</h4>
                {(selected.reviews ?? []).map((rv, i) => {
                  const reviewId = String(rv.id ?? '')
                  const existingKnowledge = taskKnowledge.find((entry) => entry.sourceReviewId === reviewId)
                  return (
                    <div key={String(rv.id ?? i)} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--wb-border-soft)' }}>
                      <MarkdownText text={String(rv.summary_md ?? '')} />
                      {existingKnowledge !== undefined
                        ? <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => onOpenKnowledge(existingKnowledge)}><Icon name="book" />✅ 已沉淀，打开知识条目</button>
                        : <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => onSinkReview({ reviewId, summaryMd: String(rv.summary_md ?? '') })}><Icon name="book" />💡 沉淀为经验</button>}
                    </div>
                  )
                })}
                {(selected.reviews?.length ?? 0) === 0 && <div style={{ fontSize: 12, color: '#999' }}>暂无复盘；已完成任务可用“AI 复盘”。</div>}
              </div>
              <div className="wb-card">
                <h4>变更历史（{selected.events?.length ?? 0}）</h4>
                {(() => {
                  const events = selected.events ?? []
                  const shown = eventsExpanded ? events : events.slice(-5).reverse()
                  let lastDate = ''
                  return (
                    <>
                      {shown.map((ev, i) => {
                        const at = String(ev.at ?? '')
                        const dateKey = at.slice(0, 10)
                        const time = at.slice(11, 16)
                        const code = String(ev.event_code ?? '')
                        const actor = String(ev.actor ?? '')
                        const note = typeof ev.note === 'string' ? ev.note : ''
                        const isNewDate = dateKey !== lastDate
                        lastDate = dateKey
                        return (
                          <div key={String(ev.id ?? i)}>
                            {isNewDate && <div className="wb-event-group-date">{dateKey}</div>}
                            <div className="wb-event-row">
                              <span className="wb-event-icon">{eventIcon(code)}</span>
                              <div className="wb-event-main">
                                <div className="wb-event-title">{eventLabel(code)}{actor !== '' ? ` · ${actor}` : ''}</div>
                                {note !== '' && <div className="wb-event-meta">{note}</div>}
                                <div className="wb-event-meta">{time}</div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      {events.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>暂无变更记录。</div>}
                      {events.length > 5 && (
                        <button className="wb-btn" style={{ marginTop: 8 }} onClick={() => onToggleEvents()}>
                          {eventsExpanded ? '收起' : `展开全部（${events.length} 条）`}
                        </button>
                      )}
                    </>
                  )
                })()}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
