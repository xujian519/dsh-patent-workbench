/**
 * 客户端组件冒烟（2026-10-05，审计 §4.1 / v1.17.0）。
 *
 * ## 这一层为什么必须有
 *
 * 审计实测：**38 个 src 模块从不被任何测试 import，其中 37 个在 `src/client/`** ——
 * 包括 11 个弹窗、6 个视图、`Modal`/`Toast`/`DraftBanner`/`ModelPicker` 这些骨架组件。
 * 那层原有的"保护"是 19 个测试文件 `readFileSync('src/client/index.tsx')` 做**源码字符串扫描**：
 * 字符串扫描能钉住"某个字面量还在"，钉不住"接线对不对"。把 props 传错、让组件 `return null`、
 * 或整段实现删掉而留下那几个被扫描的字符串 → **全仓测试照样全绿**。
 *
 * 所以这里做的是**真执行一次**：用 `react-dom/server` 渲染每个模块，
 * 断言"产出非空 HTML + 该有的关键内容在"。**不断言细节样式**（那属于实机走查）。
 *
 * ## 两个测试专用替身（都不进产品）
 *
 * 1. `test/support/portalShim.loader.mjs`：把 `createPortal` 换成"就地渲染 children" ——
 *    服务端渲染器遇到 portal 直接抛（`Target container is not a DOM element`），
 *    而本仓 11 个弹窗全靠 portal；
 * 2. `test/support/minimalDom.mjs`：最小 DOM 能力桩（属性读写 / 无副作用监听 / 内存 storage）——
 *    组件在渲染期就会碰 `document.body`、`document.documentElement`、`localStorage`。
 *
 * 口径写明：这两个替身证明的是"**代码被执行过**"，不是"DOM 行为正确"。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { installMinimalDom } from './support/minimalDom.mjs'

register('./support/portalShim.loader.mjs', import.meta.url)
const uninstallDom = installMinimalDom()
after(uninstallDom)

/** 日历 7 格 / 42 格的**真实**派生（`CalendarView` 的 `cal.weekDays`/`monthGrid` 由容器算好传入）。 */
const { weekDaysOf, monthGridOf } = await import('../lib/client/calendarView.js')

const noop = () => undefined
const iso = (days = 0) => new Date(Date.UTC(2026, 9, 1 + days)).toISOString()

const dict = (code, kind = 'type', name = code) => ({
  kind, code, name, config: {}, builtin: 1, active: 1, sortOrder: 0,
  createdAt: iso(), updatedAt: iso(),
})

const task = (over = {}) => ({
  id: 't1', parentId: null, title: '任务', description: '', typeCode: 'code_impl', statusCode: 'todo',
  priorityCode: 'p2', aiPolicyCode: 'consult', dueAt: null, effectiveDueAt: null, allDay: false,
  estimatedMinutes: 30, source: 'user', workspacePath: null, effectiveWorkspacePath: null,
  progressPercent: 0, archived: false, extra: {}, createdAt: iso(), updatedAt: iso(),
  completedAt: null, cancelledAt: null, ...over,
})

const knowledge = (over = {}) => ({
  id: 'k1', kindCode: 'lesson', title: '知识标题', contentMd: '正文', tags: ['a'],
  sourceTaskId: null, sourceSessionId: null, sourceReviewId: null, matterId: null, fileLink: null,
  createdAt: iso(), updatedAt: iso(), ...over,
})

const matter = (over = {}) => ({
  id: 'm1', caseNumber: '2026-UM-001', title: '案卷标题', matterType: 'utility', patentKind: null,
  stageCode: 'open', clientId: null, workspacePath: null, filingDate: null, extra: {},
  createdAt: iso(), updatedAt: iso(), ...over,
})

const draftView = (over = {}) => ({
  id: 'd1', kindCode: 'completion', sessionId: null, payload: {}, statusCode: 'pending',
  deferredAt: null, deferCount: 0, createdAt: iso(), updatedAt: iso(), ...over,
})

const workspaceCandidate = (path) => ({ path, label: path, source: 'recent' })

/** 任何未知成员都返回"可调用的空操作"——宿主能力只做冒烟，不在这里造第二个宿主。 */
function runtimeStub(overrides = {}) {
  return new Proxy({ ...overrides }, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined
      if (!(key in target)) target[key] = noop
      return target[key]
    },
  })
}

