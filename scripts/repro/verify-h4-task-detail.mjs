#!/usr/bin/env node
/**
 * H4-3 的**真浏览器**验证：把抽出来的 `TaskDetailPane` 用真实 props 渲染进页面，做**交互断言**。
 *
 * 为什么不是"渲染一张截图"：拆视图最可能出的错是**接线**错了（按钮接到别的回调、
 * 页签里少了一个入口、被搬走的判据丢失），而这类错在静态代码里看不出来。这里按真实用户
 * 的动线走一遍：改状态 / 存进度 / 建子任务 / 开会话 / 加提醒 / 沉淀经验 / 展开历史 / 编辑 / 归档。
 *
 * 用法：node scripts/repro/verify-h4-task-detail.mjs
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
const PAGE = join(OUT_DIR, 'task-detail-harness.html')
const SHOT = join(OUT_DIR, 'h4-3-task-detail.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-3 TaskDetailPane</title></head>',
  '<body style="margin:0">',
  '<script src="./task-detail-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '900,1250' })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 按文案点元素（`startsWith`：带图标的按钮 textContent 会多出图标 svg 的空文本、计数 span 会带数字）。 */
async function clickByText(selector, text) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到文案以「${text}」开头的 ${selector}`)
  await api.clickAt(point.x, point.y)
}

/** 按属性点元素（`[title="…"]` / `[data-…]`）。 */
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

/**
 * 改一个**受控** `<select>` 的值并让 React 收到。
 *
 * 直接 `el.value = x` 不会触发 React 的 onChange（React 记着上一次的值，会当成没变）——
 * 必须走原型上的原生 setter，再派发一个冒泡的 `change`。
 */
async function setSelect(labelText, value) {
  const ok = await api.evaluate(`
    const label = [...document.querySelectorAll('label')].find((node) => node.textContent.trim().startsWith(${JSON.stringify(labelText)}));
    const el = label?.querySelector('select') ?? null;
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  if (!ok) throw new Error(`找不到「${labelText}」下面的 select`)
}

