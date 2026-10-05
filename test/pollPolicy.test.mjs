/**
 * 客户端轮询门控（审计 §3.2 / v1.17.0）。
 *
 * 改动前 `WorkbenchApp` 里是两个**无条件**的 `setInterval`：面板关着、标签页在后台
 * 照样按 5 s / 15 s 跑（稳态 36–52 请求/分钟），而且每 5 秒都会因为"新对象身份"必然重渲染。
 *
 * 这一份测试钉两件事：
 *
 * 1. **判据表**：`pollPolicy.ts` 的四个纯函数 + `startPolling` 的调度行为（假时钟，
 *    不依赖浏览器），包括"降档不停机""看得见的那一刻补一轮""重链该停就停"；
 * 2. **接线**：节奏只能来自 `pollPolicy`，容器里不许再有裸定时器；轮询/刷新里的
 *    `setState` 必须做值比较短路（否则 5 秒一次的重渲染会悄悄回来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  POLL_LIVE_MS, POLL_IDLE_MS, POLL_HIDDEN_MS, REFRESH_LIVE_MS,
  pollDelayMs, refreshDelayMs, readPollInputs, sameJson, keepIfEqual, startPolling,
} from '../lib/client/pollPolicy.js'
import { ACTIVE_ATTR } from '../lib/client/constants.js'

const INDEX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const POLICY = readFileSync(new URL('../src/client/pollPolicy.ts', import.meta.url), 'utf8')

/**
 * 剥注释后再扫（`test/reminderWiring.test.mjs` 的同一做法，理由也一样）：
 * 这两份源码的注释里**逐字写着改动前的 `setInterval(...)`** 作为反例，
 * 不剥就会把"解释"当成"实现"。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

/** 与 `test/workbenchAppBudget.test.mjs` 同一口径的本体切片（`^function WorkbenchApp` → 第一个 `^}`）。 */
function workbenchAppBody() {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((line) => line.startsWith('function WorkbenchApp'))
  assert.notEqual(start, -1, 'index.tsx 里找不到 WorkbenchApp')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('}'))
  assert.notEqual(end, -1, 'WorkbenchApp 找不到收尾的 `}`')
  return lines.slice(start, end + 1).join('\n')
}

/** 假时钟：只认显式推进，顺便记下"下一次排到什么时候"。 */
function makeClock() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id },
    clearTimeoutFn: (id) => { pending.delete(id) },
    /** 尚未触发的排期（毫秒，相对现在）。 */
    delays: () => [...pending.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]))
        if (due.length === 0) break
        const [id, entry] = due[0]
        pending.delete(id)
        now = entry.at
        entry.fn()
        await flush()
      }
      now = target
    },
  }
}

/** 冲掉微任务链（`startPolling` 里每条链都是 promise 串联）。 */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** 假 document：可见性 + 面板显隐属性，都靠测试显式改。 */
function makeDoc({ visible = true, panelOpen = false } = {}) {
  const attrs = new Set(panelOpen ? [ACTIVE_ATTR] : [])
  const asked = []
  let listener = null
  return {
    asked,
    unsubscribed: 0,
    doc: {
      visibilityState: visible ? 'visible' : 'hidden',
      documentElement: { hasAttribute: (name) => { asked.push(name); return attrs.has(name) } },
      addEventListener: (type, fn) => { if (type === 'visibilitychange') listener = fn },
      removeEventListener: (type) => { if (type === 'visibilitychange') listener = null },
    },
    setPanelOpen(on) { if (on) attrs.add(ACTIVE_ATTR); else attrs.delete(ACTIVE_ATTR) },
    setVisible(on) { this.doc.visibilityState = on ? 'visible' : 'hidden' },
    notify: () => listener?.(),
  }
}

/** 起一个被计数的轮询。返回计数与停止函数。 */
function startCase(options = {}) {
  const clock = makeClock()
  const target = makeDoc(options)
  const calls = { tick: 0, refresh: 0, unsubscribed: 0 }
  const stop = startPolling(
    {
      doc: target.doc,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      subscribeStateChange: (listener) => {
        target.doc.addEventListener('visibilitychange', listener)
        return () => { target.unsubscribed += 1; target.doc.removeEventListener('visibilitychange', listener) }
      },
    },
    {
      tick: async () => { calls.tick += 1; if (options.tickThrows === true) throw new Error('boom') },
      refresh: async () => { calls.refresh += 1 },
    },
  )
  return { clock, target, calls, stop }
}

