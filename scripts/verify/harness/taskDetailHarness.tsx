/**
 * H4-3 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-task-detail.mjs` 现打包）。
 *
 * 与 `calendarHarness.tsx` / `todayHarness.tsx` 同一套路：把抽出来的 `TaskDetailPane` 用
 * **真实 props** 渲染进页面，再暴露 `window.__h4` 给 CDP 驱动做交互断言。
 *
 * ## 它刻意模仿 `index.tsx` 的那几处结构
 *
 * - 页签、变更历史展开、子任务父任务、会话选择器这些 UI 状态都挂在**这里的容器**上
 *   （`TaskDetailPane` 自己一个 `useState` 都没有）——"切走再切回不丢"这条断言才测在正确的地方；
 * - 写动作一律是**回调记事件**（不发请求）：断言看到的是"视图发了什么意图、带什么参数"，
 *   与容器里那些回调真的打哪个端点无关（那是容器测试的事）。
 *
 * 可切换的开关（`setSelected` / `setEditing` / `setUsable` / `setTaskKnowledge`）
 * 用来验证每个分支与降级态都由 props 驱动。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDetailPane, type TaskDetailTab, type TaskSessionPickerState } from '../../../src/client/components/views/TaskDetailPane.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { Dict, DshSessionListState, KnowledgeEntry, Task, TaskDetail } from '../../../src/client/viewTypes.js'

function dict(kind: string, code: string, name: string): Dict {
  return { kind, code, name, config: {} }
}
const DICTS: Dict[] = [
  dict('type', 'code_impl', '代码实现'), dict('priority', 'p2', '中'), dict('status', 'doing', '进行中'),
  dict('status', 'todo', '待办'), dict('status', 'done', '已完成'), dict('ai_policy', 'consult', '可咨询'),
  dict('ai_policy', 'execute', '可执行'), dict('session_role', 'execute', '执行'), dict('session_role', 'review', '复盘'),
]
const dictOf = (kind: string): Dict[] => DICTS.filter((d) => d.kind === kind)

function task(id: string, title: string, statusCode = 'todo', over: Partial<Task> = {}): Task {
  const at = new Date(2026, 9, 3, 9, 0).toISOString()
  return {
    id, parentId: null, title, description: '', typeCode: 'code_impl', statusCode, priorityCode: 'p2',
    aiPolicyCode: 'consult', dueAt: at, effectiveDueAt: at, allDay: false, estimatedMinutes: null,
    source: 'manual', workspacePath: null, effectiveWorkspacePath: null, archived: false, extra: {},
    createdAt: at, updatedAt: at, completedAt: null, cancelledAt: null, ...over,
  }
}

/** 详情里的任务：状态 doing、AI 策略 consult（所以「AI 执行」是禁用的，可验证禁用态）。 */
const TASK = task('t1', '某案的权利要求改写', 'doing', { description: '把独权里的功能性限定去掉。' })
const CHILD_DONE = task('c1', '子任务甲', 'done')
const CHILD_TODO = task('c2', '子任务乙')

const EVENTS: Array<Record<string, unknown>> = [
  { id: 'e1', at: '2026-10-01T09:00:00.000Z', event_code: 'created', actor: '我', note: '' },
  { id: 'e2', at: '2026-10-01T10:00:00.000Z', event_code: 'status_changed', actor: '我', note: 'todo → doing' },
  { id: 'e3', at: '2026-10-02T09:00:00.000Z', event_code: 'updated', actor: '我', note: '改标题' },
  { id: 'e4', at: '2026-10-02T11:00:00.000Z', event_code: 'updated', actor: 'AI', note: '补描述' },
  { id: 'e5', at: '2026-10-03T08:00:00.000Z', event_code: 'reminder_fired', actor: '', note: '' },
  { id: 'e6', at: '2026-10-03T08:30:00.000Z', event_code: 'updated', actor: '我', note: '改估时' },
  { id: 'e7', at: '2026-10-03T09:00:00.000Z', event_code: 'updated', actor: '我', note: '最后一次' },
]

const DETAIL: TaskDetail = {
  task: TASK,
  children: [CHILD_DONE, CHILD_TODO],
  // 两条关联会话：一条宿主里还在（可打开），一条已被归档/删除（点它必须只给提示，不许裸切）。
  sessions: [{ session_id: 's-usable', role_code: 'execute' }, { session_id: 's-gone', role_code: 'review' }],
  reminders: [
    { id: 'r1', taskId: 't1', offsetMinutes: 0, methodCode: 'browser', firedAt: '2026-10-03T01:00:00.000Z', skippedAt: null, acknowledgedAt: null },
    { id: 'r2', taskId: 't1', offsetMinutes: 30, methodCode: 'browser', firedAt: null, skippedAt: null, acknowledgedAt: null },
    { id: 'r3', taskId: 't1', offsetMinutes: 1440, methodCode: 'os', firedAt: null, skippedAt: '2026-10-02T00:00:00.000Z', acknowledgedAt: null },
    { id: 'r4', taskId: 't1', offsetMinutes: 15, methodCode: 'browser', firedAt: '2026-10-01T00:00:00.000Z', skippedAt: null, acknowledgedAt: '2026-10-01T00:05:00.000Z' },
  ],
  events: EVENTS,
  reviews: [{ id: 'rv1', summary_md: '这次踩了 X 的坑：功能性限定没有容器。' }],
}

