/**
 * 冒烟测试用的**最小 DOM 能力桩**（不是 DOM 实现）。
 *
 * ## 为什么需要它（2026-10-05，审计 §4.1）
 *
 * 客户端组件大多在**渲染期**就会碰 `document`：`Modal` 把 portal 容器写成
 * `document.body`（在校验容器之前就要求值），草稿横幅读 `document.documentElement` 上的标记，
 * 选择器读 `localStorage` 里上次选过的模型。本机没有 jsdom / happy-dom，
 * 服务端渲染也没有 DOM —— 于是这些模块**从来没有任何测试加载过**（37 个）。
 *
 * 这里只提供"渲染期不会抛"的最小能力面：属性读写、无副作用的监听注册、
 * 会响但不做事的计时器。**它不模拟布局、事件、焦点、样式计算** ——
 * 冒烟测试要证明的是"模块真被执行过一次并产出 HTML"，不是"DOM 行为正确"。
 *
 * ⚠️ 显式口径：任何依赖**真实布局/事件**的断言都不要写进冒烟测试，
 * 那类判据属于本机实测走查（见 `docs/releases/v1.17.0.md` §6）。
 */

const noop = () => undefined

/** 会记录属性/子节点的最小元素（够 `createElement` 那一族代码跑通）。 */
export function makeStubElement(tagName = 'div') {
  const attributes = new Map()
  /** 行内样式桩：`index.tsx` 会读/写 CSS 变量（`--wb-…`），不能只是个空对象。 */
  const style = {
    cssText: '',
    setProperty(name, value) { style[name] = String(value) },
    getPropertyValue(name) { return typeof style[name] === 'string' ? style[name] : '' },
    removeProperty(name) { delete style[name] },
  }
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    style,
    dataset: {},
    children: [],
    attributes,
    className: '',
    id: '',
    value: '',
    textContent: '',
    checked: false,
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    setAttribute(name, value) { attributes.set(name, String(value)) },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null },
    removeAttribute(name) { attributes.delete(name) },
    hasAttribute(name) { return attributes.has(name) },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    appendChild(child) { element.children.push(child); return child },
    insertBefore(child) { element.children.unshift(child); return child },
    removeChild: noop,
    replaceChildren: noop,
    contains: () => false,
    focus: noop,
    blur: noop,
    click: noop,
    scrollIntoView: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  }
  return element
}

/** 内存版 `localStorage`（选择器/设置会读写它，不能在渲染期抛）。 */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)) },
    removeItem: (key) => { map.delete(String(key)) },
    clear: () => { map.clear() },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
}

/**
 * 装好桩能力，返回卸载函数。
 *
 * 幂等：已经装过就只返回一个空操作（同一个进程里多个测试文件互不影响，
 * 每个测试文件本来也是独立进程）。
 */
export function installMinimalDom() {
  const installed = []
  const put = (name, value) => { installed.push([name, globalThis[name]]); globalThis[name] = value }

  const documentElement = makeStubElement('html')
  const body = makeStubElement('body')
  const head = makeStubElement('head')
  const documentStub = {
    nodeType: 9,
    documentElement,
    body,
    head,
    activeElement: body,
    title: 'workbench-smoke',
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    createElement: (tag) => makeStubElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => makeStubElement('fragment'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    execCommand: () => false,
  }

  /**
   * `window` 桩：**不能**直接把 Node 的 `globalThis` 当 window ——
   * 它没有 `addEventListener` / `innerWidth` / `location`，客户端代码一碰就抛
   * （实测：`apply()` 在 `window.addEventListener('resize', …)` 处中断）。
   * 这里给一份"看起来像窗口"的对象，并把 document/storage 也挂上去（浏览器里就是这样）。
   */
  const listeners = new Map()
  const windowStub = {
    document: documentStub,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: { href: 'http://127.0.0.1/workbench-smoke', origin: 'http://127.0.0.1', pathname: '/', search: '', hash: '' },
    navigator: globalThis.navigator ?? { userAgent: 'node' },
    addEventListener(type, callback) { listeners.set(`${type}`, callback) },
    removeEventListener(type) { listeners.delete(`${type}`) },
    dispatchEvent: () => true,
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
    requestAnimationFrame: (callback) => globalThis.setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle) => globalThis.clearTimeout(handle),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    scrollTo: noop,
    history: { pushState: noop, replaceState: noop },
    open: () => null,
  }
  put('document', documentStub)
  put('window', windowStub)
  globalThis.window.localStorage = makeStorage()
  globalThis.window.sessionStorage = makeStorage()
  put('localStorage', makeStorage())
  put('sessionStorage', makeStorage())
  put('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return [] } })
  put('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  put('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  put('matchMedia', (query) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
  }))
  put('requestAnimationFrame', (callback) => { callback(0); return 1 })
  put('cancelAnimationFrame', noop)
  put('getComputedStyle', () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }))
  put('scrollTo', noop)

  return () => {
    for (const [name, previous] of installed.reverse()) {
      if (previous === undefined) delete globalThis[name]
      else globalThis[name] = previous
    }
  }
}