/** `DayPanelProps` 的最小可用形状（与 `test/dayPanelTabs.test.mjs` 同一口径，去掉 `emptyPlanAction`）。 */
function dayPanelProps(overrides = {}) {
  return {
    day: '2026-10-01',
    isToday: true,
    readOnly: false,
    extraTabsAvailable: true,
    tab: 'plan',
    onTabChange: noop,
    plan: null,
    candidateRows: [],
    promptInfo: { truncated: false, notice: '' },
    planTree: [], overdueTree: [], unscheduledTree: [], doneTree: [],
    expanded: new Set(),
    onToggleExpanded: noop,
    sourceLabelOf: () => null,
    tasks: [],
    dicts: [],
    selectedId: undefined,
    pending: null,
    childrenOf: () => undefined,
    busy: false,
    onOpen: noop,
    onSort: noop,
    onComplete: async () => undefined,
    onDefer: async () => undefined,
    onClearPlan: noop,
    report: { subTab: 'day', onSubTabChange: noop, isFuture: false, current: null, sessionActive: false, onGenerate: noop, onDelete: noop },
    ...overrides,
  }
}

/**
 * 冒烟表：`加载模块 → 取组件 → 给最小 props 渲染 → 断言非空 + 关键内容在`。
 *
 * `expect` 是"这个组件真的画出了自己的东西"的证据（不是样式断言）：
 * 取的是它自己独有的 class 或数据文本，`return null` 或没接线会立刻对不上。
 */
/**
 * 被测模块的**显式清单**（每一条都是字面量 import）。
 *
 * 为什么不用 `import(\`../lib/client/${path}\`)` 那种拼串：审计 §附录 A 的覆盖度脚本
 * 靠"字面量 import 图"算"哪些模块从不被任何测试加载"—— 拼串的边它看不见，于是真被测了
 * 也仍然算"从不被加载"（本轮实测踩到过：测试全绿、覆盖度数字一动不动）。
 * 而且显式清单本身就是"这一层覆盖了哪些模块"的账本。
 */
const MODULES = {
  'components/CalendarView.js': () => import('../lib/client/components/CalendarView.js'),
  'components/DraftBanner.js': () => import('../lib/client/components/DraftBanner.js'),
  'components/KnowledgeDraftBody.js': () => import('../lib/client/components/KnowledgeDraftBody.js'),
  'components/LocalDocModal.js': () => import('../lib/client/components/LocalDocModal.js'),
  'components/MarkdownText.js': () => import('../lib/client/components/MarkdownText.js'),
  'components/Modal.js': () => import('../lib/client/components/Modal.js'),
  'components/ModelPicker.js': () => import('../lib/client/components/ModelPicker.js'),
  'components/PersonaAdmin.js': () => import('../lib/client/components/PersonaAdmin.js'),
  'components/PersonaPicker.js': () => import('../lib/client/components/PersonaPicker.js'),
  'components/SettingsModal.js': () => import('../lib/client/components/SettingsModal.js'),
  'components/SkillPicker.js': () => import('../lib/client/components/SkillPicker.js'),
  'components/Toast.js': () => import('../lib/client/components/Toast.js'),
  'components/WorkspacePicker.js': () => import('../lib/client/components/WorkspacePicker.js'),
  'components/dialogs/DuplicatePromptModal.js': () => import('../lib/client/components/dialogs/DuplicatePromptModal.js'),
  'components/dialogs/EditTaskModal.js': () => import('../lib/client/components/dialogs/EditTaskModal.js'),
  'components/dialogs/MatterDraftModal.js': () => import('../lib/client/components/dialogs/MatterDraftModal.js'),
  'components/dialogs/MatterImportModal.js': () => import('../lib/client/components/dialogs/MatterImportModal.js'),
  'components/dialogs/NewTaskModal.js': () => import('../lib/client/components/dialogs/NewTaskModal.js'),
  'components/dialogs/NoticeDraftModal.js': () => import('../lib/client/components/dialogs/NoticeDraftModal.js'),
  'components/dialogs/PendingModal.js': () => import('../lib/client/components/dialogs/PendingModal.js'),
  'components/dialogs/PromptModal.js': () => import('../lib/client/components/dialogs/PromptModal.js'),
  'components/dialogs/QuickEntryModal.js': () => import('../lib/client/components/dialogs/QuickEntryModal.js'),
  'components/dialogs/ReminderModal.js': () => import('../lib/client/components/dialogs/ReminderModal.js'),
  'components/views/KnowledgeDetailPane.js': () => import('../lib/client/components/views/KnowledgeDetailPane.js'),
  'components/views/KnowledgeView.js': () => import('../lib/client/components/views/KnowledgeView.js'),
  'components/views/MatterPane.js': () => import('../lib/client/components/views/MatterPane.js'),
  'components/views/TaskDetailPane.js': () => import('../lib/client/components/views/TaskDetailPane.js'),
  'components/views/TasksView.js': () => import('../lib/client/components/views/TasksView.js'),
  'components/views/TodayView.js': () => import('../lib/client/components/views/TodayView.js'),
}