test('判据表：可见性 × 面板开合 → 轻轮询 5 s / 15 s / 60 s', () => {
  assert.equal(pollDelayMs({ visible: true, panelOpen: true }), POLL_LIVE_MS)
  assert.equal(pollDelayMs({ visible: true, panelOpen: false }), POLL_IDLE_MS)
  assert.equal(pollDelayMs({ visible: false, panelOpen: true }), POLL_HIDDEN_MS)
  assert.equal(pollDelayMs({ visible: false, panelOpen: false }), POLL_HIDDEN_MS)
  assert.equal(POLL_LIVE_MS, 5_000, '看得见 + 开着 = 原来的节奏，不许偷偷变慢')
  assert.equal(REFRESH_LIVE_MS, 30_000, '全量刷新从 15 s 放宽到 30 s —— 这个数就是"少一半"的出处')
})

test('判据表：重刷新只在"看得见 + 面板开着"时按周期跑，其余返回 null', () => {
  assert.equal(refreshDelayMs({ visible: true, panelOpen: true }), REFRESH_LIVE_MS)
  assert.equal(refreshDelayMs({ visible: true, panelOpen: false }), null)
  assert.equal(refreshDelayMs({ visible: false, panelOpen: true }), null)
  assert.equal(refreshDelayMs({ visible: false, panelOpen: false }), null)
})

test('readPollInputs：面板态读的是 ACTIVE_ATTR（唯一投影），不是别处猜的值', () => {
  const { doc, asked } = makeDoc({ panelOpen: true })
  assert.deepEqual(readPollInputs(doc), { visible: true, panelOpen: true })
  assert.ok(asked.includes(ACTIVE_ATTR), `必须是 <html> 上的 ${ACTIVE_ATTR}`)
  const closed = makeDoc({ panelOpen: false })
  assert.equal(readPollInputs(closed.doc).panelOpen, false)
})

test('readPollInputs：visibilityState 取不到时按"可见"处理（fail open，退回改动前的行为）', () => {
  assert.deepEqual(readPollInputs(undefined), { visible: true, panelOpen: false })
  assert.equal(readPollInputs({}).visible, true)
  assert.equal(readPollInputs({ visibilityState: 'hidden' }).visible, false)
  assert.equal(readPollInputs({ visibilityState: 'prerender' }).visible, false, '预渲染不算可见')
})

test('sameJson / keepIfEqual：内容相同就保住原引用（这是"不再每 5 秒重渲染"的全部机制）', () => {
  const a = [{ id: 't1', title: '甲', nested: { x: [1, 2] } }]
  const b = [{ id: 't1', title: '甲', nested: { x: [1, 2] } }]
  assert.notEqual(a, b, '前提：JSON.parse 出来的两份是新身份')
  assert.ok(sameJson(a, b), '逐字段相同就算相同')
  assert.equal(keepIfEqual(a, b), a, '相同 → 返回 prev（React 据此 bail out）')
  assert.notEqual(keepIfEqual(a, [{ id: 't1', title: '乙' }]), a, '有变 → 返回 next')
  assert.equal(keepIfEqual(null, null), null)
  assert.equal(keepIfEqual(undefined, null), null)
  // 序列化失败（循环引用）时保守返回 false —— 宁可多渲染一次，也不要假相等
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(sameJson(cyclic, cyclic), true, '同一个引用先被 Object.is 短路')
  assert.equal(sameJson(cyclic, { self: {} }), false, '循环引用比不出来 → 判为不相等')
  const next = { self: {} }
  assert.equal(keepIfEqual(cyclic, next), next, '不相等 → 用 next（宁可多渲染一次，不能丢更新）')
})

test('调度：面板关着（看得见）→ 轻轮询降档到 15 s，重刷新**一次都不跑**', async () => {
  const { clock, calls } = startCase({ visible: true, panelOpen: false })
  await flush()
  assert.equal(calls.tick, 1, '起步立刻来一次轻轮询（与改动前一致）')
  assert.deepEqual(clock.delays(), [POLL_IDLE_MS], '下一条轻轮询排在 15 s，不是 5 s')
  await clock.advance(600_000)
  // 10 分钟 = 41 次轻轮询（t=0 那次 + 每 15 s 一次）
  assert.equal(calls.tick, 41, `10 分钟 41 次轻轮询，实际 ${calls.tick}`)
  assert.equal(calls.refresh, 0, '面板关着时**一个重请求都不发**（改动前是 4 次/分钟）')
})

