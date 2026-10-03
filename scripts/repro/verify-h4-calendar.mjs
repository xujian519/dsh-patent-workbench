#!/usr/bin/env node
/**
 * H4-1 的**真浏览器**验证：把抽出来的 `CalendarView` 用真实 props 渲染进页面，做**交互断言**。
 *
 * 为什么不是"渲染一张截图"：拆视图最可能出的错是**行为**变了（翻页落点、点格选中、
 * 以及"切到别的页签再切回来"把模式重置）。这些只能靠点击 + 断言 DOM/状态来证明。
 * 判定逻辑（周/月格子与翻页落点）另有纯函数单测（`test/calendarView.test.mjs`）。
 *
 * 用法：node scripts/repro/verify-h4-calendar.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 缺浏览器或脚手架构建失败（都打清楚原因）
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { launchDebugBrowser } from '../verify/cdp.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const OUT_DIR = join(ROOT, '_local-build', 'h4')
const PAGE = join(OUT_DIR, 'calendar-harness.html')
const SHOT = join(OUT_DIR, 'h4-1-calendar.png')

const browser = discoverBrowser()
if (!browser.ok) {
  console.error(`SKIP: ${browser.reason}`)
  process.exit(2)
}

const build = spawnSync('npx', ['tsdown', '--config', 'scripts/verify/harness/tsdown.config.mjs'], { cwd: ROOT, encoding: 'utf8' })
if (build.status !== 0) {
  console.error(`脚手架构建失败：\n${build.stdout ?? ''}${build.stderr ?? ''}`)
  process.exit(2)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(PAGE, [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-1 CalendarView</title></head>',
  '<body style="margin:0">',
  '<script src="./calendar-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '1100,900' })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 点某个选择器命中的元素（坐标点击 + 事件到达验证由 cdp.mjs 的 clickAt 负责）。 */
