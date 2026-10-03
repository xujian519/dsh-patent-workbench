#!/usr/bin/env node
/**
 * H4-8 的**真浏览器**验证：四张弹窗 —— 建档/编辑案卷、登记官文、到期提醒、同名任务选择。
 *
 * 容器那一侧凡是有纯判定/纯格式化的地方都用**生产实现**当对照物：提醒行的期望文案由
 * `fmtTime`（生产函数）现算后暴露给驱动，初始草稿逐字照抄容器的 `openMatterForm` /
 * `openNoticeForm`。退化成记录器的只有"意图 → 请求"那几处（网络在脚手架里不存在）。
 *
 * 用法：node scripts/repro/verify-h4-dialogs.mjs
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
const PAGE = join(OUT_DIR, 'dialogs-harness.html')
const SHOT_FORM = join(OUT_DIR, 'h4-8-matter-form.png')
const SHOT = join(OUT_DIR, 'h4-8-reminder.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-8 对话框组</title></head>',
  '<body style="margin:0">',
  '<script src="./dialogs-harness.js"></script>',
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

/** 某个元素中心点的坐标（用来点行内按钮这类没有专属类名的元素）。 */
async function pointOf(expression) {
  const point = await api.evaluate(`
    const el = ${expression};
    if (el === null || el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到要点的元素：${expression}`)
  return point
}