test('调度：标签页在后台 → 轻轮询退到 60 s/档，重刷新不跑', async () => {
  const { clock, calls } = startCase({ visible: false, panelOpen: true })
  await flush()
  await clock.advance(600_000)
  assert.equal(calls.tick, 11, `10 分钟 11 次（t=0 + 每 60 s），实际 ${calls.tick}`)
  assert.equal(calls.refresh, 0)
})

test('调度：看得见 + 面板开着 → 轻 5 s、重 30 s，两条链各自重排（短的不会顶掉长的）', async () => {
  const { clock, calls } = startCase({ visible: true, panelOpen: true })
  await flush()
  assert.equal(calls.tick, 1)
  assert.deepEqual(clock.delays(), [POLL_LIVE_MS, REFRESH_LIVE_MS].sort((a, b) => a - b))
  await clock.advance(600_000)
  assert.equal(calls.tick, 121, `10 分钟 121 次轻轮询（5 s 一次），实际 ${calls.tick}`)
  assert.equal(calls.refresh, 20, `10 分钟 20 次重刷新（t=30 s 起每 30 s 一次），实际 ${calls.refresh}`)
})

test('调度：面板由关到开 → 立刻补一轮轻 + 一轮重（"看得见的那一刻必须是最新的"）', async () => {
  const { clock, target, calls } = startCase({ visible: true, panelOpen: false })
  await flush()
  await clock.advance(20_000)
  const tickBefore = calls.tick
  assert.equal(calls.refresh, 0)
  target.setPanelOpen(true)
  target.notify()
  await flush()
  assert.equal(calls.tick, tickBefore + 1, '开面板立刻一次轻轮询（不等下一档）')
  assert.equal(calls.refresh, 1, '开面板立刻一次重刷新')
  assert.deepEqual(clock.delays(), [POLL_LIVE_MS, REFRESH_LIVE_MS].sort((a, b) => a - b), '并按新状态重排')
})

test('调度：由后台回前台（面板开着）→ 同样立刻补一轮', async () => {
  const { clock, target, calls } = startCase({ visible: false, panelOpen: true })
  await flush()
  await clock.advance(120_000)
  const tickBefore = calls.tick
  target.setVisible(true)
  target.notify()
  await flush()
  assert.equal(calls.tick, tickBefore + 1)
  assert.equal(calls.refresh, 1)
})

test('调度：面板关掉**不**触发补刷（只在"变成看得见"时补，避免状态抖动时反复打服务端）', async () => {
  const { target, calls } = startCase({ visible: true, panelOpen: true })
  await flush()
  const tickBefore = calls.tick
  target.setPanelOpen(false)
  target.notify()
  await flush()
  assert.equal(calls.tick, tickBefore, '关面板不补刷')
  assert.equal(calls.refresh, 0, '重链也停了（起步时排的那次到点后被判为"不需要"，不再往下排）')
})

test('调度：停止后不再有任何调用，且解订阅（组件卸载/重挂不许留第二个循环）', async () => {
  const { clock, target, calls, stop } = startCase({ visible: true, panelOpen: true })
  await flush()
  stop()
  const after = { ...calls }
  await clock.advance(600_000)
  assert.deepEqual(calls, after, '停止后一次调用都不许有')
  assert.equal(target.unsubscribed, 1, '必须解订阅（否则重挂会留下第二个监听者）')
})

test('调度：轮询回调抛错不会让链停摆（否则一次网络抖动 = 再也不轮询）', async () => {
  const { clock, calls } = startCase({ visible: true, panelOpen: false, tickThrows: true })
  await flush()
  await clock.advance(60_000)
  assert.ok(calls.tick >= 4, `抛错后仍应继续排期，实际 ${calls.tick} 次`)
})

