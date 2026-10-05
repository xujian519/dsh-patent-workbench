/**
 * 客户端**非组件**模块冒烟与行为（2026-10-05，审计 §4.1 / v1.17.0）。
 *
 * 姊妹文件 `test/clientSmoke.test.mjs` 负责"组件真渲染一次"；这一份负责剩下那批
 * **从不被任何测试加载**的模块：
 *
 * - `api.ts` —— 全客户端唯一的 HTTP 出口（重试/错误文案全在这里，从没被测过）；
 * - `styles.ts` —— 86 KB 的内联样式表（口径：面板显隐只靠 `data-open`）；
 * - `hostShellMarkers.ts` —— 与宿主 DOM 约定的 4 个标记；
 * - `runtimeServices.ts` —— 宿主服务软探测（拿不到不许抛）；
 * - `viewTypes.ts` —— 纯类型模块（必须仍然零运行时导出）；
 * - `dayPanelModel.ts` / `useMatterImport.ts` —— 两个 hook 模块；
 * - `index.tsx` —— **入口契约**：能力不满足时"明确不启动"，且**不写任何 DOM**。
 *
 * 最后那条是本次最有价值的一条：以前它只被源码字符串扫描"保护"着 ——
 * 而字符串扫描钉不住"到底有没有真的 return 掉、有没有偷偷写 DOM"。
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

const noop = () => undefined

/**
 * 被测模块的**显式清单**（字面量 import）。
 *
 * 与 `test/clientSmoke.test.mjs` 同一条理由：拼串的 `import()` 在审计 §附录 A 的覆盖度脚本里
 * 是**看不见的边** —— 测试真跑了，覆盖度数字却一动不动（本轮实测踩到过）。
 */
const MODULES = {
  'api.js': () => import('../lib/client/api.js'),
  'contracts.js': () => import('../lib/shared/contracts.js'),
  'capabilities.js': () => import('../lib/client/capabilities.js'),
  'dayPanelModel.js': () => import('../lib/client/dayPanelModel.js'),
  'hostShellMarkers.js': () => import('../lib/client/hostShellMarkers.js'),
  'index.js': () => import('../lib/client/index.js'),
  'runtimeServices.js': () => import('../lib/client/runtimeServices.js'),
  'styles.js': () => import('../lib/client/styles.js'),
  'useMatterImport.js': () => import('../lib/client/useMatterImport.js'),
  'viewTypes.js': () => import('../lib/client/viewTypes.js'),
}

/** 取一个已经登记过的模块（清单之外的一律取不到，用例会当场报出来）。 */
async function load(relativePath) {
  const loader = MODULES[relativePath]
  assert.ok(loader !== undefined, `MODULES 里没有 ${relativePath} —— 请显式登记（覆盖度脚本靠它）`)
  return loader()
}

// ---------------------------------------------------------------------------
// api.ts：唯一 HTTP 出口
// ---------------------------------------------------------------------------

/** 用一次性的 fetch 桩跑 `api()`，返回 { calls, result|error }。 */
async function callApi(responder, path = '/api/workbench/x', init) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return responder(calls.length, url, options) }
  try {
    const { api } = await load('api.js')
    try {
      return { calls, value: await api(path, init) }
    } catch (error) {
      return { calls, error }
    }
  } finally {
    globalThis.fetch = original
  }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

test('api：2xx 返回 JSON 正文（成功路径从没被测过）', async () => {
  const { calls, value } = await callApi(() => jsonResponse({ ok: true, tasks: [1, 2] }))
  assert.deepEqual(value, { ok: true, tasks: [1, 2] })
  assert.equal(calls.length, 1, '成功时只发一次')
  assert.equal(calls[0].url, '/api/workbench/x', '路径原样交给 fetch（同源解析）')
})

test('api：非 2xx 抛后端的中文 error 文案；没有 error 字段时退化成 `HTTP <status>（<path>）`', async () => {
  const withError = await callApi(() => jsonResponse({ error: '任务不存在' }, 404))
  assert.equal(withError.calls.length, 1, 'HTTP 层错误**不重试**（重试只会给后端加压）')
  assert.equal(withError.error.message, '任务不存在')

  const withoutError = await callApi(() => jsonResponse({}, 500))
  assert.equal(withoutError.error.message, 'HTTP 500（/api/workbench/x）')

  const notJson = await callApi(() => ({ ok: false, status: 502, json: async () => { throw new Error('not json') } }))
  assert.equal(notJson.error.message, 'HTTP 502（/api/workbench/x）', '正文不是 JSON 时不能把解析错误抛给用户')
})

