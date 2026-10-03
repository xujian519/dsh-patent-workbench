/**
 * ⚠️ **部分过时（T2 起）**：`--case capacity` 那一批针对**旧容量口径**
 * （"已排 = 按到期任务求和"），ADR 0002 之后已不再代表产品行为；2026-10-03
 * 容量功能整体删除（决策 4），`CapacityRulePanel` 与「今日容量条」都不存在了，
 * 于是**那一批连同 `--case capacity` 一起移除**。
 *
 * **仍然现行**的是知识库批（`--case listview`）：它渲染的
 * `KnowledgeList`/`KnowledgeToolbar`/`KnowledgePager` 与真实 `WORKBENCH_CSS`
 * 都还在，判据（2 列网格、分页条位置、工具栏单行右对齐）一条没变。
 * 全文件是否进验收链见 `scripts/verify/suites.json` 的 deprecated 登记。
 *
 * 真浏览器渲染验证（不依赖 React 运行时）。
 *
 * ## 做法
 *
 * 用 `react-dom/server` 把**真实组件**渲染成 HTML → 拼进一个真页面 → 带上**真实的 `WORKBENCH_CSS`**
 * → 在 headless Chromium（路径由 `discoverBrowser()` 发现）里加载 → 用 CDP 做**布局与像素级断言**。
 *
 * ## 为什么必须补这一层
 *
 * - `node --test` 的 `renderToStaticMarkup` 只能验证"渲染成什么 HTML"，
 *   **真实 CSS 下的布局**（分组头、2 列网格、分页条位置、☑ 的 hover/焦点可见性）在那里不存在；
 * - 原型打样页（`demo/kb-styles/`）用的是手写假组件，证明不了这份实现；
 * - 宿主页面缓存着旧插件 bundle，重启前看不到新行为。
 *
 * ## 这一层达不到的（如实标注，不假装覆盖）
 *
 * `createPortal` 的运行时归属、`useLayoutEffect` 的滚动重算、点击后的状态变化
 * 需要 React 运行时。本机没有可用的浏览器端 bundler（esbuild 未安装；让 tsdown 把整个
 * react-dom 打进 IIFE 会卡死），所以这三点由 `test/listViews.test.mjs` 的纯函数断言
 * （`placeFolderMenu`/`folderMenuAnchor`/`samePlacement` 逐条边界）+ 变异探针覆盖，
 * 真机交互留给用户重启后手点。
 *
 * 用法：
 *   node scripts/repro/harness-real-browser.mjs                 # 跑全部批
 *   node scripts/repro/harness-real-browser.mjs --case listview # 只跑知识库批
 *
 * ⚠️ 成功路径必须**显式 `process.exit(0)`**：CDP/Edge 子进程有时会让 Node 自然结束延迟或挂住，
 * 靠"脚本跑到底"当成功信号会出现假绿（本文件原先就没有显式退出码）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * `--case <name>`：默认 `all`。参数化是为了让不同批可以独立跑。
 *
 * 2026-10-03：`capacity` 批已随容量功能删除（见文件头），现在只剩 `listview`。
 */
const CASE = (() => {
  const index = process.argv.indexOf('--case')
  if (index < 0) return 'all'
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error('用法：node scripts/repro/harness-real-browser.mjs [--case listview|all]')
    process.exit(2)
  }
  if (!['listview', 'all'].includes(value)) {
    console.error(`未知的 --case ${value}（可选 listview / all）`)
    process.exit(2)
  }
  return value
})()
const RUN_LISTVIEW = CASE === 'all' || CASE === 'listview'

const OUT = resolve('_local-archive/listviews/harness')
mkdirSync(OUT, { recursive: true })

const { KnowledgeList, KnowledgePager, KnowledgeToolbar, EMPTY_KNOWLEDGE_FILTERS, kindTabs, selectedKind } = await import(pathToFileURL(resolve('lib/client/components/KnowledgeList.js')).href)
const { buildListPage, toContentItem } = await import(pathToFileURL(resolve('lib/client/listPresentation.js')).href)
const { WORKBENCH_CSS } = await import(pathToFileURL(resolve('lib/client/styles.js')).href)