test('调度：默认订阅会同时盯 visibilitychange 与 ACTIVE_ATTR（漏一个就等于漏一半门控）', async () => {
  const observed = []
  class FakeObserver {
    constructor(listener) { this.listener = listener }
    observe(node, options) { observed.push(options); this.node = node }
    disconnect() { this.observed = false }
  }
  const previous = globalThis.MutationObserver
  globalThis.MutationObserver = FakeObserver
  try {
    const clock = makeClock()
    const target = makeDoc({ visible: true, panelOpen: false })
    const calls = { tick: 0, refresh: 0 }
    const stop = startPolling(
      { doc: target.doc, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn },
      { tick: async () => { calls.tick += 1 }, refresh: async () => { calls.refresh += 1 } },
    )
    await flush()
    assert.equal(observed.length, 1, '应当挂上属性观察器')
    assert.deepEqual(observed[0].attributeFilter, [ACTIVE_ATTR])
    assert.equal(observed[0].attributes, true)
    // 事件腿：visibilitychange 直接触发；属性腿：观察器回调触发
    target.setPanelOpen(true)
    target.notify()
    await flush()
    assert.equal(calls.tick, 2, 'visibilitychange 这条腿通')
    assert.equal(calls.refresh, 1)
    stop()
  } finally {
    globalThis.MutationObserver = previous
  }
})

test('接线：容器里不许再有裸定时器，节奏只能来自 pollPolicy', () => {
  const body = stripComments(workbenchAppBody())
  assert.equal((body.match(/setInterval/g) ?? []).length, 0, 'WorkbenchApp 里不许再出现 setInterval（节奏必须由 pollPolicy 的判据表决定）')
  assert.equal((body.match(/startPolling\(/g) ?? []).length, 1, '轮询必须经 startPolling 单点启动')
  assert.equal((stripComments(POLICY).match(/setInterval/g) ?? []).length, 0, 'pollPolicy 里也不能用 setInterval（固定周期无法按状态降档）')
  assert.match(POLICY, /import \{ ACTIVE_ATTR \} from '\.\/constants\.js'/, '面板态必须读 ACTIVE_ATTR 这一个来源')
})

test('sameJson / keepIfEqual：`ignore` 只作用于顶层键（bootstrap 的服务端时间戳）', () => {
  const a = { ok: true, now: '2026-10-05T14:51:16.760Z', stats: { total: 14 }, dictionaries: [] }
  const b = { ok: true, now: '2026-10-05T14:51:19.058Z', stats: { total: 14 }, dictionaries: [] }
  assert.equal(sameJson(a, b), false, '不排 now 时确实是"变了"（这正是短路永不生效的原因）')
  assert.equal(sameJson(a, b, ['now']), true)
  assert.equal(keepIfEqual(a, b, ['now']), a, '排掉 now → 保住原引用，不重渲染')
  // 真正的数据变了必须照旧更新（不许被 ignore 连带吞掉）
  const changed = { ...b, stats: { total: 15 } }
  assert.equal(keepIfEqual(a, changed, ['now']), changed, 'stats 变了就必须给新值')
  // 嵌套同名键不受影响（ignore 只作用顶层，语义好解释）
  assert.equal(sameJson({ now: 1, inner: { now: 1 } }, { now: 2, inner: { now: 2 } }, ['now']), false)
})

test('接线：bootstrap 的短路必须带上 BOOTSTRAP_VOLATILE_KEYS（否则短路形同虚设）', () => {
  const body = stripComments(workbenchAppBody())
  assert.match(body, /setBootstrap\(\(prev\) => keepIfEqual\(prev, boot, BOOTSTRAP_VOLATILE_KEYS\)\)/,
    'bootstrap 每轮都带上会变的 now（实测），不带忽略键清单的话这里一次也省不掉')
})

test('接线：轮询/刷新里的 setState 一律做值比较短路（否则"每 5 秒重渲染"会悄悄回来）', () => {
  const body = stripComments(workbenchAppBody())
  const names = ['setPendingDraft', 'setAllPendingDrafts', 'setDeferredDrafts', 'setReminders', 'setTasks', 'setPendingCompletions', 'setSelected']
  for (const name of names) {
    assert.match(
      body,
      new RegExp(`${name}\\(\\(prev\\) => keepIfEqual\\(prev,`),
      `${name} 必须写成 (prev) => keepIfEqual(prev, next)：轮询拿到的是新对象身份，直写必然每轮重渲染`,
    )
  }
})