test('api：网络级失败重试 2 次（共 3 次）后抛中文可读原因，不再把 "Failed to fetch" 丢给用户', async () => {
  const original = globalThis.fetch
  const { api } = await load('api.js')
  let attempts = 0
  globalThis.fetch = async () => { attempts += 1; throw new TypeError('Failed to fetch') }
  try {
    await assert.rejects(
      () => api('/api/workbench/tasks/t1'),
      (error) => {
        assert.match(error.message, /^无法连接工作台服务（\/api\/workbench\/tasks\/t1）：Failed to fetch。服务可能正在重启/)
        return true
      },
    )
  } finally { globalThis.fetch = original }
  assert.equal(attempts, 3, '首试 + 两次重试（对应 RETRY_DELAYS_MS 的两档退避）')
})

test('api：非网络级失败（例如被 AbortController 取消）立刻抛出、不重试', async () => {
  const original = globalThis.fetch
  const { api } = await load('api.js')
  let attempts = 0
  globalThis.fetch = async () => { attempts += 1; throw new Error('The operation was aborted.') }
  try {
    await assert.rejects(() => api('/api/workbench/x'))
  } finally { globalThis.fetch = original }
  assert.equal(attempts, 1, '只有 TypeError + "failed to fetch" 那一类才算瞬时故障')
})

// ---------------------------------------------------------------------------
// styles.ts / hostShellMarkers.ts
// ---------------------------------------------------------------------------