const CASES = [
  ['Modal', 'components/Modal.js', (m) => h(m.Modal, {
    title: '标题', onClose: noop, footer: h('div', null, '底栏'), children: h('p', null, '正文'),
  }), /wb-dialog-body[\s\S]*正文/],

  ['MarkdownText', 'components/MarkdownText.js', (m) => h(m.MarkdownText, {
    text: '# 标题\n\n正文 **加粗**\n\n```js\nconst a = 1\n```\n\n> 引用',
  }), /wb-code-block/],

  ['ToastHost', 'components/Toast.js', (m) => h(m.ToastHost, {
    items: [{ id: 1, tone: 'success', message: '已保存' }], onDismiss: noop,
  }), /已保存/],

  ['KnowledgeDraftBody', 'components/KnowledgeDraftBody.js', (m) => h(m.KnowledgeDraftBody, {
    draftId: 'd1', payload: { title: '知识标题', contentMd: '正文', kindCode: 'lesson', tags: ['a', 'b'] },
  }), /知识标题/],

  ['LocalDocModal', 'components/LocalDocModal.js', (m) => h(m.LocalDocModal, {
    open: true,
    path: '/tmp/docs',
    listing: {
      path: '/tmp/docs',
      parent: '/tmp',
      home: '/tmp',
      roots: [{ label: 'home', path: '/tmp' }],
      entries: [{ name: 'a.md', path: '/tmp/docs/a.md', isDirectory: false, isFile: true, hidden: false }],
    },
    loading: false, error: null, busy: false, mode: 'file',
    onPathChange: noop, onClose: noop, onNavigate: noop, onPick: noop, onPickAndSummarize: noop, onSummarize: noop,
  }), /a\.md/],

  ['CalendarView', 'components/CalendarView.js', (m) => h(m.CalendarView, {
    now: new Date(2026, 9, 1), picked: new Date(2026, 9, 1), onPickDay: noop,
    // 游标用真实的纯函数造（`calendarView.ts` 本身也被这条用例经手一次）
    cal: {
      cursor: new Date(2026, 9, 1), mode: 'month',
      weekDays: weekDaysOf(new Date(2026, 9, 1)), monthGrid: monthGridOf(new Date(2026, 9, 1)),
      setMode: noop, shift: noop,
    },
    dayPanelProps: dayPanelProps(),
  }), /wb-cal-nav[\s\S]*2026年10月/],

  ['DraftBanner', 'components/DraftBanner.js', (m) => h(m.DraftBanner, {
    draft: draftView({ payload: { taskId: 't1', summary: '本次完成总结' } }),
    onDone: noop, runtime: runtimeStub(), closePanel: noop,
    kindName: () => '验收申请', isSessionUsable: () => true,
    onConfirmed: noop, onClose: noop, onDismissed: noop, onNotice: noop, onProblems: noop,
  }), /本次完成总结|验收申请/],

  ['ModelPicker', 'components/ModelPicker.js', (m) => h(m.ModelPicker, {
    runtime: runtimeStub({ modelDirectory: { use: () => ({ state: { status: 'ready', groups: [] } }) } }),
    value: null, onChange: noop, modalityTable: new Map(), disabled: false, onError: noop, onLoaded: noop,
  }), /wb-model-picker/],

  ['PersonaAdmin', 'components/PersonaAdmin.js', (m) => h(m.PersonaAdmin, { saving: false }), /★ 已收藏/],
  ['PersonaPicker', 'components/PersonaPicker.js', (m) => h(m.PersonaPicker, {
    value: { mode: 'inherit' }, onChange: noop, disabled: false, onError: noop,
  }), /未指定（沿用该会话原有角色）/],

  ['SettingsModal', 'components/SettingsModal.js', (m) => h(m.SettingsModal, {
    settings: { desktopNotify: false, planIncludeOverdue: false, defaultEstimateMinutes: 30, defaultWorkspace: '' },
    onSettingsChange: noop, onSaveSettings: async () => undefined, saving: false,
    notifyPermission: 'default', onRequestNotifyPermission: noop, onSendTestNotification: noop,
    reminderPolicy: null, onReminderPolicyChange: noop, onSaveReminderPolicy: async () => undefined,
    reminderChannel: null, reminderOptions: null, reminderBusy: false,
    onSelectTarget: noop, onSaveTarget: async () => undefined, onRefreshChannel: async () => undefined,
    onSendTestMessage: async () => undefined,
    dicts: [dict('code_impl')], dictKind: 'type', onDictKindChange: noop,
    dictForm: null, onDictFormChange: noop, dictEditCode: null, onDictEditCodeChange: noop,
    dictError: null, onDictErrorChange: noop,
    onSaveDictionary: async () => undefined, onToggleDictionary: async () => undefined, onDeleteDictionary: async () => undefined,
    recallLog: { lines: [], loading: false, error: null }, onRefreshRecallLog: noop,
    recallSessionOff: [], onRecallSessionOffChange: noop, onClose: noop,
  }), /wb-settings-nav[\s\S]*AI 会话工作区/],

  ['SkillPicker', 'components/SkillPicker.js', (m) => h(m.SkillPicker, {
    catalog: [{ name: 'patent-matter', description: '案卷' }], loading: false, available: true, problem: '',
    selected: ['patent-matter'], onToggle: noop, onRetry: noop, disabled: false,
  }), /patent-matter/],

  ['WorkspacePicker', 'components/WorkspacePicker.js', (m) => h(m.WorkspacePicker, {
    value: '/tmp/work', touched: true, sourceLabel: '上次用过', candidates: [workspaceCandidate('/tmp/work')],
    onChange: noop, onBrowse: noop,
  }), /\/tmp\/work/],

  ['DuplicatePromptModal', 'components/dialogs/DuplicatePromptModal.js', (m) => h(m.DuplicatePromptModal, {
    existingTitle: '已存在同名任务', existingTaskId: 't1', sameDescription: true, sameWorkspace: false,
    onClose: noop, onReuseExisting: noop,
  }), /已存在同名任务/],

  ['EditTaskModal', 'components/dialogs/EditTaskModal.js', (m) => h(m.EditTaskModal, {
    draft: {
      title: '编辑中的任务标题', description: '', typeCode: 'code_impl', priorityCode: 'p2', statusCode: 'todo',
      aiPolicyCode: 'consult', dueLocal: '', workspacePath: '', parentId: '', estimatedMinutes: '30', allDay: false,
    },
    onChange: noop,
    typeOptions: [dict('code_impl')], priorityOptions: [dict('p2', 'priority')], statusOptions: [dict('todo', 'status')],
    aiPolicyOptions: [dict('consult', 'ai_policy')], defaultEstimateMinutes: 30,
    workspaceCandidates: [workspaceCandidate('/tmp/work')], workspacePlaceholder: '选一个',
    parentCandidates: [{ id: 'p1', title: '父任务', depth: 0 }],
    busy: false, onBrowse: noop, onClose: noop, onSave: noop,
  }), /编辑中的任务标题/],

  ['MatterDraftModal', 'components/dialogs/MatterDraftModal.js', (m) => h(m.MatterDraftModal, {
    title: '新建案卷', draft: { caseNumber: '2026-UM-001', title: '案卷' }, onChange: noop,
    matterTypeOptions: [dict('utility', 'matter_type')], patentKindOptions: [dict('um', 'patent_kind')],
    stageOptions: [dict('open', 'stage')], busy: false, onClose: noop, onSubmit: noop,
  }), /2026-UM-001/],

  ['MatterImportModal（第一步）', 'components/dialogs/MatterImportModal.js', (m) => h(m.MatterImportModal, {
    step: 'pick', root: '/Users/x/工作', busy: false, error: '', scan: null, rows: {}, query: '',
    result: null, summary: { checked: 0, importable: 0, incomplete: 0 },
    matterTypeOptions: [dict('utility', 'matter_type')],
    onRootChange: noop, onQueryChange: noop, onScan: noop, onCommit: noop, onBack: noop,
    onToggleRow: noop, onSetTier: noop, onPatchRow: noop, onClose: noop,
  }), /wb-dialog-body[\s\S]*\/Users\/x\/工作/],

  ['MatterImportModal（候选步）', 'components/dialogs/MatterImportModal.js', (m) => h(m.MatterImportModal, {
    step: 'review', root: '/Users/x/工作', busy: false, error: '', query: '',
    scan: {
      ok: true, root: '/Users/x/工作',
      scanned: { truncated: false, skippedSymlinks: [] },
      tiers: { high: 1, mid: 0, rest: 0 },
      candidates: [{
        relPath: '甲案', path: '/Users/x/工作/甲案', name: '甲案', tier: 'high',
        evidence: ['含 _matter-log.md'], caseNumber: '2026-UM-002', title: '甲案',
        applicationNo: '', matterType: 'utility',
      }],
    },
    rows: { '甲案': { checked: true, caseNumber: '2026-UM-002', title: '甲案', matterType: 'utility' } },
    result: null, summary: { checked: 1, importable: 1, incomplete: 0 },
    matterTypeOptions: [dict('utility', 'matter_type')],
    onRootChange: noop, onQueryChange: noop, onScan: noop, onCommit: noop, onBack: noop,
    onToggleRow: noop, onSetTier: noop, onPatchRow: noop, onClose: noop,
  }), /甲案/],

  ['MatterImportModal（回执步）', 'components/dialogs/MatterImportModal.js', (m) => h(m.MatterImportModal, {
    step: 'done', root: '/Users/x/工作', busy: false, error: '', scan: null, rows: {}, query: '',
    // 回执步**不列已建案卷**（只说条数与逐条失败原因，见 DoneStep）—— 两个分支都走到
    result: {
      ok: true, created: 1,
      failed: [{ index: 2, caseNumber: '2026-UM-003', title: '乙案', reason: '案号已存在' }],
      matters: [{ id: 'm1', caseNumber: '2026-UM-002', title: '甲案', workspacePath: '/Users/x/工作/甲案' }],
    },
    summary: { checked: 2, importable: 1, incomplete: 1 },
    matterTypeOptions: [dict('utility', 'matter_type')],
    onRootChange: noop, onQueryChange: noop, onScan: noop, onCommit: noop, onBack: noop,
    onToggleRow: noop, onSetTier: noop, onPatchRow: noop, onClose: noop,
  }), /已建 <b>1<\/b> 个案卷[\s\S]*2026-UM-003[\s\S]*案号已存在/],

  ['NewTaskModal', 'components/dialogs/NewTaskModal.js', (m) => h(m.NewTaskModal, {
    typeOptions: [dict('code_impl')], priorityOptions: [dict('p2', 'priority')], statusOptions: [dict('todo', 'status')],
    defaultEstimateMinutes: 30, workspace: '/tmp/work', onWorkspaceChange: noop,
    workspaceCandidates: [workspaceCandidate('/tmp/work')], workspacePlaceholder: '选一个',
    busy: false, onBrowse: noop, onClose: noop, onSubmit: noop,
  }), /wb-new-task-form/],

  ['NoticeDraftModal', 'components/dialogs/NoticeDraftModal.js', (m) => h(m.NoticeDraftModal, {
    draft: { noticeKind: 'oa', dispatchDate: '2026-10-01' }, onChange: noop,
    noticeKindOptions: [dict('oa', 'notice_kind')], deliveryModeOptions: [dict('email', 'delivery_mode')],
    busy: false, onClose: noop, onSubmit: noop,
  }), /wb-notice-form/],

  ['PendingModal', 'components/dialogs/PendingModal.js', (m) => h(m.PendingModal, {
    pendingCount: 1,
    pendingDrafts: [draftView({ id: 'd2', kindCode: 'task', payload: { title: '待确认任务草稿' } })],
    deferredDrafts: [draftView({ id: 'd3', kindCode: 'completion', deferredAt: iso(), payload: { summary: '已暂存的验收' } })],
    reminders: [{ reminderId: 'r1', title: '到期任务', dueAt: iso() }],
    activeDraftOpen: false, onResumePending: noop, onResumeDeferred: noop, onAckReminder: noop, onClose: noop,
  }), /待确认任务草稿|已暂存的验收|到期任务/],

  ['PromptModal', 'components/dialogs/PromptModal.js', (m) => h(m.PromptModal, {
    title: '发起 AI 会话', value: '帮我拆解这个任务', onValue: noop,
    skillCatalog: [{ name: 'patent-matter', description: '案卷' }], skillsLoading: false, skillsAvailable: true, skillProblem: '',
    selectedSkills: [], onToggleSkill: noop, onRetrySkills: noop,
    persona: { mode: 'inherit' }, onPersonaChange: noop,
    runtime: runtimeStub(), modelSelection: null, onModelChange: noop, modelModalityTable: new Map(),
    onModelLoaded: noop, busy: false, onError: noop, onNotice: noop, onCancel: noop, onConfirm: noop,
  }), /帮我拆解这个任务/],

  ['QuickEntryModal', 'components/dialogs/QuickEntryModal.js', (m) => h(m.QuickEntryModal, {
    text: '新建一个任务', onText: noop, attachments: [], attachmentNotice: null,
    onAddFiles: noop, onRemoveAttachment: noop,
    workspace: '/tmp/work', workspaceTouched: true, workspaceSourceLabel: '上次用过',
    workspaceCandidates: [workspaceCandidate('/tmp/work')], workspacePlaceholder: '选一个', showForget: false,
    onWorkspaceChange: noop, onBrowse: noop, onForget: noop, followFolder: true, onFollowFolder: noop,
    skillCatalog: [], skillsLoading: false, skillsAvailable: true, skillProblem: '', selectedSkills: [],
    onToggleSkill: noop, onRetrySkills: noop, persona: { mode: 'inherit' }, onPersonaChange: noop,
    runtime: runtimeStub(), modelSelection: null, onModelChange: noop, modelModalityTable: new Map(),
    onModelLoaded: noop, busy: false, onError: noop, onNotice: noop, onClose: noop, onCancel: noop, onSubmit: noop,
  }), /新建一个任务/],

  ['ReminderModal', 'components/dialogs/ReminderModal.js', (m) => h(m.ReminderModal, {
    reminders: [{ reminderId: 'r1', title: '到期任务', dueAt: iso() }], onClose: noop, onAck: noop,
  }), /到期任务/],

  ['TodayView', 'components/views/TodayView.js', (m) => h(m.TodayView, {
    stats: { overdue: 1, todayDue: 2, doing: 3, total: 9 },
    deadlines: [{
      id: 'dl1', matterId: 'm1', caseNumber: '2026-UM-001', matterTitle: '甲案',
      label: '答复期限', dueDate: '2026-10-02', status: 'open', overdue: false,
    }],
    upcomingDays: 14, engineAvailable: true, onRecomputeAll: noop, busy: false,
    dayPanelProps: dayPanelProps(), onQuickEntry: noop, onNewTask: noop,
  }), /wb-stats[\s\S]*逾期[\s\S]*wb-dl-board[\s\S]*答复期限/],

  ['TasksView', 'components/views/TasksView.js', (m) => h(m.TasksView, {
    filter: { keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] }, filterEmpty: true,
    statusOptions: [dict('todo', 'status')], priorityOptions: [dict('p2', 'priority')],
    openFilter: null, onToggleFilter: noop, onCloseFilter: noop, onKeyword: noop,
    onStatusCodes: noop, onPriorityCodes: noop,
    typeTabs: [{ key: 'all', label: '全部', count: 1 }], onSelectType: noop,
    sortKey: 'priority', onSortKey: noop, sortDir: 'asc', onToggleSortDir: noop,
    tree: [{ task: task({ title: '列表里的任务标题' }), children: [] }], onClearFilter: noop,
    archivedMode: false, onToggleArchived: noop, taskCount: 1, archivedCount: 0,
    expanded: new Set(), toggleExpanded: noop, dicts: [dict('code_impl')],
    onOpenTask: noop, selectedTaskId: undefined, pending: null, childrenOf: () => undefined,
  }), /列表里的任务标题/],

  ['KnowledgeView', 'components/views/KnowledgeView.js', (m) => h(m.KnowledgeView, {
    entries: [knowledge()], dicts: [dict('lesson', 'knowledge_kind')],
    page: {
      groups: [{ name: '今天', items: [{ id: 'k1', title: '知识标题', body: '知识标题 正文', tags: ['a'], updatedAt: iso(), createdAt: iso(), kindCode: 'lesson' }] }],
      pageCount: 1, total: 1, pageTotal: 1, page: 0, rangeStart: 0, rangeEnd: 1,
      tagCounts: [{ tag: 'a', count: 1 }], tabCounts: { all: 1, lesson: 1 },
    },
    filters: { keyword: '', kinds: ['all'], tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 20 },
    selectedId: undefined, busy: false, onChange: noop, onNew: noop, onOpenEntry: noop, onSummarizeDoc: noop,
  }), /知识标题/],

  ['KnowledgeDetailPane（空）', 'components/views/KnowledgeDetailPane.js', (m) => h(m.KnowledgeDetailPane, {
    draft: null, editing: false, selected: null, dictOf: () => [], matters: [],
    taskTitleOf: () => '', onDraftChange: noop, onSubmit: noop, onCancel: noop, onEdit: noop,
    onDelete: noop, onOpenFile: noop, onOpenTask: noop,
  }), /← 从左侧选择或新建知识条目/],

  ['KnowledgeDetailPane（编辑中）', 'components/views/KnowledgeDetailPane.js', (m) => h(m.KnowledgeDetailPane, {
    draft: { title: '草稿标题', contentMd: '正文', kindCode: 'lesson', tags: 'a,b', sourceTaskId: '', sourceReviewId: '', matterId: '', fileLink: '' },
    editing: true, selected: null, dictOf: () => [dict('lesson', 'knowledge_kind')], matters: [matter()],
    taskTitleOf: () => '', onDraftChange: noop, onSubmit: noop, onCancel: noop, onEdit: noop,
    onDelete: noop, onOpenFile: noop, onOpenTask: noop,
  }), /草稿标题/],

  ['TaskDetailPane（未选中）', 'components/views/TaskDetailPane.js', (m) => h(m.TaskDetailPane, {
    selected: null, busy: false, dictOf: () => [], editing: false, isSessionUsable: () => true,
    detailTab: 'detail', onDetailTab: noop, subtaskParent: null, onBeginSubtask: noop, onEndSubtask: noop,
    onCreateSubtask: noop, eventsExpanded: false, onToggleEvents: noop,
    sessionPicker: { open: false, query: '', role: '', busy: false, candidates: [], linkedIds: new Set(), onOpen: noop, onClose: noop, onQuery: noop, onRole: noop, onLink: noop },
    sessionListSnapshot: { ids: [], byId: {} }, pending: null,
    onEdit: noop, onArchive: noop, onRestore: noop, onPatch: noop, onSaveProgress: async () => undefined,
    onCompleteFromProgress: async () => undefined, onStartAI: noop, onOpenSession: noop, onOpenTask: noop,
    onAddReminder: noop, onResetReminder: noop, notify: noop, taskKnowledge: [], onOpenKnowledge: noop,
    onSinkReview: noop, defaultEstimateMinutes: 30, defaultWorkspace: '/tmp/work',
  }), /← 从左侧选择一个任务查看详情/],

  ['TaskDetailPane（选中任务）', 'components/views/TaskDetailPane.js', (m) => h(m.TaskDetailPane, {
    selected: { task: task({ title: '被选中的任务' }), children: [], sessions: [], reminders: [], events: [], reviews: [] },
    busy: false, dictOf: () => [dict('code_impl')], editing: false, isSessionUsable: () => true,
    detailTab: 'detail', onDetailTab: noop, subtaskParent: null, onBeginSubtask: noop, onEndSubtask: noop,
    onCreateSubtask: noop, eventsExpanded: false, onToggleEvents: noop,
    sessionPicker: { open: false, query: '', role: '', busy: false, candidates: [], linkedIds: new Set(), onOpen: noop, onClose: noop, onQuery: noop, onRole: noop, onLink: noop },
    sessionListSnapshot: { ids: [], byId: {} }, pending: null,
    onEdit: noop, onArchive: noop, onRestore: noop, onPatch: noop, onSaveProgress: async () => undefined,
    onCompleteFromProgress: async () => undefined, onStartAI: noop, onOpenSession: noop, onOpenTask: noop,
    onAddReminder: noop, onResetReminder: noop, notify: noop, taskKnowledge: [knowledge()], onOpenKnowledge: noop,
    onSinkReview: noop, defaultEstimateMinutes: 30, defaultWorkspace: '/tmp/work',
  }), /被选中的任务/],

  ['MatterPane（未选中）', 'components/views/MatterPane.js', (m) => h(m.MatterPane, {
    matters: [matter()], dicts: [dict('utility', 'matter_type')], selectedMatterId: null, selectedMatter: null,
    timeline: null, notices: [], deadlines: [], engineAvailable: true, recomputeNote: '', syncNote: '', busy: false,
    onOpen: noop, onCreate: noop, onImport: noop, onEdit: noop, onAddNotice: noop, onDeleteNotice: noop,
    onRecompute: noop, onSetDeadlineStatus: noop, onSyncEvents: noop,
  }), /2026-UM-001/],

  ['MatterPane（选中案卷）', 'components/views/MatterPane.js', (m) => h(m.MatterPane, {
    matters: [matter()], dicts: [dict('utility', 'matter_type')], selectedMatterId: 'm1', selectedMatter: matter(),
    timeline: { entries: [{ id: 'e1', kind: 'event', date: '2026-10-01', title: '承办', detail: '' }], undated: [] },
    notices: [{ id: 'n1', noticeId: null, matterId: 'm1', noticeKind: 'oa', dispatchDate: '2026-10-01', deliveryMode: null, deliveryDate: null, note: null, createdAt: iso(), updatedAt: iso() }],
    deadlines: [{ id: 'dl1', matterId: 'm1', kindCode: 'reply', label: '答复期限', dueAt: iso(30), statusCode: 'open', engineCode: 'ep', basis: '专利法', createdAt: iso(), updatedAt: iso() }],
    engineAvailable: true, recomputeNote: '', syncNote: '', busy: false,
    onOpen: noop, onCreate: noop, onImport: noop, onEdit: noop, onAddNotice: noop, onDeleteNotice: noop,
    onRecompute: noop, onSetDeadlineStatus: noop, onSyncEvents: noop,
  }), /wb-matter-detail[\s\S]*答复期限/],
]