async function clickSelector(selector) {
  const point = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到可点击元素：${selector}`)
  await api.clickAt(point.x, point.y)
}

/** 屏幕上某个 `.wb-seg` / 按钮的文案定位（月/周/今天/▶）。 */
const byText = (selector, text) => `
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const i = els.findIndex((el) => el.textContent.trim() === ${JSON.stringify(text)});
  if (i < 0) return null;
  const r = els[i].getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
`
async function clickText(selector, text) {
  const point = await api.evaluate(byText(selector, text))
  if (point === null) throw new Error(`找不到文案为「${text}」的 ${selector}`)
  await api.clickAt(point.x, point.y)
}

/**
 * 点某个**日期格子**。不能按 `textContent` 匹配：格子里除了日期还有"1 个任务"标记，
 * 整格文本是 `10/11 个任务`。所以按内层日期标签定位。
 */
async function clickCell(cellSelector, label) {
  const point = await api.evaluate(`
    const cell = [...document.querySelectorAll(${JSON.stringify(cellSelector)})]
      .find((el) => el.querySelector('.wb-day-date, .wb-mday-date')?.textContent === ${JSON.stringify(label)});
    if (cell === undefined) return null;
    const r = cell.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到日期为 ${label} 的格子（${cellSelector}）`)
  await api.clickAt(point.x, point.y)
}

/** 单元格上的日期标签（周视图=「10/3」，月视图=「3」）。 */
const cellLabels = (cellSelector) => `
  return [...document.querySelectorAll(${JSON.stringify(cellSelector)})]
    .map((el) => el.querySelector('.wb-day-date, .wb-mday-date')?.textContent ?? '');
`
const labelsWithChip = (cellSelector) => `
  return [...document.querySelectorAll(${JSON.stringify(cellSelector)})]
    .filter((el) => el.querySelector('.wb-chip') !== null)
    .map((el) => el.querySelector('.wb-day-date, .wb-mday-date')?.textContent ?? '');
`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载 CalendarView）' })

  // ---------------------------------------------------------------- 周视图初始态
  check('初始是周模式', await api.evaluate('return __h4.mode() === "week"'))
  check('周视图 7 格', await api.evaluate('return document.querySelectorAll(".wb-day").length === 7'))
  check('周视图标题 = 本周周首（周一）', await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026/9/28 周"'),
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim()'))
  check('周视图格子 = 9/28…10/4', JSON.stringify(await api.evaluate(cellLabels('.wb-day'))) === JSON.stringify(['9/28', '9/29', '9/30', '10/1', '10/2', '10/3', '10/4']),
    JSON.stringify(await api.evaluate(cellLabels('.wb-day'))))
  check('“今天”落在 10/3 那一格（class=today）',
    await api.evaluate('return document.querySelector(".wb-day.today .wb-day-date")?.textContent === "10/3"'))
  check('出标记的格子 = 9/30、10/1、10/3（**已取消的 10/2 不出现**）',
    JSON.stringify(await api.evaluate(labelsWithChip('.wb-day'))) === JSON.stringify(['9/30', '10/1', '10/3']),
    JSON.stringify(await api.evaluate(labelsWithChip('.wb-day'))))
  check('日期面板用 dayPanelProps.day 渲染（2026-09-28）',
    await api.evaluate('return document.body.textContent.includes("2026-09-28 没有计划任务")'))

  // ---------------------------------------------------------------- 空态动作 = onSort（拆分时把那行内联调用改成了 props.onSort()）
  await clickText('.wb-btn', 'AI 智能排序')
  check('空态「AI 智能排序」走到 dayPanelProps.onSort()',
    (await api.evaluate('return __h4.events()')).includes('onSort'))

  // ---------------------------------------------------------------- 周视图点格子 → 选中
  await clickCell('.wb-day', '10/1')
  const pickedWeek = await api.evaluate('return __h4.picks()')
  const expectedWeek = await api.evaluate(`
    const d = new Date(2026, 9, 1); return d.toISOString();
  `)
  check('点周视图「10/1」→ onPickDay 收到当天 00:00',
    pickedWeek.length === 1 && pickedWeek[0] === expectedWeek,
    `picks=${JSON.stringify(pickedWeek)} 期望=${expectedWeek}`)
  check('选中态跟着走到 10/1',
    await api.evaluate('return document.querySelector(".wb-day.selected .wb-day-date")?.textContent === "10/1"'))

  // ---------------------------------------------------------------- 切月视图
  await clickText('.wb-seg', '月')
  check('切到月模式（state）', await api.evaluate('return __h4.mode() === "month"'))
  check('月视图 42 格', await api.evaluate('return document.querySelectorAll(".wb-mday").length === 42'))
  check('月视图标题 = 2026年9月（游标仍在 9/28 所在月）',
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026年9月"'),
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim()'))
  check('月视图出标记的格子 = 3（已取消那条仍不计）',
    (await api.evaluate(labelsWithChip('.wb-mday'))).length === 3,
    JSON.stringify(await api.evaluate(labelsWithChip('.wb-mday'))))
  check('“今天”在月视图仍然只有一格被高亮',
    await api.evaluate('return document.querySelectorAll(".wb-mday.today").length === 1'))

  // ---------------------------------------------------------------- 翻页与「今天」
  await clickText('.wb-btn', '▶')
  check('▶ 之后 = 2026年10月', await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026年10月"'),
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim()'))
  await clickText('.wb-btn', '◀')
  check('◀ 之后回到 2026年9月', await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026年9月"'))
  await clickText('.wb-btn', '▶')
  await clickText('.wb-btn', '▶')
  check('再 ▶ 一次 = 2026年11月', await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026年11月"'),
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim()'))
  await clickText('.wb-btn', '今天')
  /**
   * ⚠️ 期望是「今天所在的月」= **2026年10月**，不是 2026年9月。
   *
   * 月视图的「今天」落在 `new Date(now.getFullYear(), now.getMonth(), 1)` —— 也就是今天
   * 那个月的 1 号（这里 now = 2026-10-03）。拆分前那一行内联表达式就是这个语义，
   * 我第一版断言按"游标原来的月份"写，红了一次；红的是**我的期望**，不是组件。
   */
  check('「今天」把月视图拉回**今天所在的月**（2026年10月）',
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim() === "2026年10月"'),
    await api.evaluate('return document.querySelector(".wb-cal-nav div").textContent.trim()'))

  // ---------------------------------------------------------------- ★ 切页签再切回：模式不许丢
  await api.evaluate('__h4.setView("today"); return true;')
  check('切走后日历整块卸载', await api.evaluate('return document.querySelector("#calendar-host") === null && document.querySelector("#other-view") !== null'))
  await api.evaluate('__h4.setView("calendar"); return true;')
  await api.waitFor('return document.querySelectorAll(".wb-mday").length === 42', { description: '日历重新挂载' })
  check('★ 切回来后仍是**月**模式（state 挂在容器上，视图卸载不重置）',
    await api.evaluate('return __h4.mode() === "month" && document.querySelectorAll(".wb-mday").length === 42'))

  // ---------------------------------------------------------------- 页面无异常
  check('无页面异常 / 无 console error', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))

  await api.screenshot(SHOT)
  console.log(`\n截图：${SHOT.replace(`${ROOT}/`, '')}`)
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-1 真浏览器验证：全绿' : `\nH4-1 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
