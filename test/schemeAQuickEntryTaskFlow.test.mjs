/**
 * 方案 A：快录默认折叠 + 任务闭环条。
 *
 * 纯函数直接断言阶段 / 摘要 / 「验收只打开原来的确认」。
 * 组件用服务端渲染看默认屏：选择器不在、摘要在、闭环条的待验收 / 已完成高亮在。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { installMinimalDom } from './support/minimalDom.mjs'

register('./support/portalShim.loader.mjs', import.meta.url)
const uninstallDom = installMinimalDom()
after(uninstallDom)

const { quickEntrySettingsSummary } = await import('../lib/client/quickEntrySettingsSummary.js')
const { taskFlowCurrent, taskFlowSteps } = await import('../lib/client/taskFlowStage.js')
const { planOpenAcceptance, openTaskAcceptance } = await import('../lib/client/taskAcceptanceOpen.js')
const { QuickEntryModal } = await import('../lib/client/components/dialogs/QuickEntryModal.js')
const { TaskDetailPane } = await import('../lib/client/components/views/TaskDetailPane.js')
const { CLEAR_SELECTION_LABEL } = await import('../lib/client/modelCapability.js')

const noop = () => undefined
const indexSource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const detailSource = readFileSync(new URL('../src/client/components/views/TaskDetailPane.tsx', import.meta.url), 'utf8')
const acceptanceSource = readFileSync(new URL('../src/client/taskAcceptanceOpen.ts', import.meta.url), 'utf8')

function draft(over = {}) {
  return {
    id: 'd1', kindCode: 'completion', sessionId: 's1', payload: { taskId: 't1', summary: '做完了' },
    statusCode: 'pending', deferredAt: null, deferCount: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const baseFlow = {
  statusCode: 'doing', archived: false, aiPolicyCode: 'consult', busy: false,
  hasChildren: false, hasExecuteSession: false, hasReviewSession: false,
}

function step(steps, id) {
  const found = steps.find((item) => item.id === id)
  assert.ok(found !== undefined, `缺少阶段 ${id}`)
  return found
}

test('快录摘要：工作区来源 · 技能数 · 角色 · 模型', () => {
  assert.equal(quickEntrySettingsSummary({
    workspaceTouched: false,
    workspaceSourceLabel: '上次手动选择',
    skillCount: 0,
    persona: { mode: 'inherit' },
    modelSelection: null,
  }), `上次手动选择 · 0 个技能 · 未指定 · ${CLEAR_SELECTION_LABEL}`)

  assert.equal(quickEntrySettingsSummary({
    workspaceTouched: true,
    workspaceSourceLabel: '上次手动选择',
    skillCount: 2,
    persona: { mode: 'none' },
    modelSelection: { provider: 'p', model: 'm', label: 'DeepSeek', effortLabel: '高' },
  }), '手动指定 · 2 个技能 · 无角色 · DeepSeek · 高')

  assert.equal(quickEntrySettingsSummary({
    workspaceTouched: false,
    workspaceSourceLabel: '使用默认工作区',
    skillCount: 1,
    persona: { mode: 'persona', personaId: 'patent-agent', sourceKey: 'bundled' },
    modelSelection: { provider: 'p', model: 'm', label: 'DeepSeek' },
  }), '使用默认工作区 · 1 个技能 · patent-agent · DeepSeek')
})

test('快录默认屏收起会话设置：选择器不在，摘要和主按钮在', () => {
  const html = renderToStaticMarkup(h(QuickEntryModal, {
    text: '', onText: noop, attachments: [], attachmentNotice: null,
    onAddFiles: noop, onRemoveAttachment: noop,
    workspace: '/tmp/work', workspaceTouched: false, workspaceSourceLabel: '上次手动选择',
    workspaceCandidates: [], workspacePlaceholder: '选一个', showForget: true,
    onWorkspaceChange: noop, onBrowse: noop, onForget: noop, followFolder: true, onFollowFolder: noop,
    skillCatalog: [], skillsLoading: false, skillsAvailable: true, skillProblem: '', selectedSkills: ['oa-reply'],
    onToggleSkill: noop, onRetrySkills: noop, persona: { mode: 'inherit' }, onPersonaChange: noop,
    runtime: {}, modelSelection: null, onModelChange: noop, modelModalityTable: new Map(),
    onModelLoaded: noop, busy: false, onError: noop, onNotice: noop, onClose: noop, onCancel: noop, onSubmit: noop,
  }))
  assert.match(html, /会话设置/)
  assert.match(html, /上次手动选择 · 1 个技能 · 未指定 · 跟随 DSH 默认模型/)
  assert.match(html, /创建澄清会话/)
  assert.match(html, /aria-expanded="false"/)
  assert.equal(html.includes('data-workspace-picker'), false)
  assert.equal(html.includes('wb-skill-picker'), false)
  assert.equal(html.includes('wb-persona-picker'), false)
  assert.equal(html.includes('wb-model-picker'), false)
  assert.match(html, /添加附件/)
})

test('闭环：未完成高亮执行；策略不是可执行时 AI 执行禁用', () => {
  const steps = taskFlowSteps(baseFlow)
  assert.equal(taskFlowCurrent(baseFlow), 'execute')
  assert.equal(step(steps, 'clarify').done, true)
  assert.equal(step(steps, 'clarify').action, null)
  assert.equal(step(steps, 'execute').current, true)
  assert.equal(step(steps, 'execute').text, 'AI 执行')
  assert.equal(step(steps, 'execute').disabled, true)
  assert.match(step(steps, 'execute').title, /可执行/)
  assert.equal(step(steps, 'accept').action, null)
  assert.equal(step(steps, 'review').action, null)

  const enabled = taskFlowSteps({ ...baseFlow, aiPolicyCode: 'execute', hasChildren: true, hasExecuteSession: true })
  assert.equal(step(enabled, 'execute').disabled, false)
  assert.equal(step(enabled, 'execute').text, 'AI 执行（父任务）')
  assert.match(step(enabled, 'execute').title, /级联完成/)
})

test('闭环：待验收高亮验收，未完成仍可点 AI 执行，且不把验收当成直接完成', () => {
  const steps = taskFlowSteps({ ...baseFlow, aiPolicyCode: 'execute', pending: { deferred: false } })
  assert.equal(taskFlowCurrent({ ...baseFlow, pending: { deferred: false } }), 'accept')
  assert.equal(step(steps, 'accept').current, true)
  assert.equal(step(steps, 'accept').action, 'accept')
  assert.equal(step(steps, 'accept').disabled, false)
  assert.equal(step(steps, 'accept').text, '验收')
  assert.match(step(steps, 'accept').title, /原来的验收确认/)
  assert.match(step(steps, 'accept').title, /不会在这里直接标完成/)
  assert.equal(step(steps, 'execute').action, 'execute')
  assert.equal(step(steps, 'execute').disabled, false)
  assert.equal(step(steps, 'execute').current, false)

  const deferred = taskFlowSteps({ ...baseFlow, pending: { deferred: true } })
  assert.match(step(deferred, 'accept').title, /暂存/)
  assert.match(step(deferred, 'accept').title, /唤回/)
})

test('闭环：已完成 / 已取消高亮复盘；复盘文案跟「有没有复盘会话」走', () => {
  const withSession = taskFlowSteps({ ...baseFlow, statusCode: 'done', hasReviewSession: true, pending: { deferred: false } })
  assert.equal(taskFlowCurrent({ ...baseFlow, statusCode: 'done' }), 'review')
  assert.equal(step(withSession, 'review').current, true)
  assert.equal(step(withSession, 'review').text, '进入复盘会话')
  assert.equal(step(withSession, 'review').action, 'review')
  assert.equal(step(withSession, 'execute').action, null, '已完成不再提供 AI 执行')
  assert.equal(step(withSession, 'accept').action, null, '已完成不再把验收当成当前动作')

  const fresh = taskFlowSteps({ ...baseFlow, statusCode: 'done', hasReviewSession: false })
  assert.equal(step(fresh, 'review').text, 'AI 复盘')

  const cancelled = taskFlowSteps({ ...baseFlow, statusCode: 'cancelled' })
  assert.equal(step(cancelled, 'review').current, true)
  assert.equal(step(cancelled, 'execute').action, null)
})

test('闭环：归档后执行 / 复盘禁用，文案要求先恢复', () => {
  const doing = taskFlowSteps({ ...baseFlow, archived: true, aiPolicyCode: 'execute' })
  assert.equal(step(doing, 'execute').disabled, true)
  assert.match(step(doing, 'execute').title, /先恢复/)
  const done = taskFlowSteps({ ...baseFlow, archived: true, statusCode: 'done' })
  assert.equal(step(done, 'review').disabled, true)
  assert.match(step(done, 'review').title, /先恢复/)
})

test('详情渲染：待验收的验收钮在、已完成只留复盘', () => {
  const calls = []
  const pane = (overTask = {}, overDetail = {}) => renderToStaticMarkup(h(TaskDetailPane, {
    selected: {
      task: {
        id: 't1', parentId: null, title: '权利要求', description: '', typeCode: 'code_impl', statusCode: 'doing',
        priorityCode: 'p2', aiPolicyCode: 'execute', dueAt: null, effectiveDueAt: null, allDay: false,
        estimatedMinutes: null, source: 'manual', workspacePath: null, effectiveWorkspacePath: null,
        archived: false, extra: {}, createdAt: '', updatedAt: '', completedAt: null, cancelledAt: null,
        ...overTask,
      },
      children: [], sessions: [], reminders: [], events: [], reviews: [],
      ...overDetail,
    },
    busy: false, dictOf: () => [], editing: false, isSessionUsable: () => true,
    detailTab: 'desc', onDetailTab: noop, subtaskParent: null, onBeginSubtask: noop, onEndSubtask: noop,
    onCreateSubtask: noop, eventsExpanded: false, onToggleEvents: noop,
    sessionPicker: { open: false, query: '', role: '', busy: false, candidates: [], linkedIds: new Set(), onOpen: noop, onClose: noop, onQuery: noop, onRole: noop, onLink: noop },
    sessionListSnapshot: { ids: [], byId: {} }, pending: null,
    onEdit: noop, onArchive: noop, onRestore: noop, onPatch: noop,
    onSaveProgress: async () => undefined, onCompleteFromProgress: async () => undefined,
    onStartAI: (mode) => { calls.push(mode) },
    onOpenAcceptance: () => { calls.push('accept') },
    onOpenSession: noop, onOpenTask: noop, onAddReminder: noop, onResetReminder: noop, notify: noop,
    taskKnowledge: [], onOpenKnowledge: noop, onSinkReview: noop,
    defaultEstimateMinutes: 25, defaultWorkspace: '',
  }))

  const liTag = (html, id) => [...html.matchAll(/<li\b[^>]*>/g)].map((item) => item[0]).find((tag) => tag.includes(`data-step="${id}"`)) ?? ''
  const pendingHtml = pane({}, { pendingCompletion: { deferred: false } })
  assert.match(liTag(pendingHtml, 'accept'), /\bcurrent\b/)
  assert.match(pendingHtml, />验收</)
  assert.match(pendingHtml, /AI 执行/)
  assert.match(pendingHtml, /AI 协助/)
  assert.match(pendingHtml, /class="wb-detail-actions assist"/)

  const doneHtml = pane(
    { statusCode: 'done' },
    { sessions: [{ session_id: 's-review', role_code: 'review' }] },
  )
  assert.match(liTag(doneHtml, 'review'), /\bcurrent\b/)
  assert.match(doneHtml, /进入复盘会话/)
  assert.equal(doneHtml.includes('AI 执行'), false)
  assert.equal(doneHtml.includes('wb-detail-actions'), false)
})

test('验收打开计划：只唤回或重开原来的确认，不确认草稿', () => {
  assert.equal(planOpenAcceptance({ taskId: '', drafts: [], pendingItems: [] }).kind, 'missing')
  const pending = planOpenAcceptance({ taskId: 't1', drafts: [draft()], pendingItems: [] })
  assert.equal(pending.kind, 'resume-pending')
  assert.equal(pending.draft.id, 'd1')

  const deferred = planOpenAcceptance({
    taskId: 't1',
    drafts: [draft({ id: 'd2', deferredAt: '2026-10-02T00:00:00.000Z' })],
    pendingItems: [],
  })
  assert.deepEqual(deferred, { kind: 'resume-deferred', draftId: 'd2' })

  const fetched = planOpenAcceptance({
    taskId: 't1',
    drafts: [draft({ id: 'other', kindCode: 'task', payload: { taskId: 't1' } })],
    pendingItems: [{ taskId: 't1', draftId: 'd9', deferred: false }],
  })
  assert.deepEqual(fetched, { kind: 'fetch', draftId: 'd9' })

  const deferredItem = planOpenAcceptance({
    taskId: 't1',
    drafts: [],
    pendingItems: [{ taskId: 't1', draftId: 'd8', deferred: true }],
  })
  assert.deepEqual(deferredItem, { kind: 'resume-deferred', draftId: 'd8' })

  assert.equal(/\/confirm|statusCode:\s*'done'|completeTask/.test(acceptanceSource), false, '打开验收的模块不许自己确认或标完成')
  assert.match(indexSource, /onOpenAcceptance=\{/)
  assert.match(indexSource, /openTaskAcceptance\(/)
  assert.doesNotMatch(detailSource, /\/api\/workbench\/drafts\/[^`]*confirm/, '详情页不自己确认草稿')
})

test('验收打开动作：fetch 到的非验收草稿不打开，暂存走唤回', async () => {
  const notes = []
  await openTaskAcceptance('t1', {
    drafts: [],
    pendingItems: [{ taskId: 't1', draftId: 'd9', deferred: false }],
    resumePending: () => { notes.push('pending') },
    resumeDeferred: () => { notes.push('deferred') },
    fetchDraft: async () => draft({ id: 'd9', kindCode: 'task' }),
    notify: (message) => { notes.push(`notify:${message}`) },
    fail: (message) => { notes.push(`fail:${message}`) },
  })
  assert.equal(notes.some((line) => line.startsWith('notify:')), true)
  assert.equal(notes.includes('pending'), false)

  notes.length = 0
  await openTaskAcceptance('t1', {
    drafts: [],
    pendingItems: [{ taskId: 't1', draftId: 'd9', deferred: false }],
    resumePending: (item) => { notes.push(`pending:${item.id}`) },
    resumeDeferred: (id) => { notes.push(`deferred:${id}`) },
    fetchDraft: async () => draft({ id: 'd9', deferredAt: '2026-10-03T00:00:00.000Z' }),
    notify: () => { notes.push('notify') },
    fail: (message) => { notes.push(`fail:${message}`) },
  })
  assert.deepEqual(notes, ['deferred:d9'])
})
