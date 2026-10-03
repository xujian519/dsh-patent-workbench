#!/usr/bin/env node
/**
 * H4-2 的**真浏览器**验证：把抽出来的 `TodayView` 用真实 props 渲染进页面，做**交互断言**。
 *
 * 为什么不是"渲染一张截图"：拆视图最可能出的错是**行为**变了 —— 统计卡的数字、期限看板的
 * 降级说明、空态两个入口真的落到容器的构造入口、以及"切到别的页签再切回来"面板页签不丢。
 * 这些只能靠点击 + 断言 DOM/状态来证明。
 *
 * 用法：node scripts/repro/verify-h4-today.mjs
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
const PAGE = join(OUT_DIR, 'today-harness.html')
const SHOT = join(OUT_DIR, 'h4-2-today.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-2 TodayView</title></head>',
  '<body style="margin:0">',
  '<script src="./today-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '900,1100' })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * 按文案点元素。`startsWith` 是必需的：面板页签的按钮文本是「逾期1」（标签 + 计数），
 * 带图标的按钮文本是「重算全部」（svg 无文本）。**精确匹配会点不到**。
 */
async function clickByText(selector, text) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到文案以「${text}」开头的 ${selector}`)
  await api.clickAt(point.x, point.y)
}

const textOf = (selector) => `
  return document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null;
`
const disabled = (selector) => `
  return document.querySelector(${JSON.stringify(selector)})?.disabled ?? null;
