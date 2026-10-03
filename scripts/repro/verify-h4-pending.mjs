#!/usr/bin/env node
/**
 * H4-8（第 4 批）的**真浏览器**验证：「待你处理（N）」弹窗。
 *
 * 对照物尽量用**生产实现**：提醒行与「暂存于 …」的期望文案由生产的 `fmtTime` 现算
 * （驱动不手写随时区漂移的时间），计数由脚手架按容器同一式子
 * （`allPendingDrafts.length + reminders.length`）现算。退化成记录器的只有"意图 → 请求"
 * 三处（POST / 刷新），它们都验"点哪只按钮、记到哪一条 id"。
 *
 * 用法：node scripts/repro/verify-h4-pending.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 缺浏览器或脚手架构建失败（都打清楚原因）
 *
 * ## 覆盖到的、容易改坏的地方
 *
 * - **过滤留在容器**：`allPendingDrafts` 里本来就含已暂存的（`index.tsx` 的
 *   `[res.draft, ...(res.deferredDrafts ?? [])]`），所以"待确认行不重复画已暂存条目"是可验的；
 * - **小节间距跟着在编草稿**：`activeDraftOpen={pendingDraft !== null}`，0px ↔ 10px 两个值都钉住，
 *   并走一遍"resumePending → 关窗 → 重开"的真实回路（容器里 `resumePendingDraft` 会 `setPendingDraft`）；
 * - **计数是现算的**：点掉一条提醒，标题立刻从 5 变 4；只有一条提醒时点掉它 → 标题归 0、
 *   空态提示出现而**弹窗不关**；
 * - **空态**与 `draftKindLabel` 的中文标签（含"暂存次数只有 1 时不显示第 N 次"的对照）。
 *
 * ⚠️ 未覆盖：`fmtTime(draft.deferredAt ?? draft.updatedAt)` 的兜底分支 —— 服务端清单按
 * `deferred_at IS NOT NULL` 过滤（`src/db/repo/drafts.ts`），`deferredAt` 为空的条目到不了这里。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { launchDebugBrowser } from '../verify/cdp.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const OUT_DIR = join(ROOT, '_local-build', 'h4')
const PAGE = join(OUT_DIR, 'pending-harness.html')
const SHOT = join(OUT_DIR, 'h4-8-pending.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-8 待处理弹窗</title></head>',
  '<body style="margin:0">',
  '<script src="./pending-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '1400,900' })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function clickSelector(selector) {
  const point = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到可点击元素：${selector}`)
  await api.clickAt(point.x, point.y)
}

/** 按文案点按钮（`startsWith`：带图标的按钮文本里 svg 无文本）。 */
async function clickByText(scope, label) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} .wb-btn`)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`在 ${scope} 里找不到文案以「${label}」开头的按钮`)
  await api.clickAt(point.x, point.y)
}

/** 在"文案含 `needle` 的那一行"里点按钮 —— 逐行验"点的是哪一条"，不靠 DOM 序号。 */
async function clickInRow(needle, label) {
  const point = await api.evaluate(`
    const row = [...document.querySelectorAll('.wb-scroll-area .wb-row')].find((r) => r.textContent.includes(${JSON.stringify(needle)}));
    const el = row === undefined ? undefined : [...row.querySelectorAll('.wb-btn')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到「${needle}」那行里的「${label}」按钮`)
  await api.clickAt(point.x, point.y)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const text = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent.trim()`
const texts = (selector) => `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.trim())`
const computed = (selector, prop) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : getComputedStyle(el)[${JSON.stringify(prop)}]`
const rowTexts = 'return [...document.querySelectorAll(\'.wb-scroll-area .wb-row\')].map((row) => row.textContent.trim())'
const countRowsStartingWith = (prefix) => `return [...document.querySelectorAll('.wb-scroll-area .wb-row')].filter((row) => row.textContent.trim().startsWith(${JSON.stringify(prefix)})).length`
const state = 'return __h4.state()'
const labels = 'return __h4.labels'
const ids = 'return __h4.ids'
const dialogTitle = text('.wb-dialog-head h3')
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
/** 已暂存小节的容器（「已暂存（N）」那句 `.wb-hint` 的父节点）—— 间距就加在它身上。 */
const deferredSection = `[...document.querySelectorAll('.wb-scroll-area .wb-hint')].find((n) => n.textContent.trim().startsWith('已暂存'))?.parentElement ?? null`
const deferredMarginTop = `return (() => { const s = ${deferredSection}; return s === null ? null : getComputedStyle(s).marginTop })()`
const deferredMarginTopIs = (value) => `const s = ${deferredSection}; return s !== null && getComputedStyle(s).marginTop === ${JSON.stringify(value)}`
const dialogGone = `return document.querySelector('.wb-dialog') === null`
const show = async (mode) => {
  await api.evaluate(`__h4.show(${JSON.stringify(mode)}); return true`)
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: `待处理弹窗打开（${mode}）` })
}

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪' })
  const IDS = await api.evaluate(ids)
  const LABELS = await api.evaluate(labels)

  // ================================================================ A. 全量态：1 条待确认 + 2 条已暂存 + 2 条提醒
  await show('all')
  check('标题「待你处理（5）」= 清单条数 + 提醒条数（现算，不是服务端给的数）',
    (await api.evaluate(dialogTitle) ?? '') === '待你处理（5）', String(await api.evaluate(dialogTitle)))
  check('只渲染这一张弹窗、尺寸 `sm`，footer 只有一个「关闭」',
    await api.evaluate(count('.wb-dialog')) === 1
    && await api.evaluate(count('.wb-dialog.wb-dialog-sm')) === 1
    && JSON.stringify(await api.evaluate(texts('.wb-dialog-foot .wb-btn'))) === JSON.stringify(['关闭']))
  check('待确认行只画 1 条（清单里 3 条，另 2 条 `deferredAt` 非空 → 被容器的过滤挡掉）',
    await api.evaluate(countRowsStartingWith('待确认的')) === 1
    && await api.evaluate(count('.wb-scroll-area > .wb-row')) === 3
    && await api.evaluate(count('.wb-scroll-area .wb-row')) === 5,
    `待确认 ${await api.evaluate(countRowsStartingWith('待确认的'))} 行 / 顶层 ${await api.evaluate(count('.wb-scroll-area > .wb-row'))} 行（含 2 条提醒）/ 全部 ${await api.evaluate(count('.wb-scroll-area .wb-row'))} 行`)
  check('待确认行：标签「待确认的任务草稿」+ 说明「AI 已提交，确认后才会写入工作台。」+ 按钮「打开弹框」',
    await api.evaluate(`return document.querySelector('.wb-scroll-area > .wb-row b').textContent`) === '待确认的任务草稿'
    && (await api.evaluate(text('.wb-scroll-area > .wb-row .wb-switch-desc')) ?? '') === 'AI 已提交，确认后才会写入工作台。'
    && JSON.stringify(await api.evaluate(`return [...document.querySelector('.wb-scroll-area > .wb-row').querySelectorAll('.wb-btn')].map((b) => b.textContent.trim())`)) === JSON.stringify(['打开弹框']),
    JSON.stringify(await api.evaluate(`return { bold: document.querySelector('.wb-scroll-area > .wb-row b').textContent, desc: document.querySelector('.wb-scroll-area > .wb-row .wb-switch-desc').textContent, btns: [...document.querySelector('.wb-scroll-area > .wb-row').querySelectorAll('.wb-btn')].map((b) => b.textContent) }`)))
  check('行不是"看着能点"的样子：`cursor: default`、文本靠上对齐（唯一的动作是行里的按钮）',
    await api.evaluate(computed('.wb-scroll-area > .wb-row', 'cursor')) === 'default'
    && await api.evaluate(computed('.wb-scroll-area > .wb-row', 'alignItems')) === 'flex-start')
  check('已暂存小节抬头：`已暂存（2）· 做完手上的事再从这里唤回`',
    (await api.evaluate(text('.wb-scroll-area .wb-hint')) ?? '') === '已暂存（2）· 做完手上的事再从这里唤回',
    String(await api.evaluate(text('.wb-scroll-area .wb-hint'))))
  check('已暂存两行的标签是中文（知识条目 / 今日计划提案）',
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-hint ~ .wb-row b')].map((b) => b.textContent)`))
    === JSON.stringify(['知识条目', '今日计划提案']))
  check('暂存时刻用生产 `fmtTime` 现算；`deferCount` 1 时不显示「第 N 次」、3 时显示「· 第 3 次」',
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-hint ~ .wb-row .wb-switch-desc')].map((n) => n.textContent.trim())`))
    === JSON.stringify([LABELS.deferred[0], `${LABELS.deferred[1]} · 第 3 次`]),
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-hint ~ .wb-row .wb-switch-desc')].map((n) => n.textContent.trim())`)))
  check('已暂存行的按钮是主按钮「唤回处理」（与待确认的次要按钮在视觉上分开）',
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-scroll-area .wb-btn')].map((b) => [b.textContent.trim(), b.className])`))
    === JSON.stringify([['打开弹框', 'wb-btn'], ['唤回处理', 'wb-btn primary'], ['唤回处理', 'wb-btn primary'], ['知道了', 'wb-btn'], ['知道了', 'wb-btn']]),
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-scroll-area .wb-btn')].map((b) => [b.textContent.trim(), b.className])`)))
  check('提醒行：标题 + 生产 `fmtTime` 算出的到点时刻 + 按钮「知道了」',
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-scroll-area > .wb-row')].slice(1).map((row) => row.textContent.trim())`))
    === JSON.stringify([`${LABELS.reminders[0]}知道了`, `${LABELS.reminders[1]}知道了`]),
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('.wb-scroll-area > .wb-row')].slice(1).map((row) => row.textContent.trim())`)))
  const order = await api.evaluate(`
    const rows = [...document.querySelectorAll('.wb-scroll-area .wb-row')];
    const hint = ${deferredSection};
    const ack = [...document.querySelectorAll('.wb-scroll-area .wb-btn')].find((b) => b.textContent.trim() === '知道了');
    return { activeBeforeHint: (rows[0].compareDocumentPosition(hint) & 4) === 4, hintBeforeAck: (hint.compareDocumentPosition(ack) & 4) === 4 };
  `)
  check('DOM 顺序：待确认行 → 已暂存小节 → 提醒行（一组一段，不按 id 混排）',
    order.activeBeforeHint === true && order.hintBeforeAck === true, JSON.stringify(order))
  check('全量态下不显示空态提示（`pendingCount` 非 0）',
    await api.evaluate(count('.wb-scroll-area > p.wb-hint')) === 0)
  check('「已暂存」小节的间距 = 0px（此刻没有在编草稿：容器传 `pendingDraft === null`）',
    await api.evaluate(deferredMarginTop) === '0px', String(await api.evaluate(deferredMarginTop)))
  await api.screenshot(SHOT)

  // ================================================================ B. 三个动作 + 间距回路
  await clickInRow('今日计划提案', '唤回处理')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'resumeDeferred')`, { description: '唤回意图到容器' })
  check('点第二条「唤回处理」→ 容器收到的是**那一条**的 id（不是首条、不是全部）',
    JSON.stringify(await api.evaluate(lastCall('resumeDeferred'))) === JSON.stringify([IDS.deferred2]),
    JSON.stringify(await api.evaluate(lastCall('resumeDeferred'))))
  await api.waitFor(dialogGone, { description: '唤回后收起' })
  check('唤回后弹窗是**容器自己**关的（`resumeDeferredDraft` 里就是 `setPendingOpen(false)`），没走「关闭」那条意图',
    JSON.stringify(await api.evaluate(lastCall('close'))) === 'null')

  await show('all')
  await clickInRow('待确认的', '打开弹框')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'resumePending')`, { description: '打开弹框意图到容器' })
  check('点「打开弹框」→ 容器收到那份草稿（id + kindCode）',
    JSON.stringify(await api.evaluate(lastCall('resumePending'))) === JSON.stringify([IDS.active, 'task']),
    JSON.stringify(await api.evaluate(lastCall('resumePending'))))
  await api.waitFor(dialogGone, { description: '打开弹框后收起' })
  await api.evaluate('__h4.open(true); return true')
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '重开清单弹窗' })
  check('回路闭环：resumePending 把草稿交给编辑弹框后重开清单 → 间隙变 10px（`pendingDraft !== null`）',
    (await api.evaluate(state)).pendingDraftId === IDS.active
    && await api.evaluate(deferredMarginTop) === '10px', String(await api.evaluate(deferredMarginTop)))
  await api.evaluate('__h4.setActiveDraftOpen(false); return true')
  await api.waitFor(deferredMarginTopIs('0px'), { description: '清掉在编草稿后间距回 0' })
  check('在编草稿清空 → 间距回到 0px（同一个表达式，两个值都钉住），弹窗仍开着',
    (await api.evaluate(state)).open === true)

  await clickInRow('答复第一次审查意见', '知道了')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'ackReminder')`, { description: '知道了意图到容器' })
  check('点第一条「知道了」→ 容器收到那一条提醒 id',
    JSON.stringify(await api.evaluate(lastCall('ackReminder'))) === JSON.stringify([IDS.reminder1]))
  await api.waitFor(`return (__h4.state()).pendingCount === 4`, { description: '回执后计数递减' })
  check('回执后那行消失、标题计数 5 → 4（计数是每次渲染现算的，不是快照）',
    await api.evaluate(count('.wb-scroll-area > .wb-row')) === 2
    && (await api.evaluate(dialogTitle) ?? '') === '待你处理（4）'
    && await api.evaluate(count('.wb-scroll-area > p.wb-hint')) === 0,
    String(await api.evaluate(dialogTitle)))
  await clickByText('.wb-dialog-foot', '关闭')
  await api.waitFor(dialogGone, { description: '关闭收起' })
  check('点 footer「关闭」→ 容器收到关闭意图（不发任何请求）',
    JSON.stringify(await api.evaluate(lastCall('close'))) === JSON.stringify([]))

  // ================================================================ C. 点掉最后一条提醒 → 空态（不关窗）
  await show('only-reminder')
  check('只有一条提醒时：标题「待你处理（1）」、1 行、没有「已暂存」小节',
    (await api.evaluate(dialogTitle) ?? '') === '待你处理（1）'
    && await api.evaluate(count('.wb-scroll-area > .wb-row')) === 1
    && await api.evaluate(count('.wb-scroll-area .wb-hint')) === 0,
    String(await api.evaluate(dialogTitle)))
  await clickInRow('答复第一次审查意见', '知道了')
  await api.waitFor(`return (__h4.state()).pendingCount === 0`, { description: '最后一条提醒被点掉' })
  check('点掉最后一条 → 标题「待你处理（0）」+ 空态提示出现，且**弹窗不关**',
    (await api.evaluate(dialogTitle) ?? '') === '待你处理（0）'
    && (await api.evaluate(text('.wb-scroll-area > p.wb-hint')) ?? '') === '暂无待处理事项。'
    && await api.evaluate(count('.wb-scroll-area > .wb-row')) === 0
    && await api.evaluate(`return document.querySelector('.wb-dialog') !== null`),
    String(await api.evaluate(dialogTitle)))
  await clickSelector('.wb-dialog-close')
  await api.waitFor(dialogGone, { description: '点 × 收起' })
  check('点 × → 与「关闭」走同一条关闭路径（容器只认一个关闭意图）',
    JSON.stringify(await api.evaluate(lastCall('close'))) === JSON.stringify([]))

  // ================================================================ D. 空态直开
  await show('empty')
  check('空态直开：标题「待你处理（0）」+ 一句提示，没有任何行',
    (await api.evaluate(dialogTitle) ?? '') === '待你处理（0）'
    && await api.evaluate(count('.wb-scroll-area .wb-row')) === 0
    && await api.evaluate(count('.wb-scroll-area .wb-hint')) === 1)
  await api.evaluate(`__h4.show(null); return true`)

  check('全程没有页面异常（弹窗不联网：三个动作都只发意图）', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-8 待处理弹窗真浏览器验证：全绿' : `\nH4-8 待处理弹窗真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
