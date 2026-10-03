#!/usr/bin/env node
/**
 * H4-8（第 3 批）的**真浏览器**验证：新建任务 / 编辑任务两张表单。
 *
 * 对照物尽量用**生产实现**：字典文案照 `src/db/seed.ts` 的出厂值、编辑草稿的期望时段用生产的
 * `toLocalInput` 现算（驱动不手写随时区漂移的本地时间）。退化成记录器的只有"意图 → 请求"三处
 * （POST / PATCH / 打开目录浏览弹窗），它们都验"事件能否被 preventDefault"和"FormData 实际读到什么"。
 *
 * 用法：node scripts/repro/verify-h4-task-forms.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 缺浏览器或脚手架构建失败（都打清楚原因）
 *
 * ## 顺带发现的**既有缺陷**（本步不修，见 subtasks.md 的「顺手发现」）
 *
 * 两张表单的耗时输入是 `min={1} step={5}`：原生校验以 `min` 为基准，合法值只有 1、6、11…，
 * 于是"填 30（正好是默认值）"会被浏览器弹窗拦住、**整个新建表单提交不了**。
 * 对照 `SettingsModal.tsx` 同类字段写的是 `min={5} step={5}`（基数一致）—— 所以这是漏改。
 * 一行可修（`min={5}` 表示"强制 5 的倍数"，或去掉 `step` 表示"任意整数"），但那是**行为变更**，
 * 不在"纯搬家"这一步里做。驱动用一条断言把现状钉住，修的时候会红。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { launchDebugBrowser } from '../verify/cdp.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..')
const OUT_DIR = join(ROOT, '_local-build', 'h4')
const PAGE = join(OUT_DIR, 'task-forms-harness.html')
const SHOT_NEW = join(OUT_DIR, 'h4-8-new-task.png')
const SHOT_EDIT = join(OUT_DIR, 'h4-8-edit-task.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-8 任务表单</title></head>',
  '<body style="margin:0">',
  '<script src="./task-forms-harness.js"></script>',
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

/** 受控 input 走正规输入路子（绕过 React 的 value tracker 才能触发 onChange）。 */
async function setValue(selector, value, kind = 'input') {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    Object.getOwnPropertyDescriptor(window.HTML${kind === 'input' ? 'Input' : kind === 'select' ? 'Select' : 'TextArea'}Element.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(${JSON.stringify(kind === 'select' ? 'change' : 'input')}, { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到 ${kind}：${selector}`)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const text = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent.trim()`
const inputValue = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.value`
const attr = (selector, name) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.getAttribute(${JSON.stringify(name)})`
const optionTexts = (selector) => `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((o) => o.textContent.trim())`
const optionValues = (selector) => `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((o) => o.value)`
const state = 'return __h4.state()'
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
const dialogTitle = text('.wb-dialog-head h3')
const open = async (target) => { await api.evaluate(`__h4.show(${JSON.stringify(target)}); return true`) }

/** 新建表单：`label` 按 DOM 顺序编号（标题 1 / 类型 2 / 优先级 3 / 状态 4 / 截止 5 / 耗时 6 / 全天 7 / 描述 8）。 */
const newLabel = (n) => `#wb-new-task-form > label:nth-of-type(${n})`
/** 编辑表单：`label` 按 DOM 顺序编号（标题 1 / 类型 2 / 优先级 3 / 状态 4 / AI 策略 5 / 截止 6 / 耗时 7 / 全天 8 / 描述 9 / 父任务 10）。 */
const editLabel = (n) => `.wb-dialog-body > .wb-form > label:nth-of-type(${n})`
const EDIT_SAVE = '.wb-dialog-foot .wb-btn.primary'

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪' })

  // ================================================================ A. 新建任务
  await open('new')
  await api.waitFor(`return document.querySelector('#wb-new-task-form') !== null`, { description: '新建任务弹窗打开' })
  check('标题「新建任务」；表单 id 是 `wb-new-task-form`',
    (await api.evaluate(dialogTitle) ?? '').includes('新建任务')
    && await api.evaluate(count('#wb-new-task-form')) === 1, String(await api.evaluate(dialogTitle)))
  check('打开新建任务时**不会**同时渲染编辑表单（一个入口一张弹窗）',
    await api.evaluate(count('.wb-dialog')) === 1 && await api.evaluate(count('#wb-new-task-form')) === 1
    && await api.evaluate(count('.wb-dialog-foot')) === 0, '新建表单的动作按钮在表单里，没有弹窗 footer')
  check('标题字段带 `required` 且为空（必填靠浏览器原生校验，不靠手写提示）',
    await api.evaluate(attr(`${newLabel(1)} input`, 'required')) === ''
    && await api.evaluate(inputValue(`${newLabel(1)} input`)) === '')
  check('类型下拉 = 出厂 9 条（顺序即 sortOrder），默认选中 client_meeting',
    JSON.stringify(await api.evaluate(optionTexts(`${newLabel(2)} select option`))) === JSON.stringify(
      ['客户交流', '代码实现', '功能优化', '方案设计', '老板要求', '团队管理', '项目交付', '个人生活', '培训学习'])
    && await api.evaluate(inputValue(`${newLabel(2)} select`)) === 'client_meeting')
  check('优先级下拉 = 4 条，默认 p2（普通）',
    JSON.stringify(await api.evaluate(optionTexts(`${newLabel(3)} select option`))) === JSON.stringify(['紧急', '高', '普通', '低'])
    && await api.evaluate(inputValue(`${newLabel(3)} select`)) === 'p2')
  check('状态下拉 = 6 条，默认 todo（待办）',
    JSON.stringify(await api.evaluate(optionTexts(`${newLabel(4)} select option`))) === JSON.stringify(['待规划', '待办', '进行中', '被阻塞', '已完成', '已取消'])
    && await api.evaluate(inputValue(`${newLabel(4)} select`)) === 'todo')
  check('截止时间是 `datetime-local` 且初始为空（新建不预填，与编辑态不同）',
    await api.evaluate(attr(`${newLabel(5)} input`, 'type')) === 'datetime-local'
    && await api.evaluate(inputValue(`${newLabel(5)} input`)) === '')
  check('耗时：数字输入、1–1440、步长 5，占位写明「留空 = 默认 30 分钟」',
    await api.evaluate(attr(`${newLabel(6)} input`, 'type')) === 'number'
    && await api.evaluate(attr(`${newLabel(6)} input`, 'min')) === '1'
    && await api.evaluate(attr(`${newLabel(6)} input`, 'max')) === '1440'
    && await api.evaluate(attr(`${newLabel(6)} input`, 'step')) === '5'
    && await api.evaluate(`const el = document.querySelector(${JSON.stringify(`${newLabel(6)} input`)}); return el.placeholder`) === '留空 = 默认 30 分钟')
  check('全天任务：默认不勾，且旁边写明「只影响显示，不改变候选排序」',
    await api.evaluate(`return document.querySelector(${JSON.stringify(`${newLabel(7)} input[type=checkbox]`)}).checked`) === false
    && (await api.evaluate(text(newLabel(7))) ?? '').includes('只影响显示，不改变候选排序'))
  check('工作区选择器：来源说明「留空 = 用默认工作区」，手打框占位 = 容器给的默认工作区',
    (await api.evaluate(text('.wb-field-note')) ?? '') === '留空 = 用默认工作区'
    && await api.evaluate(`const el = document.querySelector('.wb-field input[data-workspace-input]'); return el.placeholder`) === '/Users/xujian/projects/default')
  check('工作区候选下拉 = 空选项 + 两条候选（带「最近 / 默认」来源标签）',
    JSON.stringify(await api.evaluate(optionTexts('.wb-field select[data-workspace-select] option'))) === JSON.stringify(
      ['选择已有工作区…', '最近 · /Users/xujian/projects/matters/2025-UM-118', '默认 · /Users/xujian/projects/default']),
    JSON.stringify(await api.evaluate(optionTexts('.wb-field select[data-workspace-select] option'))))
  check('非受控表单里工作区靠 hidden 输入进 FormData：`type=hidden` + `name=workspacePath`，值 = 容器的受控值',
    await api.evaluate(attr('#wb-new-task-form input[type=hidden]', 'name')) === 'workspacePath'
    && await api.evaluate(inputValue('#wb-new-task-form input[type=hidden]')) === '')
  await clickByText('.wb-field', '浏览')
  check('点「浏览…」→ 容器收到 browse(\'form\')（起始目录由容器按入口判定）',
    JSON.stringify(await api.evaluate(lastCall('browse'))) === JSON.stringify(['form']))
  await api.evaluate(`__h4.applyWorkspaceDir('/Users/xujian/projects/matters/2025-UM-118'); return true`)
  await api.waitFor(`return document.querySelector('#wb-new-task-form input[type=hidden]').value !== ''`, { description: '浏览选完写回受控值' })
  check('浏览选完 → 受控值写回容器、手打框与 hidden 输入同步跟着变（一条链路，不是第二份 state）',
    await api.evaluate(inputValue('#wb-new-task-form input[type=hidden]')) === '/Users/xujian/projects/matters/2025-UM-118'
    && await api.evaluate(inputValue('.wb-field input[data-workspace-input]')) === '/Users/xujian/projects/matters/2025-UM-118'
    && (await api.evaluate(state)).formWorkspace === '/Users/xujian/projects/matters/2025-UM-118')

  // 空必填时点保存：浏览器原生校验拦住，容器收不到提交
  await clickByText('#wb-new-task-form > .full:last-of-type', '保存任务')
  check('必填为空时点保存 → **不提交**（原生校验拦住，说明 required 真落在 DOM 上）',
    JSON.stringify(await api.evaluate(lastCall('newSubmit'))) === 'null')
  await setValue(`${newLabel(1)} input`, '答复第一次审查意见')
  await setValue(`${newLabel(2)} select`, 'code_impl', 'select')
  await setValue(`${newLabel(3)} select`, 'p1', 'select')
  /**
   * ⚠️ 下面这条钉的是**既有缺陷**（HEAD 就是 `min={1} step={5}`，step 以 `min` 为基准，
   * 合法值只有 1、6、11…）：填「默认的 30 分钟」会被浏览器原生校验弹窗拦住，整个表单提交不了。
   * 本步是纯搬家、不改行为 —— 所以把现状**钉住**（修掉它这条会变红，提醒同步更新；不修则一直可见）。
   */
  await setValue(`${newLabel(6)} input`, '30')
  check('⚠️ 既有缺陷：耗时填 30 → 原生校验判定非法（合法值只有 1/6/11…，`step` 与 `min` 不同基）',
    await api.evaluate(`return document.querySelector('#wb-new-task-form').checkValidity() === false`),
    'HEAD 既有，非本步引入；修法见脚本尾注')
  await setValue(`${newLabel(6)} input`, '86')
  check('填一个步进合法的值（86 = 1 + 5×17）→ 表单恢复可提交（证明拦住的是校验、不是别的）',
    await api.evaluate(`return document.querySelector('#wb-new-task-form').checkValidity() === true`))
  await clickSelector(`${newLabel(7)} input[type=checkbox]`)
  await clickByText('#wb-new-task-form > .full:last-of-type', '保存任务')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'newSubmit')`, { description: '新建提交到容器' })
  const newArgs = (await api.evaluate(lastCall('newSubmit')))[0]
  check('填齐后点保存 → 容器收到提交，且事件可被 preventDefault 并已被拦住（否则整页跳走）',
    newArgs.cancelable === true && newArgs.defaultPrevented === true, JSON.stringify(newArgs))
  check('FormData 里能读到全部非受控字段（标题 / 类型 / 优先级 / 状态 / 耗时 / 勾选 / hidden 工作区）',
    newArgs.form.title === '答复第一次审查意见' && newArgs.form.type === 'code_impl'
    && newArgs.form.priority === 'p1' && newArgs.form.status === 'todo'
    && newArgs.form.estimatedMinutes === '86' && newArgs.form.allDay === 'true'
    && newArgs.form.workspacePath === '/Users/xujian/projects/matters/2025-UM-118',
    JSON.stringify(newArgs.form))
  await api.evaluate('__h4.setBusy(true); return true')
  check('busy：工作区选择器的下拉 / 手打框 / 「浏览…」都禁用（忙碌时不许改工作区）',
    (await api.evaluate(state)).busy === true
    && await api.evaluate(`return document.querySelector('.wb-field select[data-workspace-select]').disabled === true`)
    && await api.evaluate(`return document.querySelector('.wb-field input[data-workspace-input]').disabled === true`)
    && await api.evaluate(`return document.querySelector('.wb-field button[data-workspace-browse]').disabled === true`))
  await api.evaluate('__h4.setBusy(false); return true')
  await api.screenshot(SHOT_NEW)
  await clickByText('#wb-new-task-form > .full:last-of-type', '取消')
  await api.waitFor(`return document.querySelector('#wb-new-task-form') === null`, { description: '取消后收起' })
  check('点「取消」→ 容器收到关闭（与保存是两条路径，取消不发请求）',
    JSON.stringify(await api.evaluate(lastCall('newClose'))) === JSON.stringify([]))

  // ================================================================ B. 编辑任务
  await open('edit')
  await api.waitFor(`return document.querySelector('.wb-dialog-body > .wb-form') !== null`, { description: '编辑任务弹窗打开' })
  check('标题「编辑任务」；编辑表单是 `.wb-form` 且去掉了那套边框/内边距（嵌在弹窗里不需要）',
    (await api.evaluate(dialogTitle) ?? '').includes('编辑任务')
    && await api.evaluate(`const el = document.querySelector('.wb-dialog-body > .wb-form'); return el.style.borderStyle === 'none' && (el.style.padding === '0px' || el.style.padding === '0')`),
    await api.evaluate(attr('.wb-dialog-body > .wb-form', 'style')))
  check('编辑态带出原值：标题 / 描述（Markdown 原文）',
    await api.evaluate(inputValue(`${editLabel(1)} input`)) === '答复第一次审查意见'
    && await api.evaluate(inputValue(`${editLabel(9)} textarea`)) === '**要点**：独权缺少必要技术特征。')
  check('类型 / 优先级 / 状态下拉选中的是草稿里的 code（不是第一条）',
    await api.evaluate(inputValue(`${editLabel(2)} select`)) === 'code_impl'
    && await api.evaluate(inputValue(`${editLabel(3)} select`)) === 'p1'
    && await api.evaluate(inputValue(`${editLabel(4)} select`)) === 'doing')
  check('AI 策略下拉 = 3 条（不允许 / 可咨询 / 可执行），选中 consult',
    JSON.stringify(await api.evaluate(optionTexts(`${editLabel(5)} select option`))) === JSON.stringify(['不允许', '可咨询', '可执行'])
    && await api.evaluate(inputValue(`${editLabel(5)} select`)) === 'consult')
  const dueLocal = (await api.evaluate(state)).editDraft.dueLocal
  check('截止时间 = 容器 `toLocalInput(dueAt)` 的本地串（受控，不是原始 ISO）',
    await api.evaluate(inputValue(`${editLabel(6)} input`)) === dueLocal
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dueLocal), dueLocal)
  check('耗时：受控值为草稿的 "90"，占位与新建弹窗**逐字相同**（同字段两入口一套说法）',
    await api.evaluate(inputValue(`${editLabel(7)} input`)) === '90'
    && await api.evaluate(`const el = document.querySelector(${JSON.stringify(`${editLabel(7)} input`)}); return el.placeholder`) === '留空 = 默认 30 分钟')
  check('耗时下方说明：写清它参与候选排序、留空按默认 30 分钟计入',
    (await api.evaluate(text('.wb-dialog-body > .wb-form > p.wb-hint')) ?? '') === '耗时参与当日候选排序；留空 = 按默认 30 分钟计入。',
    String(await api.evaluate(text('.wb-dialog-body > .wb-form > p.wb-hint'))))
  check('全天任务勾选框反映草稿（false → 未勾）；说明文案与新建弹窗一致',
    await api.evaluate(`return document.querySelector(${JSON.stringify(`${editLabel(8)} input[type=checkbox]`)}).checked`) === false
    && (await api.evaluate(text(editLabel(8))) ?? '').includes('只影响显示，不改变候选排序'))
  await clickSelector(`${editLabel(8)} input[type=checkbox]`)
  check('勾全天 → 写回容器草稿 allDay=true（受控，弹窗不存副本）',
    (await api.evaluate(state)).editDraft.allDay === true)
  check('工作区选择器：来源说明是编辑入口那句「留空 = 继承父任务，父任务也没有才用默认」',
    (await api.evaluate(text('.wb-field-note')) ?? '') === '留空 = 继承父任务，父任务也没有才用默认',
    String(await api.evaluate(text('.wb-field-note'))))
  check('编辑态工作区**没有** hidden 输入（编辑走 PATCH 的草稿载荷，不读 FormData）',
    await api.evaluate(count('#wb-new-task-form')) === 0
    && await api.evaluate(count('.wb-dialog-body input[type=hidden]')) === 0)
  await clickByText('.wb-field', '浏览')
  check('点「浏览…」→ 容器收到 browse(\'edit\')（与新建入口分开，起始目录不同）',
    JSON.stringify(await api.evaluate(lastCall('browse'))) === JSON.stringify(['edit']))
  check('父任务下拉 = 「（顶层）」+ 3 条候选，缩进按 depth 用不换行空格（0 / 2 / 4 个）',
    await api.evaluate(count(`${editLabel(10)} select option`)) === 4
    && await api.evaluate(`return document.querySelector('${editLabel(10)} select option').value`) === ''
    && JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('${editLabel(10)} select option')].map((o) => o.textContent)`)
    ) === JSON.stringify(['（顶层）', '父任务', '\u00a0\u00a0子任务', '\u00a0\u00a0\u00a0\u00a0孙任务']),
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('${editLabel(10)} select option')].map((o) => o.textContent)`)))
  check('父任务下拉选中的是草稿的 parentId（t-2），不是空',
    await api.evaluate(inputValue(`${editLabel(10)} select`)) === 't-2')
  check('父任务下方的防环说明在（"服务端另有独立防环校验"）',
    (await api.evaluate(`return document.querySelectorAll('.wb-dialog-body > .wb-form > p.wb-hint')[1].textContent`) ?? '').includes('服务端另有独立防环校验'))
  await setValue(`${editLabel(10)} select`, 't-3', 'select')
  check('改父任务 → 写回容器草稿 parentId（受控）',
    (await api.evaluate(state)).editDraft.parentId === 't-3')
  await setValue(`${editLabel(1)} input`, '答复第二次审查意见')
  check('改标题 → 写回容器草稿（同一份 `EditTaskDraft`，弹窗自己不存副本）',
    (await api.evaluate(state)).editDraft.title === '答复第二次审查意见')
  await setValue(`${editLabel(1)} input`, '   ')
  check('标题全是空白 → 底部「保存」禁用（离线校验，不靠服务端 400）',
    await api.evaluate(`return document.querySelector(${JSON.stringify(EDIT_SAVE)}).disabled === true`))
  await clickSelector(EDIT_SAVE)
  check('禁用状态下点保存 → 容器收不到 onSave（按钮真的不可点，不是只改了样式）',
    JSON.stringify(await api.evaluate(lastCall('editSave'))) === 'null')
  await setValue(`${editLabel(1)} input`, '答复第二次审查意见')
  await clickSelector(EDIT_SAVE)
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'editSave')`, { description: '编辑保存意图到容器' })
  const saveArgs = (await api.evaluate(lastCall('editSave')))[0]
  check('点「保存」→ 容器拿到**整份草稿**（标题 / 父任务 / 全天都是刚改过的值）',
    saveArgs.title === '答复第二次审查意见' && saveArgs.parentId === 't-3' && saveArgs.allDay === true,
    JSON.stringify({ title: saveArgs.title, parentId: saveArgs.parentId, allDay: saveArgs.allDay }))
  check('草稿里保留着原值的字段没被顺手改写（类型 / 状态 / AI 策略 / 耗时 / 工作区）',
    saveArgs.typeCode === 'code_impl' && saveArgs.statusCode === 'doing' && saveArgs.aiPolicyCode === 'consult'
    && saveArgs.estimatedMinutes === '90' && saveArgs.workspacePath === '/Users/xujian/projects/matters/2025-UM-118')
  await api.screenshot(SHOT_EDIT)
  await clickByText('.wb-dialog-foot', '取消')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'editClose')`, { description: '编辑取消' })
  check('点「取消」→ 容器收到关闭且草稿清空（不留半份脏状态给下一次打开）',
    JSON.stringify(await api.evaluate(lastCall('editClose'))) === JSON.stringify([])
    && (await api.evaluate(state)).editDraft === null)

  // ================================================================ C. 两处一致性与收尾
  await open('edit')
  await api.waitFor(`return document.querySelector('.wb-dialog-body > .wb-form') !== null`, { description: '再次打开编辑' })
  const editPlaceholder = await api.evaluate(`const el = document.querySelector(${JSON.stringify(`${editLabel(7)} input`)}); return el.placeholder`)
  await open('new')
  await api.waitFor(`return document.querySelector('#wb-new-task-form') !== null`, { description: '再次打开新建' })
  const newPlaceholder = await api.evaluate(`const el = document.querySelector(${JSON.stringify(`${newLabel(6)} input`)}); return el.placeholder`)
  check('同一字段两个入口的耗时占位逐字相同（默认值来自同一个 30，不是各写各的）',
    newPlaceholder === editPlaceholder, `${newPlaceholder} vs ${editPlaceholder}`)
  check('重新打开后工作区被清空（容器 `if (showForm) setFormWorkspace(\'\')` 那条还在起作用）',
    await api.evaluate(inputValue('#wb-new-task-form input[type=hidden]')) === '')
  await clickSelector('.wb-dialog-close')
  await api.waitFor(`return document.querySelector('#wb-new-task-form') === null`, { description: '点 × 收起' })
  check('点 × → 与「取消」走同一条关闭路径（容器只认一个关闭意图）',
    JSON.stringify(await api.evaluate(lastCall('newClose'))) === JSON.stringify([]))

  check('两张表单都不发请求 → 全程没有页面异常', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-8 任务表单真浏览器验证：全绿' : `\nH4-8 任务表单真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
