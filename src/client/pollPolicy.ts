/**
 * 客户端轮询的**唯一判据**（2026-10-05，审计 §3.2）。
 *
 * ## 修的是什么
 *
 * 改动前 `WorkbenchApp` 里是两个**无条件**的 `setInterval`：
 * `tick`（草稿 + 到期提醒，2 个请求 / 5 秒）与 `refresh`（列表 + 详情，3–7 个请求 / 15 秒）。
 * 它们从不看"面板开着吗""标签页在前台吗"，于是：
 *
 * 1. **稳态 36–52 请求/分钟**，面板关着、标签页在后台也一样；
 * 2. 更要紧的是 **每 5 秒必然触发一次全量重渲染** —— `tick` 里的 `setState` 每次都写入
 *    `JSON.parse` 出来的**新对象身份**，`Object.is` 永不相等，React 就必然重算那个
 *    三千多行的容器（审计 §4.4 的预算里 `useMemo` 已经是 0 余量）。
 *
 * ## 为什么不能"面板关着就停"
 *
 * 草稿弹框是**产品的主要通知面**：AI 提交验收申请时用户通常正在会话里干活、面板是关的，
 * 弹框靠 `createPortal` 挂在 `document.body` 上，**关着面板也要弹出来**
 * （v1.12.0 特意加了"暂存"就是为了这个场景）。所以这里做的是**降档**而不是**停机**，
 * 唯一的例外是标签页在后台 —— 那时屏幕上都看不见，只保留"桌面通知还能送到"的最低一档。
 *
 * ## 判据表（测试逐行覆盖）
 *
 * | 可见 | 面板开 | 轻轮询（草稿/提醒） | 重刷新（列表/详情） |
 * |---|---|---|---|
 * | 是 | 是 | 5 s（原速） | 30 s（原 15 s） |
 * | 是 | 否 | 15 s | **不周期刷新**，只在"看得见的那一刻"刷一次 |
 * | 否 | — | 60 s | 不刷新 |
 *
 * "看得见的那一刻"= 面板由关到开、或标签页由后台回前台 → `startPolling` 立刻补一轮
 * （轻 + 重）。**这比"每 15 秒盲刷一次"更准**：用户看到面板的第一帧就是刚拉的，
 * 而面板关着的时候一个重请求都不发。
 */
import { ACTIVE_ATTR } from './constants.js'

/** 看得见 + 面板开着：用户正盯着，保持原来的快节奏。 */
export const POLL_LIVE_MS = 5_000
/** 看得见但面板关着：弹框仍要弹（≤15 s 内出现），但可以慢一档。 */
export const POLL_IDLE_MS = 15_000
/** 标签页在后台：只为保住桌面通知能送到，退到一分钟一档。 */
export const POLL_HIDDEN_MS = 60_000
/** 面板开着且看得见时的全量刷新周期（原来固定 15 s）。 */
export const REFRESH_LIVE_MS = 30_000

export interface PollInputs {
  /** 标签页可见（`document.visibilityState === 'visible'`）。 */
  visible: boolean
  /** 工作台面板正显示（`<html>` 上的 `ACTIVE_ATTR`，设计文档不变量 2 的唯一投影）。 */
  panelOpen: boolean
}

/** 轻轮询间隔（草稿 + 到期提醒）。 */
export function pollDelayMs(inputs: PollInputs): number {
  if (!inputs.visible) return POLL_HIDDEN_MS
  return inputs.panelOpen ? POLL_LIVE_MS : POLL_IDLE_MS
}

/** 重刷新间隔；`null` = 现在不需要按周期刷（靠状态变化触发一次即可）。 */
export function refreshDelayMs(inputs: PollInputs): number | null {
  return inputs.visible && inputs.panelOpen ? REFRESH_LIVE_MS : null
}