const DAY = 86400000
const HOUR = 3600000
const NOW = Date.parse('2026-09-25T15:00:00+08:00')
const at = (msAgo) => new Date(NOW - msAgo).toISOString()

const KINDS = [
  { kind: 'knowledge_kind', code: 'note', name: '笔记', config: { color: '#4F86F7' } },
  { kind: 'knowledge_kind', code: 'lesson', name: '经验教训', config: { color: '#E7634C' } },
  { kind: 'knowledge_kind', code: 'decision', name: '决策记录', config: { color: '#8B7BE8' } },
  { kind: 'knowledge_kind', code: 'snippet', name: '片段/模板', config: { color: '#2E9B7B' } },
]
/** 137 条：够 3 页，跨多个时间档位，标签/类型分布明显 */
const entries = Array.from({ length: 137 }, (_, i) => toContentItem({
  id: 'k' + i,
  title: `知识条目 ${i}：cloudflared 端口 ${i % 13}`,
  contentMd: `现象：第 ${i} 条。\n原因：正文里也要能被搜到。\n解法：判定抽成纯函数。`,
  tags: i % 3 === 0 ? ['踩坑', 'DSH'] : ['性能'],
  kindCode: KINDS[i % KINDS.length].code,
  createdAt: at((i % 500) * DAY),
  updatedAt: at(i < 8 ? i * HOUR : i < 30 ? (1 + (i % 5)) * DAY : i < 60 ? (8 + (i % 20)) * DAY : (60 + i) * DAY),
}))
const filters = { ...EMPTY_KNOWLEDGE_FILTERS }
const page = buildListPage({
  items: entries,
  query: { tab: selectedKind(filters), keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: filters.pageSize },
  now: NOW,
  tabOf: (e) => e.kindCode,
  tabCodes: KINDS.map((k) => k.code),
})

const toolbar = renderToStaticMarkup(createElement(KnowledgeToolbar, {
  filters, tabs: kindTabs(KINDS, page.tabCounts), tagCounts: page.tagCounts, total: page.total,
  onChange: () => {}, onClear: () => {}, onCreate: () => {}, onSummarizeDoc: () => {},
}))
const list = renderToStaticMarkup(createElement(KnowledgeList, { page, dicts: KINDS, selectedId: 'k2', onOpen: () => {} }))
const pager = renderToStaticMarkup(createElement(KnowledgePager, { page, pageSize: 10, onPage: () => {}, onPageSize: () => {} }))
const knowledgeMarkup = RUN_LISTVIEW
  ? `<div class="pane" id="knowledge" data-kb-harness>${toolbar}${list}${pager}</div>` : ''

writeFileSync(join(OUT, 'workbench.css'), WORKBENCH_CSS)
const PAGE = join(OUT, 'harness.html')
writeFileSync(PAGE, `<!DOCTYPE html>
<html lang="zh-CN" data-dsh-personal-workbench-official data-dsh-personal-workbench-active><head><meta charset="UTF-8"><title>真组件 + 真样式渲染验证</title>
<link rel="stylesheet" href="workbench.css">
<style>
  html, body { margin:0; padding:0; background:#0f0f12; height:100%; }
  /* .wb-panel-host 是 fixed + overflow:hidden 的容器（复审 F4 的场景）
     .wb-app-scope 是它内部的**滚动区** —— 与真实面板一致 */
  .wb-app-scope { overflow: auto; }
  .pane { width: 880px; padding: 14px; box-sizing: border-box; }
</style></head>
<body><div class="wb-panel-host" data-open="1"><div class="wb-app-scope" data-dsh-personal-workbench-view data-harness-scroller>
${knowledgeMarkup}
</div></div>
<script>
</script>
</body></html>`)