for (const [name, modulePath, build, expect] of CASES) {
  test(`冒烟：${name} 真渲染出内容`, async () => {
    const loader = MODULES[modulePath]
    assert.ok(loader !== undefined, `MODULES 里没有 ${modulePath} —— 用例与清单必须一一对应`)
    const mod = await loader()
    const html = renderToStaticMarkup(build(mod))
    assert.ok(typeof html === 'string' && html.length > 0, `${name} 渲染出空 HTML —— 组件被 return null 掉，或 props 接线断了`)
    assert.match(html, expect, `${name} 的内容里找不到 ${expect}（组件执行了但没画出该有的东西）`)
  })
}

test('反向保护：冒烟用例数与覆盖模块数不许回落（有人把渲染改回源码扫描就会红）', () => {
  /**
   * 审计时（2026-10-05）有 **37 个客户端模块从不被任何测试加载**，本文件把其中
   * **22 个组件模块**（含 11 个弹窗、6 个视图骨架）变成"真渲染过一次"。
   * 这条断言防的是"有人嫌麻烦把某条用例删掉" —— 删一条就要来这里改数字。
   */
  assert.ok(CASES.length >= 34, `冒烟用例只剩 ${CASES.length} 条（基线 34）—— 少了就是有模块又回到"从不被加载"`)
  const covered = new Set(CASES.map(([, modulePath]) => modulePath))
  assert.ok(covered.size >= 22, `覆盖到的组件模块只剩 ${covered.size} 个（基线 22）`)
})