/** `readPollInputs` 需要的那部分 DOM 形状（只为可测，不依赖真实 `Document`）。 */
export interface PollDocLike {
  visibilityState?: string
  documentElement?: Node & { hasAttribute(name: string): boolean }
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

/**
 * 读输入。
 *
 * **读 DOM 属性而不是接 props**：`ACTIVE_ATTR` 已经是"面板是否显示"的**唯一投影**
 * （`decidePanel` 单点执行，`WorkbenchHeaderEntry` 也靠它同步高亮），
 * 从 props 再引一路进来就是同一语义的第二个来源 —— 本仓的头号 bug 类别。
 *
 * `visibilityState` 取不到（旧宿主/非浏览器环境）时**按可见处理**（fail open）：
 * 判据未知时退化成改动前的行为，而不是悄悄降档到一分钟一档。
 */
export function readPollInputs(doc: PollDocLike | undefined): PollInputs {
  const state = doc?.visibilityState
  return {
    visible: state === undefined ? true : state === 'visible',
    panelOpen: doc?.documentElement?.hasAttribute(ACTIVE_ATTR) === true,
  }
}

/**
 * `bootstrap` 响应里**每轮都会变、但客户端不消费**的键。
 *
 * ## 为什么需要它（2026-10-05 用真实数据实测发现）
 *
 * 本机活服务上连续取两次 `GET /api/workbench/bootstrap`，逐字段比对**只差 `now`**
 * （服务端时间戳；`dictionaries` / `stats` / `todayPlan` / 两个能力位全都相同）。
 * 于是 `keepIfEqual(bootstrap, next)` 会**永远判为"变了"** —— 代码看起来在省重渲染，
 * 实际一次也省不掉。这比不写更糟：下一个人会以为这里已经优化过了。
 *
 * ## 为什么可以忽略它
 *
 * 客户端一个字段一个字段读过一遍：只消费 `dictionaries` / `todayPlan` / `stats` /
 * `memoryAvailable` / `deadlineEngineAvailable`，**没有任何一处读 `now`**
 * （`Bootstrap` 类型里也没声明它，是服务端多给的字段）。
 * 忽略它 ⇒ 只在"客户端真正会读的东西变了"时才重渲染。
 *
 * ⚠️ 哪天要用 `now` 显示或参与计算，**先把它从这份清单里拿掉**，
 * 否则界面上的"服务端时间"会停在别的字段最后一次变化的时刻。
 */
export const BOOTSTRAP_VOLATILE_KEYS: readonly string[] = ['now']

/** 顶层键的投影（`ignore` 里的键不参与比较；数组与嵌套对象原样保留）。 */
function withoutKeys(value: unknown, ignore: readonly string[]): unknown {
  if (ignore.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!ignore.includes(key)) out[key] = item
  }
  return out
}

/**
 * 结构相等（用 JSON 口径）。
 *
 * 轮询拿到的都是**这个端点自己序列化出来的小对象**（几十条以内），
 * `JSON.stringify` 在这种量级是微秒级；换成手写深比较只会多一份要维护的语义。
 * 序列化失败（循环引用/不支持的字段）时保守返回 `false` —— 宁可多渲染一次。
 *
 * `ignore` 只作用于**顶层键**（够用且好解释）：见 `BOOTSTRAP_VOLATILE_KEYS`。
 */
export function sameJson(a: unknown, b: unknown, ignore: readonly string[] = []): boolean {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(withoutKeys(a, ignore)) === JSON.stringify(withoutKeys(b, ignore))
  } catch {
    return false
  }
}

/**
 * `setState` 短路：值没变就**返回原引用**。
 *
 * React 在更新器返回与当前 state `Object.is` 相等的值时直接 bail out，
 * 不重渲染 —— 这就是"值没变就不写"的实现方式，不需要额外的 ref 记上一次的值。
 */
export function keepIfEqual<T>(prev: T, next: T, ignore: readonly string[] = []): T {
  return sameJson(prev, next, ignore) ? prev : next
}

export interface PollEnv {
  doc: PollDocLike | undefined
  /** 定时器注入（测试用假时钟）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  /** 状态变化订阅注入（测试用假订阅）；默认订阅 `visibilitychange` + `ACTIVE_ATTR`。 */
  subscribeStateChange?: (listener: () => void) => () => void
}