test('styles：WORKBENCH_CSS 是非空的单一内联样式表，且面板显隐只由 data-open 决定', async () => {
  const { WORKBENCH_CSS } = await load('styles.js')
  assert.equal(typeof WORKBENCH_CSS, 'string')
  assert.ok(WORKBENCH_CSS.length > 10_000, `样式表只有 ${WORKBENCH_CSS.length} 字符 —— 是不是被谁截断了？`)
  assert.match(WORKBENCH_CSS, /\.wb-panel-host\[data-open='1'\]\s*\{\s*display:\s*block/, '面板显隐的唯一判据（改了就整块面板不显示）')
  assert.match(WORKBENCH_CSS, /\.wb-panel-host\s*\{[^}]*display:\s*none/, '默认不显示（开合只切 display，不卸载组件）')
  assert.match(WORKBENCH_CSS, /\.wb-panel-host > \.wb-app-scope:empty\s*\{\s*pointer-events:\s*none/, '空层不许吃点击（2026-09-13 满屏层事故的兜底）')
  assert.match(WORKBENCH_CSS, /--wb-/, '宿主 token 已经过 token 层改写（wbcss 变量）')
})

test('hostShellMarkers：与宿主 DOM 约定的 4 个标记名不许变（写错 = 量不到侧栏/标题栏）', async () => {
  const markers = await load('hostShellMarkers.js')
  // 逐字段比（模块命名空间对象不是普通对象，`deepEqual` 会因为原型不同而假红）
  assert.equal(markers.HOST_WINDOWS_TITLEBAR_ATTR, 'data-windows-titlebar')
  assert.equal(markers.HOST_SIDEBAR_COLLAPSED_ATTR, 'data-sidebar-collapsed')
  assert.equal(markers.HOST_SIDEBAR_WIDTH_VAR, '--dsh-windows-sidebar-width')
  assert.equal(markers.HOST_TITLEBAR_HEIGHT_VAR, '--dsh-windows-titlebar-height')
})

// ---------------------------------------------------------------------------
// runtimeServices.ts：宿主服务软探测
// ---------------------------------------------------------------------------

test('runtimeServices：pluginCtx 有唯一写入口，卸载后可清空', async () => {
  const { setPluginCtx, getPluginCtx } = await load('runtimeServices.js')
  const ctx = { marker: 'x' }
  setPluginCtx(ctx)
  assert.equal(getPluginCtx(), ctx)
  setPluginCtx(undefined)
  assert.equal(getPluginCtx(), undefined, '卸载时清空，避免持有已废弃的 fiber')
})

test('runtimeServices：optionalService 走 ctx.get；没有 get、或 get 抛错，都返回 undefined 而不是抛', async () => {
  const { optionalService } = await load('runtimeServices.js')
  assert.equal(optionalService(undefined, 'uiSession'), undefined)
  assert.equal(optionalService({}, 'uiSession'), undefined, 'ctx 没有 get → 拿不到就是 undefined')
  assert.equal(optionalService({ get: () => { throw new Error('cannot get ... without inject') } }, 'slots'), undefined,
    'cordis 对未声明 inject 的服务会抛 —— 软探测必须吞掉它')
  const value = { adapter: { current: 's1' } }
  assert.equal(optionalService({ get: (name) => (name === 'uiSession' ? value : undefined) }, 'uiSession'), value)
})

test('runtimeServices：safeService 对取不到 / 抛错的属性一律返回 undefined（残留回调不许把错误抛给用户）', async () => {
  const { safeService } = await load('runtimeServices.js')
  assert.equal(safeService(undefined, 'sessions'), undefined)
  assert.equal(safeService(null, 'sessions'), undefined)
  assert.equal(safeService({}, 'sessions'), undefined)
  assert.equal(safeService({ get sessions() { throw new Error('inactive context') } }, 'sessions'), undefined)
  const sessions = { list: {} }
  assert.equal(safeService({ sessions }, 'sessions'), sessions)
})

test('runtimeServices：currentSessionIdOf 新旧两条宿主通道都认，都没有时返回空串（绝不猜）', async () => {
  const { currentSessionIdOf } = await load('runtimeServices.js')
  // 旧宿主：sessions.list.getSnapshot().current
  assert.equal(currentSessionIdOf({ sessions: { list: { getSnapshot: () => ({ current: 'old-1' }) } } }), 'old-1')
  // 新宿主（0.1.7-rc.2+）：uiSession.adapter.current 是**绑定源**（`{ getSnapshot() }` 或 `{ value }`），
  // 值里有 `key` / `sessionId` / `props.sessionId` 三个可能位置（判据在 currentSession.ts，那里有单测）
  const uiSessionWith = (snapshot) => ({ get: (name) => (name === 'uiSession' ? { adapter: { current: { getSnapshot: () => snapshot } } } : undefined) })
  assert.equal(currentSessionIdOf(uiSessionWith({ key: 'new-2' })), 'new-2')
  assert.equal(currentSessionIdOf(uiSessionWith({ props: { sessionId: 'new-3' } })), 'new-3')
  assert.equal(currentSessionIdOf({ get: (name) => (name === 'uiSession' ? { adapter: { current: { value: { sessionId: 'new-4' } } } } : undefined) }), 'new-4',
    '绑定源也可能只给 `value`（没有 getSnapshot）')
  assert.equal(currentSessionIdOf(uiSessionWith({ key: undefined })), '', '缺席绑定 = 不知道，不许退化成列表第一个会话')
  assert.equal(currentSessionIdOf({}), '', '判不出来就是空串 —— 调用方按"不知道"处理')
})

// ---------------------------------------------------------------------------
// viewTypes.ts：纯类型模块
// ---------------------------------------------------------------------------

test('纯类型模块：viewTypes / contracts 零运行时导出（这是它们"从不被加载"的**唯一**原因）', async () => {
  /**
   * 审计 §附录 A 的覆盖度脚本把它们算成"从不被任何测试加载"，而 `contracts.ts` 被 4 个模块
   * `import type` 用着 —— **类型导入会被 tsc 擦掉**，产物里根本没有这条运行时边，
   * 所以它永远不可能出现在"可达图"里。这类模块的正确判据不是"被加载过"，
   * 而是"确认零运行时导出"：哪天真往里加常量/函数，这条断言立刻红。
   */
  for (const name of ['viewTypes.js', 'contracts.js']) {
    const mod = await load(name)
    assert.deepEqual(Object.keys(mod), [], `${name} 不该有运行时代码 —— 有的话它是"没人测得动的实现"，请挪到纯函数模块`)
  }
})

// ---------------------------------------------------------------------------
// 两个 hook 模块（用探针组件真跑一遍 hook）
// ---------------------------------------------------------------------------

test('dayPanelModel：useDayPanelModel 真跑一遍并给出完整模型（原来从没被加载过）', async () => {
  const { useDayPanelModel } = await load('dayPanelModel.js')
  const task = (over = {}) => ({
    id: 't1', parentId: null, title: '任务', description: '', typeCode: 'code_impl', statusCode: 'todo',
    priorityCode: 'p2', aiPolicyCode: 'consult', dueAt: null, effectiveDueAt: new Date(2026, 9, 1, 12).toISOString(),
    allDay: false, estimatedMinutes: 30, source: 'user', workspacePath: null, effectiveWorkspacePath: null,
    progressPercent: 0, archived: false, extra: {}, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', completedAt: null, cancelledAt: null, ...over,
  })
  // t1 = 今天到期（进「计划」页签）；t2 = 没有截止（进「未排期」）—— 两条判据各来一条
  const dueToday = task()
  const noDue = task({ id: 't2', title: '没有截止的任务', effectiveDueAt: null })
  let captured = null
  const Probe = () => {
    captured = useDayPanelModel({
      isTodayView: true,
      tasks: [dueToday, noDue],
      todayPlan: null,
      pickedPlan: null,
      todayCandidateRows: [{ id: 't1', title: '任务' }],
      pickedCandidateRows: [],
      todayExpanded: new Set(),
      calendarExpanded: new Set(),
      todayToggleExpanded: noop,
      calendarToggleExpanded: noop,
      todayPromptInfo: { truncated: false, notice: '' },
      pickedPromptInfo: { truncated: false, notice: '' },
      todayAnchor: '2026-10-01',
      pickedAnchor: '2026-10-01',
      pickedDate: new Date(2026, 9, 1),
      todayDate: new Date(2026, 9, 1),
    })
    return h('div', null, 'ok')
  }
  assert.equal(renderToStaticMarkup(h(Probe)), '<div>ok</div>')
  for (const key of ['day', 'isToday', 'readOnly', 'extraTabsAvailable', 'plan', 'candidateRows', 'promptInfo',
    'planTree', 'overdueTree', 'unscheduledTree', 'doneTree', 'doneContextIds', 'overdueContextIds',
    'unscheduledContextIds', 'expanded', 'onToggleExpanded', 'sourceLabelOf', 'plannedIds']) {
    assert.ok(key in captured, `模型缺 ${key}`)
  }
  assert.equal(captured.day, '2026-10-01')
  assert.ok(Array.isArray(captured.planTree) && Array.isArray(captured.overdueTree), '四棵树都必须是数组（视图直接 .map）')
  assert.ok(typeof captured.sourceLabelOf === 'function' && typeof captured.onToggleExpanded === 'function')
  /**
   * 这棵树是**接线证据**：任务没有排进今日计划（`todayPlan: null`），所以它必须出现在
   * 「未排期」里、且不在「已完成」/「计划」里。三棵树共用一份 `plainTree`（审计 §4.4 的优化），
   * 谁把它们接错（例如把 `planTree` 传给了未排期）这里就会红。
   */
  const ids = (tree) => tree.flatMap((node) => [node.task.id, ...ids(node.children)])
  assert.deepEqual(ids(captured.planTree), ['t1'], '今天到期的任务进「计划」页签（即使没被显式排进计划）')
  assert.deepEqual(ids(captured.unscheduledTree), ['t2'], '没有截止、也没排期的任务进「未排期」')
  assert.deepEqual(ids(captured.overdueTree), [], '没有逾期任务时逾期树为空')
  assert.deepEqual(ids(captured.doneTree), [], '没有已完成任务时已完成树为空')
})

test('useMatterImport：hook 真跑一遍，控制器形状与初始步骤正确', async () => {
  const { useMatterImport } = await load('useMatterImport.js')
  let captured = null
  const Probe = () => { captured = useMatterImport({ onImported: noop }); return h('div', null, 'ok') }
  assert.equal(renderToStaticMarkup(h(Probe)), '<div>ok</div>')
  assert.equal(captured.open, false, '初始不打开')
  assert.equal(captured.step, 'pick', '初始在第一步')
  assert.equal(typeof captured.root, 'string', '根目录是受控输入（空或预填，都必须是字符串）')
  assert.equal(captured.scan, null)
  assert.deepEqual(captured.rows, {})
  assert.equal(captured.result, null)
  // 键名与来源：`useMatterImport.ts` 的 MatterImportController（少一个就是界面接不上）
  for (const fn of ['openImport', 'closeImport', 'setRoot', 'setQuery', 'runScan', 'runCommit',
    'backToPick', 'toggleRow', 'setTierChecked', 'patchRow']) {
    assert.equal(typeof captured[fn], 'function', `控制器缺 ${fn}()`)
  }
})

// ---------------------------------------------------------------------------
// index.tsx：入口契约（"老宿主上明确不启动，且不写任何 DOM"）
// ---------------------------------------------------------------------------

/**
 * 能力齐全的假宿主：`ctx.get(name)` 给 slots / layout。
 *
 * 记两份账：`injected`（`slots.inject(槽位名, …)`）与 `registered`（`slots.register({ name, … })`）——
 * 槽位名是与宿主的**契约**，两处任一写错，界面表现就是"没有入口行"或"面板打不开"。
 */
function fullHost({ injected, registered } = {}) {
  const slots = {
    entriesOfSlot: (name) => [{ id: 'probe', name }],
    inject: (name, callback) => {
      injected?.push(name)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : noop
    },
    // 真实签名是**单个描述对象**（`{ id, name, inject, … }`），不是 `(name, component)`
    register: (entry) => { registered?.push(entry.name); return noop },
  }
  return {
    slots,
    ctx: {
      get: (name) => (name === 'slots' ? slots : name === 'layout' ? { selectPanel: noop } : undefined),
      on: noop, effect: noop, ineffect: noop, inject: noop,
    },
  }
}

/** 捕获 `console.error/warn/info`（插件起不来时必须留一条可读日志）。 */
function captureLogs(run) {
  const logs = []
  const original = { error: console.error, warn: console.warn, info: console.info }
  console.error = (message) => { logs.push(String(message)) }
  console.warn = (message) => { logs.push(String(message)) }
  console.info = (message) => { logs.push(String(message)) }
  try {
    return { logs, value: run() }
  } finally {
    console.error = original.error; console.warn = original.warn; console.info = original.info
  }
}

const htmlAttrNames = () => [...globalThis.document.documentElement.attributes.keys()]
const headChildren = () => globalThis.document.head.children.length

test('入口契约：index.tsx 导出 apply / inject / name，且 inject 与 capabilities 的唯一判据同源', async () => {
  const entry = await load('index.js')
  const capabilities = await load('capabilities.js')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.name, 'patent-workbench-client')
  assert.equal(entry.inject, capabilities.inject,
    'index.tsx 的 inject 是 re-export 自 capabilities —— 两处各写一份就会漂移（本仓头号 bug 类别）')
})

test('入口契约：宿主没有 slots → 明确不启动 + 可读日志 + **不写任何 DOM**', async () => {
  const entry = await load('index.js')
  const headBefore = headChildren()
  const { logs, value } = captureLogs(() => entry.apply({ get: () => undefined, on: noop }))
  assert.equal(typeof value, 'function', '不启动也要返回一个（空的）清理函数')
  assert.deepEqual(htmlAttrNames(), [], '拒绝启动时不许在 <html> 上留标记')
  assert.equal(headChildren(), headBefore, '拒绝启动时不许往 <head> 里写样式表（v1.17.0 修正：ensureStyle 移到门槛之后）')
  assert.ok(logs.some((line) => line.startsWith('[workbench] 未启动：') && line.includes('slots')), `日志里要能看出缺什么，实际：${JSON.stringify(logs)}`)
  value()
})

test('入口契约：slots 在但 layout.selectPanel 缺失 → 同样明确不启动，原因点名 selectPanel', async () => {
  const entry = await load('index.js')
  const slots = { entriesOfSlot: () => [], inject: (name, cb) => cb() ?? noop, register: () => noop }
  const { logs, value } = captureLogs(() => entry.apply({ get: (name) => (name === 'slots' ? slots : undefined), on: noop }))
  assert.equal(typeof value, 'function')
  assert.deepEqual(htmlAttrNames(), [])
  assert.ok(logs.some((line) => line.includes('layout.selectPanel')), `日志要点名缺的那一项，实际：${JSON.stringify(logs)}`)
  value()
})

test('入口契约：能力齐全 → 注册四个官方槽位、写样式与激活标记，且清理函数收得干净', async () => {
  const entry = await load('index.js')
  const injected = []
  const registered = []
  const { ctx } = fullHost({ injected, registered })
  const headBefore = headChildren()
  const { value: dispose } = captureLogs(() => entry.apply(ctx))
  /**
   * ⚠️ `apply()` 会起几个"重试到量到为止"的定时器（量侧栏宽度 / 标题栏高度）。
   * 所以**断言失败也必须走到 dispose** —— 否则这个测试文件会因为残留定时器而挂住不退出
   * （本轮实测：一条断言写错 → 整个 `node --test` 永远不返回）。这不是测试洁癖，
   * 是"一条笔误让整条链挂死"与"红一条"的区别。
   */
  try {
    assert.equal(typeof dispose, 'function')
    const expected = ['conversation.session.header.actions', 'sidebar.panellist', 'main', 'shell.overlay']
    assert.deepEqual(registered, expected, '四个槽位一个都不能少（少一个就是"面板打不开"或"没有入口行"）')
    assert.deepEqual(injected, expected, 'inject 的槽位名与 register 的必须一致（写错一处等于没注册）')
    assert.ok(headChildren() > headBefore, '启动时写入内联样式表')
    assert.ok(htmlAttrNames().includes('data-dsh-personal-workbench-official'),
      'OFFICIAL_ATTR 给 CSS 看：它决定面板内容显示在官方容器里（删掉会"打开后一片空白"）')
  } finally {
    if (typeof dispose === 'function') dispose()
  }
  assert.deepEqual(htmlAttrNames(), [], '清理时只摘自己写过的标记')
})