const browser = discoverBrowser()
if (!browser.ok) { console.error(`SKIP: ${browser.reason}`); process.exit(2) }

const PORT = 9800 + Math.floor(Math.random() * 150)
const profile = mkdtempSync(join(tmpdir(), 'lv-harness-'))
const child = spawn(browser.path, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1340,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const list_ = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list_.find((x) => x.type === 'page')
      if (t !== undefined) return t.webSocketDebuggerUrl
    } catch { /* not ready */ }
    await sleep(250)
  }
  throw new Error('CDP 端点超时')
}

const ws = new WebSocket(await endpoint())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const pageErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id)
    if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error))); else ok(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
}
const send = (method, params = {}) => {
  const mid = ++id
  return new Promise((ok, reject) => { pending.set(mid, { resolve: ok, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: pathToFileURL(PAGE).href })
await sleep(1200)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}
check('页面无脚本异常', pageErrors.length === 0, pageErrors.join(' | '))

// ---- 真样式是否真的作用上了（否则后面所有断言都是空的） ----
if (RUN_LISTVIEW) {
const styleApplied = await evaluate(`(() => {
  return {
    tabsDisplay: getComputedStyle(document.querySelector('.wb-tabs')).display,
    rowDisplay: getComputedStyle(document.querySelector('.wb-kb-row')).display,
    viewportWidth: window.innerWidth,
  }
})()`)
check('真样式已生效（Tab / 行都有布局）', styleApplied.tabsDisplay === 'flex' && styleApplied.rowDisplay === 'flex', JSON.stringify(styleApplied))

// ---- 知识库：结构 + 布局 ----
const kb = await evaluate(`(() => {
  const pane = document.querySelector('#knowledge')
  const tabs = [...pane.querySelectorAll('.wb-tab')]
  const groups = [...pane.querySelectorAll('[data-kb-group]')].map((g) => g.getAttribute('data-kb-group'))
  const rows = [...pane.querySelectorAll('[data-kb-row]')]
  const pagerBox = pane.querySelector('[data-kb-pager]').getBoundingClientRect()
  const listBox = pane.querySelector('[data-kb-list]').getBoundingClientRect()
  return {
    tabCount: tabs.length,
    tabLabels: tabs.map((t) => t.textContent.trim()),
    activeTabs: tabs.filter((t) => t.classList.contains('on')).length,
    groups, rows: rows.length,
    pagerBelowList: pagerBox.top >= listBox.bottom - 1,
    rowWidth: Math.round(rows[0].getBoundingClientRect().width),
    hasSummary: (pane.querySelector('.wb-kb-sum')?.textContent ?? '').length > 5,
    hasChip: pane.querySelector('.wb-kb-chip') !== null,
    hasTags: pane.querySelector('.wb-kb-tg') !== null,
    selected: pane.querySelectorAll('.wb-kb-row.sel').length,
    groupHeadsHaveCount: [...pane.querySelectorAll('.wb-kb-gcnt')].every((c) => /^\\d+$/.test(c.textContent.trim())),
  }
})()`)
check('知识库：5 个 Tab 且只有一个高亮', kb.tabCount === 5 && kb.activeTabs === 1, JSON.stringify({ n: kb.tabCount, active: kb.activeTabs }))
check('知识库：Tab 带条数徽标', kb.tabLabels.every((l) => /\d/.test(l)), JSON.stringify(kb.tabLabels))
check('知识库：时间分组头 ≥2 且带条数', kb.groups.length >= 2 && kb.groupHeadsHaveCount, JSON.stringify(kb.groups))
check('知识库：每页 10 行（用户定的默认）', kb.rows === 10, String(kb.rows))
check('知识库：行有摘要/类型徽标/标签', kb.hasSummary && kb.hasChip && kb.hasTags, JSON.stringify({ s: kb.hasSummary, c: kb.hasChip, t: kb.hasTags }))
check('知识库：选中行有 sel 态', kb.selected === 1, String(kb.selected))
check('知识库：分页条在列表下方（没被挤到视口外）', kb.pagerBelowList === true, JSON.stringify(kb))

// ---- 工具栏：三个按钮必须在同一行且右对齐（用户要求） ----
const toolbarBox = await evaluate(`(() => {
  const bar = document.querySelector('.wb-kb-bar')
  const btn = (sel) => { const el = bar.querySelector(sel); return el === null ? null : el.getBoundingClientRect() }
  const nw = btn('[data-kb-new]'), sum = btn('[data-kb-summarize]'), clr = btn('[data-kb-clear]')
  const search = btn('[data-kb-search]'), hit = btn('[data-kb-hit]')
  const barBox = bar.getBoundingClientRect()
  // 判"同一行"用**各元素中心线**与工具栏中心线的偏差，而不是 top 相等：
  // 小字号的命中数（11.5px）与按钮（30px 高）在同一行里 top 本来就会差几像素（垂直居中）。
  const barCenter = barBox.top + barBox.height / 2
  const centered = (b) => b !== null && Math.abs((b.top + b.height / 2) - barCenter) < 4
  const sameRow = (a, b) => a !== null && b !== null && Math.abs(a.top - b.top) < 2
  return {
    barHeight: Math.round(barBox.height),
    btnRowHeight: nw === null ? 0 : Math.round(nw.height),
    tops: { search: search === null ? null : Math.round(search.top), hit: hit === null ? null : Math.round(hit.top), nw: nw === null ? null : Math.round(nw.top) },
    // 全部 5 个控件都在工具栏这一条的中心线上 ⇒ 真的只有一行
    allCenteredOnBar: [nw, sum, clr, search, hit].every(centered),
    allSameRow: sameRow(nw, sum) && sameRow(sum, clr),
    // 按钮右对齐：三个按钮都在工具栏右半边
    buttonsRightOfCenter: [nw, sum, clr].every((b) => b !== null && b.left > barBox.left + barBox.width * 0.5),
    // 左半部分（搜索/命中数）在左半边
    leftHalf: search.left < barBox.left + barBox.width * 0.5 && hit.left < barBox.left + barBox.width * 0.5,
    // 按钮没被压成竖排：宽 > 高
    noVerticalSquash: [nw, sum, clr].every((b) => b !== null && b.width > b.height),
    order: [nw, sum, clr].map((b) => (b === null ? -1 : Math.round(b.left))),
    searchWidth: search === null ? 0 : Math.round(search.width),
    spacerWidth: Math.round((bar.querySelector('.wb-kb-spacer')?.getBoundingClientRect().width) ?? 0),
    widths: [...bar.children].map((c) => ({ cls: String(c.className).replace('wb-btn ', ''), w: Math.round(c.getBoundingClientRect().width) })),
    barWidth: Math.round(barBox.width),
  }
})()`)
check('工具栏：真实宽度下搜索框够用（≥200px）', toolbarBox.searchWidth >= 200, `search=${toolbarBox.searchWidth}px 预算=${JSON.stringify(toolbarBox.widths)}`)

/**
 * 真实面板宽度下再量一次。
 *
 * 窄窗（内容区 632px）是**压力测试**：一行放不下时按用户要求"先降搜索宽度"。
 * 但真实左侧列表区是 `flex:0 0 min(56%, 880px)`，1920 屏上约 880px、1366 屏上约 709px ——
 * 所以真正要守住的是"日常宽度下搜索框够宽敞"。
 */
const wideToolbar = await evaluate(`(() => {
  const pane = document.querySelector('#knowledge')
  const prev = pane.style.width
  pane.style.width = '900px'
  const bar = document.querySelector('.wb-kb-bar')
  const box = (sel) => { const el = bar.querySelector(sel); return el === null ? null : el.getBoundingClientRect() }
  const search = box('[data-kb-search]')
  const nw = box('[data-kb-new]'), sum = box('[data-kb-summarize]'), clr = box('[data-kb-clear]')
  const barBox = bar.getBoundingClientRect()
  const result = {
    searchWidth: search === null ? 0 : Math.round(search.width),
    spacerWidth: Math.round((bar.querySelector('.wb-kb-spacer')?.getBoundingClientRect().width) ?? 0),
    allOneRow: [nw, sum, clr, search].every((b) => b !== null && Math.abs((b.top + b.height / 2) - (barBox.top + barBox.height / 2)) < 4),
    buttonsRight: [nw, sum, clr].every((b) => b !== null && b.left > barBox.left + barBox.width * 0.5),
  }
  pane.style.width = prev
  return result
})()`)
check('工具栏：真实面板宽度（900px 内容区）下搜索框宽敞（≥200px）', wideToolbar.searchWidth >= 200, JSON.stringify(wideToolbar))
check('工具栏：真实宽度下仍是一行、按钮仍右对齐', wideToolbar.allOneRow === true && wideToolbar.buttonsRight === true, JSON.stringify(wideToolbar))
check('工具栏：三按钮 + 搜索/命中数在**同一行**', toolbarBox.allCenteredOnBar === true && toolbarBox.allSameRow === true, JSON.stringify(toolbarBox))
check('工具栏：按钮右对齐、搜索与命中数左对齐', toolbarBox.buttonsRightOfCenter === true && toolbarBox.leftHalf === true, JSON.stringify(toolbarBox))
check('工具栏：按钮没被压成竖排（宽>高）', toolbarBox.noVerticalSquash === true, JSON.stringify(toolbarBox))
check('工具栏：按钮顺序为 新建 → AI 总结 → 清空筛选', toolbarBox.order[0] < toolbarBox.order[1] && toolbarBox.order[1] < toolbarBox.order[2], JSON.stringify(toolbarBox.order))
check('工具栏：只占一行（高度接近一个控件）', toolbarBox.barHeight < toolbarBox.btnRowHeight * 2, `bar=${toolbarBox.barHeight} btn=${toolbarBox.btnRowHeight}`)

// 截图前把面板滚回顶部、并移掉那个浮动菜单：
// 菜单是 fixed（不随滚动移动，这是设计使然），留着会压在知识库列表上，截图会误导人。
// 工具栏与 Tab 条在顶部，是这次改动最该看的地方。
await evaluate(`(() => {
  document.querySelector('.wb-app-scope').scrollTop = 0
  return true
})()`)
await sleep(250)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'real-render.png'), Buffer.from(shot.data, 'base64'))
}  // ← RUN_LISTVIEW 批结束