export interface PollTargets {
  /** 轻轮询：草稿 + 到期提醒。 */
  tick: () => Promise<void> | void
  /** 重刷新：列表 + 选中任务详情。 */
  refresh: () => Promise<void> | void
}

/**
 * 按上面的判据表跑轮询，返回停止函数。
 *
 * 两条链**各自重排**（轻链每次跑完排下一个轻的，重链同理）：这样"轻链 5 秒一次"
 * 不会把"重链 30 秒一次"顶掉 —— 一个定时器同时管两件事时，短周期那条会把长周期的
 * 永远推迟（改动前是两个 `setInterval`，这里保持同样的独立性）。
 *
 * 轮询回调抛错**不会**让链停摆（`tick`/`refresh` 内部各自已有兜底，这里再兜一层）。
 */
export function startPolling(env: PollEnv, targets: PollTargets): () => void {
  const setT = env.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms))
  const clearT = env.clearTimeoutFn
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))
  let tickTimer: unknown
  let refreshTimer: unknown
  let stopped = false
  const initial = readPollInputs(env.doc)
  let wasVisible = initial.visible
  let wasPanelOpen = initial.panelOpen

  const clearTimers = (): void => {
    if (tickTimer !== undefined) { clearT(tickTimer); tickTimer = undefined }
    if (refreshTimer !== undefined) { clearT(refreshTimer); refreshTimer = undefined }
  }

  const loopTick = (): void => {
    if (stopped) return
    void Promise.resolve()
      .then(() => targets.tick())
      .catch(() => undefined)
      .then(() => {
        if (stopped) return
        tickTimer = setT(loopTick, pollDelayMs(readPollInputs(env.doc)))
      })
  }

  const loopRefresh = (): void => {
    if (stopped) return
    void Promise.resolve()
      .then(() => targets.refresh())
      .catch(() => undefined)
      .then(() => {
        if (stopped) return
        const delay = refreshDelayMs(readPollInputs(env.doc))
        // 看不见 / 面板关着 → 这条链**停下**，等状态变化再被唤醒（不再盲刷）
        if (delay === null) return
        refreshTimer = setT(loopRefresh, delay)
      })
  }

  /**
   * "看得见的那一刻"：立刻补一轮轻 + 一轮重，并让两条链按新状态重排。
   * 只在**变成有用**（可见 + 刚回前台 / 刚开面板）时触发，不是每次状态变化都刷。
   */
  const kick = (): void => {
    if (stopped) return
    clearTimers()
    loopTick()
    if (refreshDelayMs(readPollInputs(env.doc)) !== null) loopRefresh()
  }

  const onStateChange = (): void => {
    if (stopped) return
    const inputs = readPollInputs(env.doc)
    const becameUseful = inputs.visible && (!wasVisible || (inputs.panelOpen && !wasPanelOpen))
    wasVisible = inputs.visible
    wasPanelOpen = inputs.panelOpen
    if (becameUseful) kick()
  }

  const unsubscribe = (env.subscribeStateChange ?? defaultSubscribe(env.doc))(onStateChange)

  // 起点与改动前一致：立刻一次轻轮询，重刷新按周期排（挂载时的数据由 refresh 的初始 effect 拉）
  loopTick()
  if (refreshDelayMs(initial) !== null) refreshTimer = setT(loopRefresh, REFRESH_LIVE_MS)

  return () => {
    stopped = true
    clearTimers()
    unsubscribe()
  }
}

/** 默认订阅：标签页可见性 + 面板显隐属性（两者都是"看得见"的输入）。 */
function defaultSubscribe(doc: PollDocLike | undefined): (listener: () => void) => () => void {
  return (listener) => {
    const target = doc
    const root = target?.documentElement
    if (target === undefined || root === undefined || typeof target.addEventListener !== 'function') return () => {}
    target.addEventListener('visibilitychange', listener)
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(listener)
    if (observer !== undefined) observer.observe(root, { attributes: true, attributeFilter: [ACTIVE_ATTR] })
    return () => {
      target.removeEventListener?.('visibilitychange', listener)
      observer?.disconnect()
    }
  }
}