const SESSION_LIST: DshSessionListState = {
  ids: ['s-usable', 's-other'],
  byId: {
    's-usable': { id: 's-usable', displayTitle: '执行会话 A', cwd: '/Users/x/项目' },
    's-other': { id: 's-other', displayTitle: '咨询会话 B', cwd: '/Users/x/另一个项目' },
  },
}

const SINKED: KnowledgeEntry = {
  id: 'k1', title: '复盘：某案的权利要求改写', contentMd: '经验正文', kindCode: 'lesson', tags: ['复盘'],
  sourceTaskId: 't1', sourceSessionId: null, sourceReviewId: 'rv1', matterId: null, fileLink: null,
  createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
}

const calls: Array<{ name: string; args: unknown[] }> = []
const record = (name: string) => (...args: unknown[]): void => { calls.push({ name, args }) }

function Harness(): JSX.Element {
  const [showSelected, setShowSelected] = useState(true)
  const [editing, setEditing] = useState(false)
  const [archived, setArchived] = useState(false)
  const [status, setStatus] = useState('doing')
  const [aiPolicy, setAiPolicy] = useState('consult')
  const [noReviewSession, setNoReviewSession] = useState(false)
  const [detailTab, setDetailTab] = useState<TaskDetailTab>('desc')
  const [eventsExpanded, setEventsExpanded] = useState(false)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerRole, setPickerRole] = useState('execute')
  const [taskKnowledge, setTaskKnowledge] = useState<KnowledgeEntry[]>([])

  /** 与真容器一样：详情是"任务 + 关联会话"的组合，开关只是把某个变体切出来。 */
  const selected: TaskDetail | null = showSelected
    ? {
        ...DETAIL,
        sessions: noReviewSession ? DETAIL.sessions.filter((s) => s.role_code !== 'review') : DETAIL.sessions,
        task: { ...TASK, archived, statusCode: status, aiPolicyCode: aiPolicy },
      }
    : null

  const sessionPicker: TaskSessionPickerState = {
    open: pickerOpen, query: pickerQuery, role: pickerRole, busy: false,
    candidates: SESSION_LIST.ids.map((id) => SESSION_LIST.byId[id]),
    linkedIds: new Set(['s-usable']),
    onOpen: () => { setPickerQuery(''); setPickerOpen(true) },
    onClose: () => { setPickerOpen(false); setPickerQuery('') },
    onQuery: setPickerQuery,
    onRole: setPickerRole,
    onLink: record('link'),
  }

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      clearCalls: () => { calls.length = 0 },
      detailTab: () => detailTab,
      subtaskParent: () => subtaskParent === null ? null : subtaskParent.id,
      picker: () => ({ open: pickerOpen, query: pickerQuery, role: pickerRole }),
      setSelected: (next: 'task' | 'none') => setShowSelected(next === 'task'),
      setEditing: (next: boolean) => setEditing(next),
      setTaskKnowledge: (next: 'empty' | 'sinked') => setTaskKnowledge(next === 'sinked' ? [SINKED] : []),
      setArchived: (next: boolean) => setArchived(next),
      setTaskStatus: (next: string) => setStatus(next),
      setAiPolicy: (next: string) => setAiPolicy(next),
      setNoReviewSession: (next: boolean) => setNoReviewSession(next),
    }
  })

  return (
    <div id="detail-host">
      <TaskDetailPane
        selected={selected}
        busy={false}
        dictOf={dictOf}
        editing={editing}
        isSessionUsable={(sessionId) => sessionId !== 's-gone'}
        detailTab={detailTab}
        onDetailTab={setDetailTab}
        subtaskParent={subtaskParent}
        onBeginSubtask={(parent) => { setSubtaskParent(parent); setDetailTab('children') }}
        onEndSubtask={() => setSubtaskParent(null)}
        /** 与真容器同形：请求成功后容器会收起表单（这里只是记下意图 + 收起）。 */
        onCreateSubtask={(draft) => { calls.push({ name: 'createSubtask', args: [draft] }); setSubtaskParent(null) }}
        eventsExpanded={eventsExpanded}
        onToggleEvents={() => setEventsExpanded((v) => !v)}
        sessionPicker={sessionPicker}
        sessionListSnapshot={SESSION_LIST}
        pending={null}
        onEdit={record('edit')}
        onArchive={record('archive')}
        onRestore={record('restore')}
        onPatch={record('patch')}
        onSaveProgress={async (percent) => { calls.push({ name: 'saveProgress', args: [percent] }) }}
        onCompleteFromProgress={async () => { calls.push({ name: 'completeFromProgress', args: [] }) }}
        onStartAI={record('startAI')}
        onOpenSession={record('openSession')}
        onOpenTask={record('openTask')}
        onAddReminder={record('addReminder')}
        onResetReminder={record('resetReminder')}
        notify={record('notify')}
        taskKnowledge={taskKnowledge}
        onOpenKnowledge={record('openKnowledge')}
        onSinkReview={record('sinkReview')}
        defaultEstimateMinutes={25}
        defaultWorkspace="/Users/x/默认工作区"
      />
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