const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`真组件 + 真样式渲染验证（--case ${CASE}）：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
}

/**
 * ⚠️ 收尾顺序：**先清理，再退出**。
 *
 * 第一版把 `process.exit()` 写在清理之前，于是：
 * - 成功路径的 `process.exit(0)` 直接终止进程 → 后面那句 `rmSync(profile)` 从来没执行过；
 * - 而 Edge 子进程刚被 kill、profile 目录还被句柄占着，`rmSync` 抛 `EPERM`，
 *   连带把已经全绿的运行变成 `exit 1`（看起来像"测试挂了"，其实是清理自己的问题）。
 *
 * 清理本身也不该拖死运行：删不掉就留个提示，退出码只由断言决定。
 */
ws.close()
try { child.kill() } catch { /* 已经退出 */ }
await sleep(200)
try { rmSync(profile, { recursive: true, force: true }) } catch (e) {
  console.log(`（提示：临时浏览器 profile 未能删除，可忽略：${e instanceof Error ? e.message : String(e)}）`)
}
if (failed.length > 0) {
  process.exit(1)
}
console.log('全部通过。')
/** 成功路径**显式退出**：不写的话 CDP/Edge 子进程没干净退出时 Node 会挂住，"跑完了"与"卡在事件循环"从输出上分不出来。 */
process.exit(0)