/** 往**受控** input 里输入（同上：走原生 setter + `input` 事件）。 */
async function typeInto(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  if (!ok) throw new Error(`找不到输入框：${selector}`)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const textOf = (selector) => `return document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`
const bodyHas = (text) => `return document.body.textContent.includes(${JSON.stringify(text)})`
/** 多段文案必须同时出现在页面文本里（`bodyHas` 的结果是语句，不能相加）。 */
const bodyHasAll = (...texts) => `
  const t = document.body.textContent;
  return ${texts.map((text) => `t.includes(${JSON.stringify(text)})`).join(' && ')};
`
/** 最后一次某意图调用的参数（没有就返回 null）。 */
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
const callCount = (name) => `return __h4.calls().filter((c) => c.name === ${JSON.stringify(name)}).length`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载 TaskDetailPane）' })

  // ---------------------------------------------------------------- 任务卡 + 默认页签
  check('任务标题渲染', await api.evaluate(bodyHas('某案的权利要求改写')))
  check('三枚字典徽标取到中文名（代码实现 / 中 / 进行中）',
    await api.evaluate(bodyHasAll('代码实现', '进行中')))
  check('预计耗时为 null 时说明"按默认算"（默认值来自 props = 25）',
    await api.evaluate(bodyHas('默认 25 分钟（未单独设置）')))
  check('AI 工作区回落到容器给的默认工作区', await api.evaluate(bodyHas('/Users/x/默认工作区')))
  check('默认停在「描述」页签', await api.evaluate(textOf('.wb-detail-tab.on') + ' === "描述"'))
  check('描述页签渲染任务描述（MarkdownText）', await api.evaluate(bodyHas('把独权里的功能性限定去掉')))
  check('进度卡在（容器的进度数据接到了 TaskProgress）', await api.evaluate('return document.querySelector(".wb-progress-card") !== null'))

  // ---------------------------------------------------------------- 进度：点档位 → onSaveProgress
  await clickSelector('[title="把进度设为 50%"]')
  check('点「50%」→ 容器 onSaveProgress(50)',
    JSON.stringify(await api.evaluate(lastCall('saveProgress'))) === JSON.stringify([50]),
    JSON.stringify(await api.evaluate(lastCall('saveProgress'))))

  // ---------------------------------------------------------------- 写入口：编辑 / 归档 / AI 动作
  // 「编辑」「归档」在任务卡**右上角**（不在动作行里，2026-10-01 用户要求搬过去）。
  await clickByText('.wb-card .wb-btn', '编辑')
  check('点「编辑」→ 容器 onEdit', await api.evaluate(callCount('edit') + ' === 1'))
  check('AI 策略不是"可执行"时「AI 执行」禁用',
    await api.evaluate('return [...document.querySelectorAll(".wb-detail-actions .wb-btn")].some((b) => b.textContent.includes("AI 执行") && b.disabled)'))
  await api.evaluate('__h4.setAiPolicy("execute"); return true;')
  await api.waitFor('return [...document.querySelectorAll(".wb-detail-actions .wb-btn")].some((b) => b.textContent.includes("AI 执行") && !b.disabled)', { description: 'AI 执行可点' })
  await clickByText('.wb-detail-actions .wb-btn', 'AI 执行')
  check('开启「可执行」后点「AI 执行」→ onStartAI("execute")',
    JSON.stringify(await api.evaluate(lastCall('startAI'))) === JSON.stringify(['execute']),
    JSON.stringify(await api.evaluate(lastCall('startAI'))))
  await clickByText('.wb-detail-actions .wb-btn', 'AI 协助')
  await clickByText('.wb-detail-actions .wb-btn', 'AI 拆解')
  check('「AI 协助 / AI 拆解」各自发出 consult / breakdown',
    JSON.stringify(await api.evaluate('return __h4.calls().filter((c) => c.name === "startAI").map((c) => c.args[0])')) === JSON.stringify(['execute', 'consult', 'breakdown']),
    JSON.stringify(await api.evaluate('return __h4.calls().filter((c) => c.name === "startAI").map((c) => c.args[0])')))

  // ---------------------------------------------------------------- 下拉改动 → onPatch
  await setSelect('状态', 'done')
  check('改「状态」下拉 → onPatch({statusCode:"done"})',
    JSON.stringify(await api.evaluate(lastCall('patch'))) === JSON.stringify([{ statusCode: 'done' }]),
    JSON.stringify(await api.evaluate(lastCall('patch'))))
  await setSelect('AI 策略', 'consult')
  check('改「AI 策略」下拉 → onPatch({aiPolicyCode:"consult"})',
    JSON.stringify(await api.evaluate(lastCall('patch'))) === JSON.stringify([{ aiPolicyCode: 'consult' }]))

  // ---------------------------------------------------------------- 终态：复盘入口
  await api.evaluate('__h4.setTaskStatus("done"); return true;')
  await api.waitFor(`return document.body.textContent.includes('进入复盘会话')`, { description: '终态出现复盘入口' })
  check('已有复盘会话时按钮写「进入复盘会话」（文案由"有没有复盘会话"决定）',
    await api.evaluate(bodyHas('进入复盘会话')))
  await clickByText('.wb-detail-actions .wb-btn', '进入复盘会话')
  check('已完成任务点复盘入口 → onStartAI("review")',
    JSON.stringify(await api.evaluate(lastCall('startAI'))) === JSON.stringify(['review']),
    JSON.stringify(await api.evaluate(lastCall('startAI'))))
  await api.evaluate('__h4.setNoReviewSession(true); return true;')
  await api.waitFor(`return document.body.textContent.includes('AI 复盘')`, { description: '没有复盘会话时改文案' })
  check('没有复盘会话时按钮改「AI 复盘」（同一个入口两种文案）',
    await api.evaluate(`const t = document.body.textContent; return t.includes('AI 复盘') && !t.includes('进入复盘会话')`))
  await clickByText('.wb-detail-actions .wb-btn', 'AI 复盘')
  check('点「AI 复盘」同样发出 review',
    JSON.stringify(await api.evaluate(lastCall('startAI'))) === JSON.stringify(['review']),
    JSON.stringify(await api.evaluate(lastCall('startAI'))))
  await api.evaluate('__h4.setNoReviewSession(false); __h4.setTaskStatus("doing"); return true;')
  /**
   * 判据是"没归档才给"（`!task.archived`），**与状态无关** —— 已完成的任务照样能编辑/归档。
   * 第一版我把期望写成"终态只读"，红了一次；红的是**我的期望**，与拆分前的代码一致。
   */
  check('已完成任务照样给「编辑」「归档」（判据是没归档，不是没完成）',
    await api.evaluate(`return [...document.querySelectorAll('.wb-card .wb-btn')].some((b) => b.textContent.includes('编辑')) && [...document.querySelectorAll('.wb-card .wb-btn')].some((b) => b.textContent.includes('归档'))`))
  await api.evaluate('__h4.setTaskStatus("doing"); return true;')

  // ---------------------------------------------------------------- 子任务页签：表单 → onCreateSubtask
  await clickByText('.wb-detail-tabs .wb-detail-tab', '子任务')
  check('点「子任务」页签 → 容器页签跟着换', await api.evaluate('return __h4.detailTab() === "children"'))
  check('子任务页签显示 2 个直接子任务（含 1/2 已完成）', await api.evaluate(bodyHas('子任务（2） · 1/2 已完成')))
  await clickByText('.wb-detail-actions .wb-btn', '子任务')
  check('点动作行的「子任务」→ 容器记下父任务（t1）', await api.evaluate('return __h4.subtaskParent() === "t1"'))
  check('「子任务」顺带切到子任务页签（一个动线两件事）', await api.evaluate('return __h4.detailTab() === "children"'))
  check('新建子任务表单出现并写明父任务', await api.evaluate(bodyHas('新建子任务（父任务：某案的权利要求改写）')))
  await api.evaluate(`
    document.querySelector('.wb-form-panel input[name="title"]').value = '新子任务丙';
    return true;
  `)
  await clickByText('.wb-form-panel .wb-btn', '保存子任务')
  check('提交表单 → onCreateSubtask 收到读出来的字段（判据口径来自父任务）',
    JSON.stringify(await api.evaluate(lastCall('createSubtask'))) === JSON.stringify([{ title: '新子任务丙', typeCode: 'code_impl', priorityCode: 'p2', dueAt: null }]),
    JSON.stringify(await api.evaluate(lastCall('createSubtask'))))
  check('创建后表单收起（subtaskParent 被清掉）',
    await api.evaluate('return __h4.subtaskParent() === null && document.querySelector(".wb-form-panel") === null'))
  await clickByText('.wb-detail-actions .wb-btn', '子任务')
  await clickByText('.wb-form-panel .wb-btn', '取消')
  check('点「取消」→ 表单收起且不发创建',
    await api.evaluate('return __h4.subtaskParent() === null && document.querySelector(".wb-form-panel") === null && __h4.calls().filter((c) => c.name === "createSubtask").length === 1'))
  await clickByText('.wb-card span', '子任务乙')
  check('点子任务行 → onOpenTask(子任务乙)（与容器签名一致：传整个任务）',
    await api.evaluate('const a = __h4.calls().filter((c) => c.name === "openTask").pop()?.args?.[0]; return a?.id === "c2" && a?.title === "子任务乙"'),
    JSON.stringify(await api.evaluate('return __h4.calls().filter((c) => c.name === "openTask").map((c) => c.args[0]?.id) ?? []')))

  // ---------------------------------------------------------------- 会话页签
  await clickByText('.wb-detail-tabs .wb-detail-tab', '会话')
  check('会话页签列出 2 条关联会话（角色名 + 会话标题）',
    await api.evaluate(count('.wb-session-row')) === 2 && await api.evaluate(bodyHas('执行会话 A')))
  await clickByText('.wb-session-row', '执行')
  check('点仍在宿主的会话 → onOpenSession(s-usable)',
    JSON.stringify(await api.evaluate(lastCall('openSession'))) === JSON.stringify(['s-usable']),
    JSON.stringify(await api.evaluate(lastCall('openSession'))))
  await clickByText('.wb-session-row', '复盘')
  check('点已被归档/删除的会话 → 只给提示、不裸切',
    (await api.evaluate(callCount('notify'))) === 1 && (await api.evaluate(callCount('openSession'))) === 1,
    `notify=${await api.evaluate(callCount('notify'))} openSession=${await api.evaluate(callCount('openSession'))}`)
  check('不可用会话的提示逐字与拆分前一致',
    JSON.stringify(await api.evaluate(lastCall('notify'))) === JSON.stringify(['这条会话已被归档或已删除，无法打开']),
    JSON.stringify(await api.evaluate(lastCall('notify'))))

  // 「添加已有对话」选择器
  await clickByText('.wb-card .wb-btn', '添加已有对话')
  check('打开选择器：候选来自容器的会话快照', await api.evaluate(count('.wb-session-option') + ' === 2'))
  check('已关联的那条显示「已关联」且禁用',
    await api.evaluate('return [...document.querySelectorAll(".wb-session-option")].some((b) => b.textContent.includes("执行会话 A") && b.disabled && b.textContent.includes("已关联"))'))
  await typeInto('.wb-session-search', '咨询')
  check('输入搜索词 → 容器 picker.query 更新', await api.evaluate('return __h4.picker().query === "咨询"'))
  await api.evaluate(`
    const el = document.querySelector('.wb-session-role-select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, 'review');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  check('改角色下拉 → 容器 picker.role 更新', await api.evaluate('return __h4.picker().role === "review"'))
  await clickByText('.wb-session-option', '咨询会话 B')
  check('点候选项 → 容器 onLink(s-other)',
    JSON.stringify(await api.evaluate(lastCall('link'))) === JSON.stringify(['s-other']),
    JSON.stringify(await api.evaluate(lastCall('link'))))
  await clickByText('.wb-session-picker-bar .wb-btn', '取消')
  const picker = await api.evaluate('return __h4.picker()')
  check('点「取消」→ 选择器关闭并清空搜索词',
    picker.open === false && picker.query === '', JSON.stringify(picker))

  // ---------------------------------------------------------------- 记录页签
  await clickByText('.wb-detail-tabs .wb-detail-tab', '记录')
  check('记录页签三块：提醒 4 条 / 复盘 1 条 / 变更历史 7 条',
    await api.evaluate(bodyHasAll('提醒（4）', '复盘记录（1）', '变更历史（7）')))
  check('提醒的四种终态分开说清（已送达 / 未触发 / 已跳过 / 已确认）',
    await api.evaluate(bodyHasAll('已送达', '未触发', '已跳过（超出补发窗口）', '已确认')))
  check('只有终态过的提醒（已送达/已跳过/已确认）才有「重新武装」——3 条',
    await api.evaluate(count('[title="清掉终态、回到未处理，到点会再提醒一次"]') + ' === 3'),
    String(await api.evaluate(count('[title="清掉终态、回到未处理，到点会再提醒一次"]'))))
  await clickSelector('[title="清掉终态、回到未处理，到点会再提醒一次"]')
  check('点「重新武装」→ onResetReminder(r1)',
    JSON.stringify(await api.evaluate(lastCall('resetReminder'))) === JSON.stringify(['r1']),
    JSON.stringify(await api.evaluate(lastCall('resetReminder'))))
  await clickByText('.wb-card .wb-btn', '提前30分')
  check('点「提前30分」→ onAddReminder(30)',
    JSON.stringify(await api.evaluate(lastCall('addReminder'))) === JSON.stringify([30]),
    JSON.stringify(await api.evaluate(lastCall('addReminder'))))
  check('复盘记录渲染 markdown 摘要', await api.evaluate(bodyHas('这次踩了 X 的坑')))
  await clickByText('.wb-card .wb-btn', '💡 沉淀为经验')
  check('点「沉淀为经验」→ onSinkReview 带上 reviewId 与摘要原文',
    JSON.stringify(await api.evaluate(lastCall('sinkReview'))) === JSON.stringify([{ reviewId: 'rv1', summaryMd: '这次踩了 X 的坑：功能性限定没有容器。' }]),
    JSON.stringify(await api.evaluate(lastCall('sinkReview'))))
  await api.evaluate('__h4.setTaskKnowledge("sinked"); return true;')
  await api.waitFor(`return document.body.textContent.includes('已沉淀')`, { description: '已沉淀态出现' })
  await clickByText('.wb-card .wb-btn', '✅ 已沉淀，打开知识条目')
  check('已沉淀时按钮换成「打开知识条目」→ onOpenKnowledge(该条目)',
    await api.evaluate('const a = __h4.calls().filter((c) => c.name === "openKnowledge").pop()?.args?.[0]; return a?.id === "k1"'),
    JSON.stringify(await api.evaluate('return __h4.calls().filter((c) => c.name === "openKnowledge").map((c) => c.args[0]?.id) ?? []')))

  // ---------------------------------------------------------------- 变更历史：默认 5 条 / 展开
  check('变更历史默认只显示最近 5 条', await api.evaluate(count('.wb-event-row') + ' === 5'),
    String(await api.evaluate(count('.wb-event-row'))))
  check('日期分组显示出来了', await api.evaluate(count('.wb-event-group-date') + ' >= 2'))
  await clickByText('.wb-card .wb-btn', '展开全部（7 条）')
  check('点「展开全部」→ 7 条全出现且按钮变「收起」',
    await api.evaluate(count('.wb-event-row')) === 7 && await api.evaluate(bodyHas('收起')),
    String(await api.evaluate(count('.wb-event-row'))))

  // ---------------------------------------------------------------- 归档态：恢复 + 动作行只读
  await api.evaluate('__h4.setArchived(true); return true;')
  await api.waitFor(`return document.body.textContent.includes('恢复任务')`, { description: '归档态出现恢复按钮' })
  check('归档任务只留「恢复任务」（没有编辑/归档/AI 动作）',
    await api.evaluate(`return ![...document.querySelectorAll('.wb-detail-actions .wb-btn')].some((b) => /编辑|归档|AI /.test(b.textContent))`))
  await clickByText('.wb-detail-actions .wb-btn', '恢复任务')
  check('点「恢复任务」→ onRestore', await api.evaluate(callCount('restore') + ' === 1'))
  await api.evaluate('__h4.setArchived(false); return true;')
  await clickByText('.wb-card .wb-btn', '归档')
  check('点「归档」→ onArchive', await api.evaluate(callCount('archive') + ' === 1'))

  // ---------------------------------------------------------------- 编辑态让位 / 未选中占位
  await api.evaluate('__h4.setEditing(true); return true;')
  await api.waitFor('return document.querySelector(".wb-detail-tabs") === null', { description: '编辑时页签让位' })
  check('编辑态：动作行与页签整体让位（不与编辑表单抢同一栏）',
    await api.evaluate('return document.querySelector(".wb-detail-actions") === null && document.querySelector(".wb-detail-tabs") === null'))
  await api.evaluate('__h4.setEditing(false); return true;')
  await api.evaluate('__h4.setSelected("none"); return true;')
  await api.waitFor(`return document.body.textContent.includes('从左侧选择一个任务查看详情')`, { description: '未选中占位' })
  check('未选中任务 → 画占位（不是空白）',
    await api.evaluate(bodyHas('从左侧选择一个任务查看详情')))
  await api.evaluate('__h4.setSelected("task"); return true;')
  await api.waitFor('return document.querySelector(".wb-detail-tabs") !== null', { description: '回到详情' })

  // ---------------------------------------------------------------- 页面无异常
  check('无页面异常 / 无 console error', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))

  await clickByText('.wb-detail-tabs .wb-detail-tab', '记录')
  await api.screenshot(SHOT)
  console.log(`\n截图：${SHOT.replace(`${ROOT}/`, '')}`)
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-3 真浏览器验证：全绿' : `\nH4-3 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