/** 受控 input 走正规输入路子（绕过 React 的 value tracker 才能触发 onChange）。 */
async function setInputValue(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到输入框：${selector}`)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const text = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent.trim()`
const state = 'return __h4.state()'
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
const bodyHas = (needle) => `return document.body.textContent.includes(${JSON.stringify(needle)})`
/** 某张弹窗是否在（`which` 是 harness 的"打开哪张"开关）。 */
const openDialog = async (target) => { await api.evaluate(`__h4.show(${JSON.stringify(target)}); return true`) }
const dialogTitle = text('.wb-dialog-head h3')
const optionTexts = (selector) => `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((o) => o.textContent.trim())`
const inputValue = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.value`
/** 表单里的第 n 个 checkbox（0 起）：案卷表单里是「要求优先权」/「PCT 进入中国」。 */
const checkboxAt = (selector, index) => `return document.querySelectorAll(${JSON.stringify(selector)})[${index}].checked`
const requiredOf = (selector) => `return document.querySelector(${JSON.stringify(selector)}).required`
const attr = (selector, name) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.getAttribute(${JSON.stringify(name)})`
const rowLabels = `return [...document.querySelectorAll('.wb-scroll-area .wb-row')].map((el) => el.querySelector('span').textContent.trim())`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪' })
  const reminderLabels = await api.evaluate('return __h4.reminderLabels')

  // ================================================================ A. 建档（新建案卷）
  await openDialog('matter-create')
  await api.waitFor(`return document.querySelector('#wb-matter-form') !== null`, { description: '建档弹窗打开' })
  check('标题由容器判定：新建态 = 「新建案卷」',
    (await api.evaluate(dialogTitle) ?? '').includes('新建案卷'), String(await api.evaluate(dialogTitle)))
  check('表单 id 与底部保存按钮指向同一处（`form="wb-matter-form"` + `type=submit`）',
    await api.evaluate(count('#wb-matter-form')) === 1
    && await api.evaluate(attr('.wb-dialog-foot .wb-btn', 'form')) === 'wb-matter-form'
    && await api.evaluate(attr('.wb-dialog-foot .wb-btn', 'type')) === 'submit')
  check('案型下拉 = 字典切片 9 条，默认选中第一条（撰写案）',
    JSON.stringify(await api.evaluate(optionTexts('#wb-matter-form label:nth-of-type(3) select option'))) === JSON.stringify(
      ['撰写案', '审查意见答复案', '检索案', '专利性分析案', '无效宣告案', '复审案', '侵权比对案', '年费维持案', '其他']),
    JSON.stringify(await api.evaluate(optionTexts('#wb-matter-form label:nth-of-type(3) select option'))))
  check('专利类型下拉 = 「（未定）」+ 3 条（空值是一个真实选项，不是缺省猜出来的）',
    JSON.stringify(await api.evaluate(optionTexts('#wb-matter-form label:nth-of-type(4) select option'))) === JSON.stringify(
      ['（未定）', '发明专利', '实用新型专利', '外观设计专利']))
  check('阶段下拉 6 条，默认选中 open（建案）',
    await api.evaluate(count('#wb-matter-form label:nth-of-type(5) select option')) === 6
    && await api.evaluate(inputValue('#wb-matter-form label:nth-of-type(5) select')) === 'open')
  check('新建态：案号与发明名称是空的，且这两个字段带 `required`',
    await api.evaluate(inputValue('#wb-matter-form label:nth-of-type(1) input')) === ''
    && await api.evaluate(requiredOf('#wb-matter-form label:nth-of-type(1) input')) === true
    && await api.evaluate(requiredOf('#wb-matter-form label:nth-of-type(2) input')) === true)
  check('其余字段都不带 required（只有案号与名称必填）',
    await api.evaluate(requiredOf('#wb-matter-form label:nth-of-type(6) input')) === false
    && await api.evaluate(requiredOf('#wb-matter-form label.full:last-of-type input')) === false)
  check('两个勾选框默认都不勾（claimsPriority / isPctNationalPhase 都是 "0"）',
    await api.evaluate(checkboxAt('#wb-matter-form input[type=checkbox]', 0)) === false
    && await api.evaluate(checkboxAt('#wb-matter-form input[type=checkbox]', 1)) === false
    && (await api.evaluate(state)).matterDraft.claimsPriority === '0')

  await setInputValue('#wb-matter-form label:nth-of-type(1) input', '2026-UM-777')
  check('输入案号 → 受控值写回容器的整份草稿（弹窗自己不存副本）',
    (await api.evaluate(state)).matterDraft.caseNumber === '2026-UM-777')
  await clickSelector('#wb-matter-form input[type=checkbox]')
  check('勾「要求优先权」→ 草稿里是 "1"（不是 true/1，输入框只认字符串）',
    (await api.evaluate(state)).matterDraft.claimsPriority === '1'
    && await api.evaluate(checkboxAt('#wb-matter-form input[type=checkbox]', 0)) === true)

  // 空必填时点保存：浏览器原生校验拦住，容器收不到提交
  await clickByText('.wb-dialog-foot', '保存')
  check('必填为空时点保存 → **不提交**（浏览器原生校验拦住，说明 required 真的落在 DOM 上）',
    JSON.stringify(await api.evaluate(lastCall('matterSubmit'))) === 'null')
  await setInputValue('#wb-matter-form label:nth-of-type(2) input', '一种折叠式光伏支架')
  await clickByText('.wb-dialog-foot', '保存')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'matterSubmit')`, { description: '保存提交到容器' })
  const submitArgs = (await api.evaluate(lastCall('matterSubmit')))[0]
  check('填齐后点保存 → 容器收到提交，且事件**可被 preventDefault 并已被拦住**（否则整页跳走）',
    submitArgs.cancelable === true && submitArgs.defaultPrevented === true, JSON.stringify(submitArgs))
  check('提交带出的是容器里的真实草稿（案号 + 两个起算日输入）',
    submitArgs.caseNumber === '2026-UM-777' && submitArgs.claimsPriority === '1' && submitArgs.pct === '0',
    JSON.stringify(submitArgs))

  await api.evaluate('__h4.setBusy(true); return true')
  check('busy：保存按钮禁用（不许连点两次建档）',
    await api.evaluate(`return document.querySelector('.wb-dialog-foot .wb-btn').disabled === true`))
  await api.evaluate('__h4.setBusy(false); return true')
  await clickByText('.wb-dialog-foot', '保存')
  await api.screenshot(SHOT_FORM)

  // ================================================================ B. 编辑案卷
  await openDialog('matter-edit')
  await api.waitFor(`return document.querySelector('#wb-matter-form') !== null`, { description: '编辑弹窗打开' })
  check('编辑态标题 = 「编辑案卷」（还是容器按 matterEditId 判的）',
    (await api.evaluate(dialogTitle) ?? '').includes('编辑案卷'), String(await api.evaluate(dialogTitle)))
  check('编辑态带出原值（案号 / 名称 / 客户 / IPC / 发明人 / 案卷目录）',
    (await api.evaluate(state)).matterDraft.caseNumber === '2025-UM-118'
    && (await api.evaluate(state)).matterDraft.title === '一种折叠式光伏支架'
    && (await api.evaluate(state)).matterDraft.clientId === 'client-a'
    && (await api.evaluate(state)).matterDraft.ipc === 'H02S20/30'
    && (await api.evaluate(state)).matterDraft.inventors === '张三,李四'
    && (await api.evaluate(state)).matterDraft.workspacePath === '/Users/xujian/projects/matters/2025-UM-118')
  check('编辑态：两个勾选框反映原值（claimsPriority=1 / isPctNationalPhase=true → 都勾上）',
    await api.evaluate(checkboxAt('#wb-matter-form input[type=checkbox]', 0)) === true
    && await api.evaluate(checkboxAt('#wb-matter-form input[type=checkbox]', 1)) === true)
  check('编辑态：专利类型选中的是 utility-model（下拉真的跟着草稿走）',
    await api.evaluate(inputValue('#wb-matter-form label:nth-of-type(4) select')) === 'utility-model')
  await clickSelector('.wb-dialog-close')
  await api.waitFor(`return document.querySelector('#wb-matter-form') === null`, { description: '关闭建档弹窗' })
  check('点 × → 容器收到关闭，并把草稿清空（不留半份脏状态给下一次打开）',
    JSON.stringify(await api.evaluate(lastCall('matterClose'))) === JSON.stringify([])
    && (await api.evaluate(state)).matterDraft === null
    && (await api.evaluate(state)).matterEditing === false)

  // ================================================================ C. 登记官文
  await openDialog('notice')
  await api.waitFor(`return document.querySelector('#wb-notice-form') !== null`, { description: '官文弹窗打开' })
  check('标题「登记官文」；表单 id 与「登记」按钮指向同一处',
    (await api.evaluate(dialogTitle) ?? '').includes('登记官文')
    && await api.evaluate(attr('.wb-dialog-foot .wb-btn', 'form')) === 'wb-notice-form'
    && await api.evaluate(attr('.wb-dialog-foot .wb-btn', 'type')) === 'submit')
  check('官文类型 7 条且 required；发文日 required 且预填容器给的那天',
    await api.evaluate(count('#wb-notice-form label:nth-of-type(1) select option')) === 7
    && await api.evaluate(requiredOf('#wb-notice-form label:nth-of-type(1) select')) === true
    && await api.evaluate(requiredOf('#wb-notice-form label:nth-of-type(2) input')) === true
    && await api.evaluate(inputValue('#wb-notice-form label:nth-of-type(2) input')) === '2026-10-03')
  check('送达方式下拉来自传入的字典切片，默认 electronic（夹具；出厂 seed 没这组，见 harness 头注）',
    JSON.stringify(await api.evaluate(optionTexts('#wb-notice-form label:nth-of-type(3) select option'))) === JSON.stringify(['电子送达', '纸件送达'])
    && await api.evaluate(inputValue('#wb-notice-form label:nth-of-type(3) select')) === 'electronic')
  check('指定期限是数字输入、范围 1–36，且说明了留空 = 不指定',
    await api.evaluate(attr('#wb-notice-form label:nth-of-type(5) input', 'min')) === '1'
    && await api.evaluate(attr('#wb-notice-form label:nth-of-type(5) input', 'max')) === '36'
    && (await api.evaluate(`const el = document.querySelector('#wb-notice-form label:nth-of-type(5) input'); return el.placeholder`) ?? '').includes('留空'))
  check('官文文件字段的占位说清了复用知识库的 file_link 机制',
    (await api.evaluate(`const el = document.querySelector('#wb-notice-form label.full input'); return el.placeholder`) ?? '').includes('file://'))
  await setInputValue('#wb-notice-form label:nth-of-type(5) input', '3')
  await clickByText('.wb-dialog-foot', '登记')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'noticeSubmit')`, { description: '官文登记提交到容器' })
  const noticeArgs = (await api.evaluate(lastCall('noticeSubmit')))[0]
  check('点「登记」→ 容器收到提交（事件可取消且已拦住），带出类型 / 发文日 / 指定期限',
    noticeArgs.cancelable === true && noticeArgs.defaultPrevented === true
    && noticeArgs.noticeKind === 'office-action-first' && noticeArgs.dispatchDate === '2026-10-03' && noticeArgs.designatedMonths === '3',
    JSON.stringify(noticeArgs))
  await clickByText('.wb-dialog-foot', '登记')
  await clickSelector('.wb-dialog-close')
  await api.waitFor(`return document.querySelector('#wb-notice-form') === null`, { description: '关闭官文弹窗' })
  check('点 × → 收到关闭且草稿清空',
    JSON.stringify(await api.evaluate(lastCall('noticeClose'))) === JSON.stringify([])
    && (await api.evaluate(state)).noticeDraft === null)

  // ================================================================ D. 到期提醒
  await openDialog('reminder')
  await api.waitFor(`return document.querySelector('.wb-scroll-area .wb-row') !== null`, { description: '提醒弹窗打开' })
  check('标题带条数：「到期提醒（2）」',
    (await api.evaluate(dialogTitle) ?? '').includes('到期提醒（2）'), String(await api.evaluate(dialogTitle)))
  check('两行文案 = 「标题 · fmtTime(到期时间)」，用**生产函数**现算的期望逐字比对',
    JSON.stringify(await api.evaluate(rowLabels)) === JSON.stringify(reminderLabels),
    JSON.stringify(await api.evaluate(rowLabels)))
  await api.screenshot(SHOT)
  const ackPoint = await pointOf(`[...document.querySelectorAll('.wb-scroll-area .wb-row')]
    .find((el) => el.textContent.includes('提交年费'))?.querySelector('.wb-btn')`)
  await api.clickAt(ackPoint.x, ackPoint.y)
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'reminderAck')`, { description: '知道了回执' })
  check('点第二行的「知道了」→ 只回执**那一条**，且它从列表里消失（剩 1 行）',
    JSON.stringify(await api.evaluate(lastCall('reminderAck'))) === JSON.stringify(['r2'])
    && await api.evaluate(count('.wb-scroll-area .wb-row')) === 1
    && await api.evaluate(bodyHas('提交年费')) === false)
  await clickByText('.wb-dialog-foot', '稍后处理')
  await api.waitFor(`return document.querySelector('.wb-scroll-area') === null`, { description: '稍后处理收起弹窗' })
  check('点「稍后处理」→ 收到关闭，弹窗消失（剩下的那条提醒不回执）',
    JSON.stringify(await api.evaluate(lastCall('reminderClose'))) === JSON.stringify([])
    && await api.evaluate(count('.wb-dialog')) === 0)
  await openDialog('reminder')
  await api.evaluate('__h4.clearReminders(); return true')
  check('提醒列表为空时不渲染（容器那条 `reminders.length > 0 &&` 是必要条件）',
    await api.evaluate(count('.wb-dialog')) === 0)

  // ================================================================ E. 同名任务选择
  await openDialog('duplicate')
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '同名任务弹窗打开' })
  check('标题点名了原因：「⚠️ 库里已经有一条同名任务」',
    (await api.evaluate(dialogTitle) ?? '').includes('库里已经有一条同名任务'), String(await api.evaluate(dialogTitle)))
  check('显示已有那条的标题（加粗）与前 8 位 id（完整 id 不外露）',
    await api.evaluate(`return document.querySelector('.wb-dialog b').textContent === '答复第一次审查意见'`)
    && await api.evaluate(bodyHas('已有那条 id：task-123'))
    && await api.evaluate(bodyHas('task-1234567890ab')) === false)
  /**
   * ⚠️ 断言里带 `**` 是**照实**写的：这两句话是 JS 字符串（不是 Markdown），
   * 所以页面上真的会看到星号。那是**既有**的显示瑕疵（H4-8 前的原样），
   * 本步是纯搬家不改样式，因此不在这里修 —— 只把事实钉住，免得以后被当成"新引入的 bug"。
   */
  check('描述逐字相同 + 工作区相同 → 说"很可能是同一件事被提交了两次"',
    await api.evaluate(bodyHas('描述逐字相同')) && await api.evaluate(bodyHas('描述不同')) === false
    && await api.evaluate(bodyHas('工作区相同。')))
  await api.evaluate(`__h4.setDuplicateFlags({ sameDescription: false, sameWorkspace: false }); return true`)
  check('两个判据翻过来 → 换成"描述不同 / 工作区不同"（两句话真的分叉，不是同一句写死）',
    await api.evaluate(bodyHas('描述**不同**')) === true && await api.evaluate(bodyHas('描述逐字相同')) === false
    && await api.evaluate(bodyHas('工作区不同。')) === true)
  check('「就用已有那条」说清了后果（把草稿收口到已有任务 + 归档本次新建的；可恢复、不丢数据）',
    await api.evaluate(bodyHas('归档本次新建的那条')) && await api.evaluate(bodyHas('不会丢数据')))
  await clickByText('.wb-dialog-foot', '保留两条')
  await api.waitFor(`return document.querySelector('.wb-dialog') === null`, { description: '保留两条后收起' })
  check('点「保留两条，我自己处理」→ 收起（不发请求，服务端也不静默合并）',
    JSON.stringify(await api.evaluate(lastCall('duplicateClose'))) === JSON.stringify([])
    && await api.evaluate(count('.wb-dialog')) === 0)
  await openDialog('duplicate')
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '再次打开同名任务弹窗' })
  await clickByText('.wb-dialog-foot', '就用已有那条')
  check('点「就用已有那条」→ 容器收到 reuseExisting(已有 id)，由容器去归档本次新建的那条',
    JSON.stringify(await api.evaluate(lastCall('duplicateReuseExisting'))) === JSON.stringify(['task-1234567890ab']),
    JSON.stringify(await api.evaluate(lastCall('duplicateReuseExisting'))))
  await api.evaluate('__h4.show(null); return true')

  check('四张弹窗都不发请求 → 全程没有页面异常', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-8 真浏览器验证：全绿' : `\nH4-8 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