`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载 TodayView）' })

  // ---------------------------------------------------------------- 统计卡
  check('统计卡四格数字来自 props（7 / 3 / 11 / 42）',
    JSON.stringify(await api.evaluate('return [...document.querySelectorAll(".wb-stat b")].map((el) => el.textContent)')) === JSON.stringify(['7', '3', '11', '42']),
    JSON.stringify(await api.evaluate('return [...document.querySelectorAll(".wb-stat b")].map((el) => el.textContent)')))
  check('统计卡四格标签：逾期 / 今天到期 / 进行中 / 总数',
    JSON.stringify(await api.evaluate('return [...document.querySelectorAll(".wb-stat span")].map((el) => el.textContent)')) === JSON.stringify(['逾期', '今天到期', '进行中', '总数']))

  // ---------------------------------------------------------------- 期限看板
  check('期限看板渲染出来了（data-deadline-board）', await api.evaluate('return document.querySelector("[data-deadline-board]") !== null'))
  check('看板两行（服务端给的两条期限）',
    await api.evaluate('return document.querySelectorAll(".wb-dl-row").length === 2'),
    String(await api.evaluate('return document.querySelectorAll(".wb-dl-row").length')))
  check('看板内容含案号与标签', await api.evaluate('return document.body.textContent.includes("2026-UM-002") && document.body.textContent.includes("答复一通")'))
  check('只有 overdue=1 那条带 overdue 样式（已过期标记由服务端给，界面不自己算）',
    await api.evaluate('return document.querySelectorAll(".wb-dl-row.overdue").length === 1'),
    String(await api.evaluate('return document.querySelectorAll(".wb-dl-row.overdue").length')))
  check('「已过期」文案出现', await api.evaluate('return document.body.textContent.includes("已过期")'))
  check('引擎可用时不显示降级说明', await api.evaluate('return document.querySelector("[data-deadline-degraded]") === null'))

  // ---------------------------------------------------------------- 「重算全部」走到容器回调
  await clickByText('.wb-btn', '重算全部')
  check('点「重算全部」→ 容器的 onRecomputeAll 被调用',
    (await api.evaluate('return __h4.events()')).includes('recomputeAll'),
    JSON.stringify(await api.evaluate('return __h4.events()')))

  // ---------------------------------------------------------------- 空态两个入口
  check('计划页签空态用本视图私有的空态（不是面板兜底文案）',
    await api.evaluate('return document.body.textContent.includes("今天没有需要关注的任务")'))
  check('空态没有走面板兜底的「2026-10-03 没有计划任务」',
    await api.evaluate('return !document.body.textContent.includes("2026-10-03 没有计划任务")'))
  await clickByText('.wb-btn', '快速录入')
  check('点「快速录入」→ 容器 onQuickEntry 被调用',
    (await api.evaluate('return __h4.events()')).includes('quickEntry'))
  await clickByText('.wb-btn', '新建任务')
  check('点「新建任务」→ 容器 onNewTask 被调用',
    (await api.evaluate('return __h4.events()')).includes('newTask'))

  // ---------------------------------------------------------------- day 透传（isToday=false 时按钮文案带日键）
  // 这必须在「计划」页签下做：plan 页签的工具条只在 activeTab === 'plan' 时渲染。
  await api.evaluate('__h4.setIsToday(false); return true;')
  await api.waitFor(`return document.body.textContent.includes("AI 智能排序（2026-10-03）")`, { description: '日键透传到面板' })
  check('面板拿到的是 dayPanelProps.day（非今天时按钮文案带日键）',
    await api.evaluate('return document.body.textContent.includes("AI 智能排序（2026-10-03）")'))
  await api.evaluate('__h4.setIsToday(true); return true;')

  // ---------------------------------------------------------------- 面板页签切换（真的换了树）
  await clickByText('[data-day-tabs] .wb-seg', '逾期')
  check('点「逾期」页签 → 生效页签变了', await api.evaluate('return __h4.dayTab() === "overdue"'))
  check('点「逾期」页签 → 树容器跟着换（data-day-tree）',
    await api.evaluate('return document.querySelector("[data-day-tree]")?.dataset.dayTree === "overdue"'),
    String(await api.evaluate('return document.querySelector("[data-day-tree]")?.dataset.dayTree')))
  check('逾期树真的渲染出那一条行',
    await api.evaluate('return document.body.textContent.includes("逾期任务甲")'))

  // ---------------------------------------------------------------- ★ 切页签再切回：面板页签不许丢
  await api.evaluate('__h4.setView("other"); return true;')
  check('切走后今日视图整块卸载',
    await api.evaluate('return document.querySelector("#today-host") === null && document.querySelector("#other-view") !== null'))
  await api.evaluate('__h4.setView("today"); return true;')
  await api.waitFor('return document.querySelector("#today-host") !== null', { description: '今日视图重新挂载' })
  check('★ 切回来后仍是**逾期**页签（state 挂在容器上，视图卸载不重置）',
    await api.evaluate('return __h4.dayTab() === "overdue" && document.querySelector("[data-day-tree]")?.dataset.dayTree === "overdue"'),
    String(await api.evaluate('return document.querySelector("[data-day-tree]")?.dataset.dayTree')))

  // ---------------------------------------------------------------- 引擎降级态
  await api.evaluate('__h4.setEngineAvailable(false); return true;')
  await api.waitFor('return document.querySelector("[data-deadline-degraded]") !== null', { description: '降级说明出现' })
  check('引擎不可用 → 看板说出降级原因（空看板必须能自证）',
    await api.evaluate('return document.body.textContent.includes("未探测到期限引擎")'))
  check('引擎不可用 → 「重算全部」禁用',
    (await api.evaluate(disabled('[data-deadline-recompute]'))) === true)
  await api.evaluate('__h4.setEngineAvailable(true); return true;')
  await api.waitFor('return document.querySelector("[data-deadline-degraded]") === null', { description: '降级说明消失' })
  check('引擎恢复 → 降级说明消失且按钮可用',
    (await api.evaluate(disabled('[data-deadline-recompute]'))) === false)

  // ---------------------------------------------------------------- busy 态
  await api.evaluate('__h4.setBusy(true); return true;')
  await api.waitFor('return document.querySelector("[data-deadline-recompute]")?.disabled === true', { description: 'busy 时禁用重算' })
  check('busy=true → 「重算全部」禁用（防重复点击）',
    (await api.evaluate(disabled('[data-deadline-recompute]'))) === true)
  await api.evaluate('__h4.setBusy(false); return true;')

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

console.log(failed === 0 ? '\nH4-2 真浏览器验证：全绿' : `\nH4-2 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
