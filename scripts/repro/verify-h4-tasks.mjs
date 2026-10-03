#!/usr/bin/env node
/**
 * H4-6 的**真浏览器**验证：`TasksView`（筛选 + 排序 + 任务树 + 三处空态）挂进页面。
 *
 * 容器那一侧用**生产函数**复刻：排序（`createTaskSorter`）、过滤（`filterTaskTree` +
 * `matchesTaskFilter`）、类型 Tab 条数（`countTasksByType` + `buildTabs`）都在浏览器里
 * 跑产品实现；`onSelectType` 也逐字照抄容器里 `toggleTab` 那段写法。
 * 退化成记录器/固定夹具的只有"意图 → 请求"：`onToggleArchived`（真容器会打
 * `GET /tasks?archived=true`）与两个"改数据源"的钩子。
 *
 * 用法：node scripts/repro/verify-h4-tasks.mjs
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
const PAGE = join(OUT_DIR, 'tasks-harness.html')
const SHOT = join(OUT_DIR, 'h4-6-tasks.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-6 TasksView</title></head>',
  '<body style="margin:0">',
  '<script src="./tasks-harness.js"></script>',
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

/** 按文案点（`startsWith`：带图标的按钮文本里 svg 无文本）。限定在 `scope` 内找，避免拿错按钮。 */
async function clickByText(scope, text) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} .wb-btn`)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`在 ${scope} 里找不到文案以「${text}」开头的按钮`)
  await api.clickAt(point.x, point.y)
}

/** 点某一行（按标题文字定位；展开箭头是行内第一个 button，点它会 stopPropagation）。 */
async function clickRow(title) {
  const point = await api.evaluate(`
    const row = [...document.querySelectorAll('.wb-list .wb-row')]
      .find((el) => el.querySelector('.wb-row-title-text')?.textContent === ${JSON.stringify(title)});
    if (row === undefined) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到标题为「${title}」的任务行`)
  await api.clickAt(point.x, point.y)
}

/** 点某一行左侧的展开/收起箭头。 */
async function clickExpander(title) {
  const point = await api.evaluate(`
    const row = [...document.querySelectorAll('.wb-list .wb-row')]
      .find((el) => el.querySelector('.wb-row-title-text')?.textContent === ${JSON.stringify(title)});
    if (row === undefined) return null;
    const btn = row.querySelector('button');
    if (btn === null) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`「${title}」那一行没有展开箭头`)
  await api.clickAt(point.x, point.y)
}

/** 打开的下拉面板里按选项名点一个复选框（页面其余地方没有 `<label>`）。 */
async function clickPanelOption(name) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll('label')]
      .find((node) => node.querySelector('input[type="checkbox"]') !== null && node.textContent.trim() === ${JSON.stringify(name)});
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`下拉面板里找不到选项「${name}」`)
  await api.clickAt(point.x, point.y)
}

/** 点下拉面板的遮罩关闭（`position:fixed; inset:0`，z-index 20）。点它按定义就是"点别处"。 */
async function clickPanelOverlay() {
  const exists = await api.evaluate(`
    return [...document.querySelectorAll('div')].some((el) => el.style.position === 'fixed' && el.style.inset === '0px');
  `)
  if (!exists) throw new Error('没有打开的下拉面板（找不到遮罩）')
  await api.clickAt(1260, 780)
}

/** 文本框走受控输入的正规路子（绕过 React 的 value tracker 才能触发 onChange）。 */
async function setInputValue(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到输入框：${selector}`)
}

/** 原生 `<select>` 同理：绕过 value tracker 再派发 change。 */
async function setSelectValue(value) {
  const ok = await api.evaluate(`
    const el = document.querySelector('.wb-nav select');
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error('找不到排序下拉')
}

/** Ctrl/Cmd 多选：`clickAt` 不带修饰键，所以用真事件带 `ctrlKey` 派发（React 从事件里读）。 */
async function clickTabWithCtrl(code) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(`[data-tab="${code}"]`)});
    if (el === null) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到类型 Tab：${code}`)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const bodyHas = (text) => `return document.body.textContent.includes(${JSON.stringify(text)})`
const rowTitles = `return [...document.querySelectorAll('.wb-list .wb-row')].map((row) => row.querySelector('.wb-row-title-text')?.textContent ?? '')`
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
/** 排序行里那个「共 N 条」（`countTaskTree` 的口径：**含**被折叠的子节点与父链上下文）。 */
const hitCount = `return [...document.querySelectorAll('.wb-nav span')].filter((n) => n.textContent.startsWith('共 ') && n.textContent.endsWith(' 条')).map((n) => Number(n.textContent.slice(2, -2)))[0] ?? null`
const tabBadge = (code) => `return document.querySelector(${JSON.stringify(`[data-tab="${code}"] .wb-tab-cnt`)}).textContent`
const tabActive = (code) => `return document.querySelector(${JSON.stringify(`[data-tab="${code}"]`)}).classList.contains('on')`
const expanderGlyph = (title) => `return [...document.querySelectorAll('.wb-list .wb-row')].find((row) => row.querySelector('.wb-row-title-text')?.textContent === ${JSON.stringify(title)})?.querySelector('button')?.textContent ?? null`
const sameTitles = (expected) => (actual) => JSON.stringify(actual) === JSON.stringify(expected)

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载任务视图）' })

  // ---------------------------------------------------------------- 初态：Tab 条数 / 命中数 / 树
  check('类型 Tab 由字典拼出：全部 + 9 个类型，无「其他」',
    await api.evaluate(count('[data-tab]')) === 10,
    String(await api.evaluate(count('[data-tab]'))))
  check('Tab 徽标按「搜索 + 状态 + 优先级」算：全部 4、功能优化 1、代码实现 1、客户交流 1、团队管理 1、培训学习 0',
    await api.evaluate(tabBadge('all')) === '4'
    && await api.evaluate(tabBadge('feature_opt')) === '1'
    && await api.evaluate(tabBadge('code_impl')) === '1'
    && await api.evaluate(tabBadge('client_meeting')) === '1'
    && await api.evaluate(tabBadge('team_mgmt')) === '1'
    && await api.evaluate(tabBadge('training')) === '0')
  check('默认选中「全部」', await api.evaluate(tabActive('all')) && !(await api.evaluate(tabActive('feature_opt'))))
  check('命中数是整棵树（含折叠的子任务）：共 4 条',
    await api.evaluate(hitCount) === 4, String(await api.evaluate(hitCount)))
  check('折叠时只画根：行序按 dueAt 升序、无截止时间的排最后',
    sameTitles(['客户沟通会', '撰写检索报告', '团队周会'])(await api.evaluate(rowTitles)),
    JSON.stringify(await api.evaluate(rowTitles)))
  check('展开箭头：有子任务的给 ▶、没有的给 ·',
    await api.evaluate(expanderGlyph('撰写检索报告')) === '▶'
    && await api.evaluate(expanderGlyph('客户沟通会')) === '·')
  check('未选中任何任务 → 没有 .selected 行', await api.evaluate(count('.wb-list .wb-row.selected')) === 0)
  check('下拉没打开：页面上没有复选框面板', await api.evaluate(count('.wb-nav input[type="checkbox"]')) === 0)
  check('筛选为空 → 「清空」按钮禁用',
    await api.evaluate(`return [...document.querySelectorAll('.wb-nav .wb-btn')].find((b) => b.textContent.trim().startsWith('清空')).disabled === true`))

  // ---------------------------------------------------------------- 展开 / 点行
  await clickExpander('撰写检索报告')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '子任务展开' })
  check('点 ▶ 展开子任务：子行插在父行之后，命中数不变（共 4 条）',
    sameTitles(['客户沟通会', '撰写检索报告', '补充权利要求', '团队周会'])(await api.evaluate(rowTitles))
    && await api.evaluate(hitCount) === 4,
    JSON.stringify(await api.evaluate(rowTitles)))
  check('展开箭头翻成 ▼，且点箭头**不**触发打开任务',
    await api.evaluate(expanderGlyph('撰写检索报告')) === '▼'
    && JSON.stringify(await api.evaluate(lastCall('open'))) === 'null')

  await clickRow('客户沟通会')
  check('点一行 → 容器收到 open(整条任务 t3) 且自己的选中 id 换掉',
    JSON.stringify(await api.evaluate(lastCall('open'))) === JSON.stringify(['t3'])
    && JSON.stringify(await api.evaluate('return __h4.state().selectedId')) === JSON.stringify('t3'),
    JSON.stringify(await api.evaluate(lastCall('open'))))
  check('选中行拿到 .selected（高亮跟着走）',
    await api.evaluate(`return document.querySelectorAll('.wb-list .wb-row.selected').length === 1`))

  // ---------------------------------------------------------------- 搜索
  await setInputValue('.wb-nav input[placeholder="搜索标题 / 描述"]', '客户')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 1`, { description: '搜索命中 1 条' })
  check('搜索「客户」→ 只剩客户沟通会，命中数跟着变 1',
    sameTitles(['客户沟通会'])(await api.evaluate(rowTitles)) && await api.evaluate(hitCount) === 1)
  check('有关键词后「清空」按钮变为可点',
    await api.evaluate(`return [...document.querySelectorAll('.wb-nav .wb-btn')].find((b) => b.textContent.trim().startsWith('清空')).disabled === false`))
  await clickByText('.wb-nav', '清空')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '清空后回到 4 行' })
  check('点「清空」→ 筛选归零、4 行全回、按钮重新禁用',
    JSON.stringify(await api.evaluate('return __h4.state().filter')) === JSON.stringify({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })
    && await api.evaluate(`return [...document.querySelectorAll('.wb-nav .wb-btn')].find((b) => b.textContent.trim().startsWith('清空')).disabled === true`))

  // ---------------------------------------------------------------- 状态下拉（多选 + 父链上下文）
  await clickByText('.wb-nav', '状态')
  await api.waitFor(`return document.querySelectorAll('.wb-nav input[type="checkbox"]').length === 6`, { description: '状态下拉展开' })
  check('点「状态」→ 面板展开（6 个状态选项）、openFilter 记为 status',
    JSON.stringify(await api.evaluate('return __h4.state().openFilter')) === JSON.stringify('status')
    && await api.evaluate(count('.wb-nav input[type="checkbox"]')) === 6)
  await clickPanelOption('待办')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 3`, { description: '筛出待办' })
  check('勾「待办」→ 命中 3：两条待办 + **父链上下文**的撰写检索报告（它自己不是待办，命中数含它）',
    sameTitles(['撰写检索报告', '补充权利要求', '团队周会'])(await api.evaluate(rowTitles))
    && await api.evaluate(hitCount) === 3,
    JSON.stringify(await api.evaluate(rowTitles)))
  check('触发器写出已选数（状态 已选 1 项）',
    await api.evaluate(bodyHas('已选 1 项')))
  await clickPanelOption('已完成')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '待办 + 已完成' })
  check('再勾「已完成」→ 客户沟通会回来（4 行）、触发器写已选 2 项',
    sameTitles(['客户沟通会', '撰写检索报告', '补充权利要求', '团队周会'])(await api.evaluate(rowTitles))
    && await api.evaluate(hitCount) === 4
    && await api.evaluate(bodyHas('已选 2 项')),
    JSON.stringify(await api.evaluate(rowTitles)))
  await clickPanelOverlay()
  await api.waitFor(`return document.querySelectorAll('.wb-nav input[type="checkbox"]').length === 0`, { description: '面板关闭' })
  check('点面板外（遮罩）→ 面板关闭，但已选筛选**不丢**（仍是 4 条）',
    await api.evaluate(hitCount) === 4
    && JSON.stringify(await api.evaluate('return __h4.state().filter.statusCodes')) === JSON.stringify(['todo', 'done']))
  await clickByText('.wb-nav', '状态')
  await api.waitFor(`return document.querySelectorAll('.wb-nav input[type="checkbox"]').length === 6`, { description: '状态面板再展开' })
  await clickPanelOption('待办')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 1`, { description: '只剩已完成' })
  check('取消勾选「待办」→ 只剩已完成那条（子任务不再有命中的兄弟，父链上下文随之消失）',
    sameTitles(['客户沟通会'])(await api.evaluate(rowTitles)) && await api.evaluate(hitCount) === 1)
  await clickPanelOption('已完成')
  await clickPanelOverlay()
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '状态筛选清空' })
  check('两个都取消 → 回到完整 4 行，面板关闭',
    await api.evaluate(count('.wb-nav input[type="checkbox"]')) === 0 && await api.evaluate(hitCount) === 4)

  // ---------------------------------------------------------------- 优先级下拉
  await clickByText('.wb-nav', '优先级')
  await api.waitFor(`return document.querySelectorAll('.wb-nav input[type="checkbox"]').length === 4`, { description: '优先级面板展开' })
  check('同一时刻只开一个下拉：点「优先级」时状态面板已关（复选框只有优先级那 4 个）',
    await api.evaluate(count('.wb-nav input[type="checkbox"]')) === 4)
  await clickPanelOption('高')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 1`, { description: '只剩高优先级' })
  check('勾「高」→ 只剩撰写检索报告（子任务 p0 不命中且没有命中的子节点，不保留）',
    sameTitles(['撰写检索报告'])(await api.evaluate(rowTitles)) && await api.evaluate(hitCount) === 1)
  await clickPanelOption('高')
  await clickPanelOverlay()
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '优先级筛选清空' })

  // ---------------------------------------------------------------- 类型 Tab（单选 / Ctrl 多选 / 条数不含类型维度）
  await clickSelector('[data-tab="code_impl"]')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 2`, { description: '类型 Tab 单选' })
  check('点「代码实现」Tab → 单选生效（Tab 高亮、树只剩该类型 + 父链上下文）',
    await api.evaluate(tabActive('code_impl')) && !(await api.evaluate(tabActive('all')))
    && sameTitles(['撰写检索报告', '补充权利要求'])(await api.evaluate(rowTitles))
    && await api.evaluate(hitCount) === 2,
    JSON.stringify(await api.evaluate(rowTitles)))
  check('Tab 条数**不含类型维度自身**：选了类型后「全部」仍是 4、「代码实现」仍是 1',
    await api.evaluate(tabBadge('all')) === '4' && await api.evaluate(tabBadge('code_impl')) === '1')
  await clickTabWithCtrl('feature_opt')
  await api.waitFor(`return __h4.state().filter.typeCodes.length === 2`, { description: 'Ctrl 多选生效' })
  check('Ctrl+点「功能优化」→ 多选两个类型（两个 Tab 都高亮）',
    await api.evaluate(tabActive('code_impl')) && await api.evaluate(tabActive('feature_opt'))
    && JSON.stringify(await api.evaluate('return __h4.state().filter.typeCodes')) === JSON.stringify(['code_impl', 'feature_opt']))
  await clickSelector('[data-tab="all"]')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '回全部' })
  check('点「全部」→ 类型筛选归零、4 行全回、只有「全部」高亮',
    await api.evaluate(tabActive('all')) && !(await api.evaluate(tabActive('code_impl')))
    && await api.evaluate(hitCount) === 4)

  // ---------------------------------------------------------------- 排序
  await setSelectValue('priority')
  await api.waitFor(`return __h4.state().sortKey === 'priority'`, { description: '切优先级排序' })
  check('排序切「优先级」（升序）→ 根按 weight 排：p1 → p2 → p3，子任务仍紧跟父行',
    sameTitles(['撰写检索报告', '补充权利要求', '客户沟通会', '团队周会'])(await api.evaluate(rowTitles)),
    JSON.stringify(await api.evaluate(rowTitles)))
  await clickByText('.wb-nav', '↑ 升序')
  await api.waitFor(`return __h4.state().sortDir === 'desc'`, { description: '切降序' })
  check('点方向按钮 → 降序：根序反转，按钮文案变「↓ 降序」',
    sameTitles(['团队周会', '客户沟通会', '撰写检索报告', '补充权利要求'])(await api.evaluate(rowTitles))
    && await api.evaluate(bodyHas('↓ 降序')),
    JSON.stringify(await api.evaluate(rowTitles)))
  await setSelectValue('title')
  await api.waitFor(`return __h4.state().sortKey === 'title'`, { description: '切标题排序' })
  check('排序切「标题」（当前降序）→ 拼音序反转：撰(zhuàn) → 团(tuán) → 客(kè)',
    sameTitles(['撰写检索报告', '补充权利要求', '团队周会', '客户沟通会'])(await api.evaluate(rowTitles)),
    JSON.stringify(await api.evaluate(rowTitles)))
  await clickByText('.wb-nav', '↓ 降序')
  await api.waitFor(`return __h4.state().sortDir === 'asc'`, { description: '切回升序' })
  check('再点方向 → 升序：客(kè) → 团(tuán) → 撰(zhuàn)',
    sameTitles(['客户沟通会', '团队周会', '撰写检索报告', '补充权利要求'])(await api.evaluate(rowTitles)),
    JSON.stringify(await api.evaluate(rowTitles)))
  await setSelectValue('dueAt')
  await api.waitFor(`return __h4.state().sortKey === 'dueAt'`, { description: '切回截止时间排序' })
  check('排序切回「截止时间」（升序）→ 09-28 → 10-03(子) → 10-05 → 无截止最后',
    sameTitles(['客户沟通会', '撰写检索报告', '补充权利要求', '团队周会'])(await api.evaluate(rowTitles)),
    JSON.stringify(await api.evaluate(rowTitles)))

  // ---------------------------------------------------------------- 待验收投影透传
  check('没给投影（服务端不支持）→ 行上没有**待验收**徽标（但已完成那条的终态徽标照旧）',
    await api.evaluate(count('.wb-progress-badge.pending')) === 0
    && await api.evaluate(count('.wb-progress-badge.terminal')) === 1,
    String(await api.evaluate(count('.wb-progress-badge'))))
  await api.evaluate('__h4.setPending(true); return true;')
  await api.waitFor(`return document.querySelectorAll('.wb-progress-badge.pending').length === 1`, { description: '待验收徽标出现' })
  check('投影给了 t1 → 只有那一行出现「待验收」徽标',
    await api.evaluate(count('.wb-progress-badge.pending')) === 1
    && await api.evaluate(bodyHas('待验收')))
  await api.evaluate('__h4.setPending(false); return true;')
  await api.waitFor(`return document.querySelectorAll('.wb-progress-badge.pending').length === 0`, { description: '待验收徽标消失' })

  // ---------------------------------------------------------------- 归档模式
  await clickByText('.wb-nav', '查看归档')
  await api.waitFor(`return __h4.state().archivedMode === true`, { description: '切归档模式' })
  check('点「查看归档」→ 容器收到 toggleArchived(true)（拉取在容器里），按钮变「返回任务」',
    JSON.stringify(await api.evaluate(lastCall('toggleArchived'))) === JSON.stringify([true])
    && await api.evaluate(bodyHas('返回任务')))
  check('归档模式换数据源：只剩归档那条，Tab 条数按归档源重算（全部 1 / 个人生活 1）',
    sameTitles(['去年的旧任务'])(await api.evaluate(rowTitles))
    && await api.evaluate(hitCount) === 1
    && await api.evaluate(tabBadge('all')) === '1'
    && await api.evaluate(tabBadge('personal')) === '1',
    JSON.stringify(await api.evaluate(rowTitles)))
  await clickByText('.wb-nav', '返回任务')
  await api.waitFor(`return __h4.state().archivedMode === false`, { description: '切回任务' })
  check('点「返回任务」→ 回到任务数据源、按钮文案复位',
    sameTitles(['客户沟通会', '撰写检索报告', '补充权利要求', '团队周会'])(await api.evaluate(rowTitles))
    && await api.evaluate(bodyHas('查看归档')))
  await api.evaluate('__h4.setArchived([]); return true;')
  await clickByText('.wb-nav', '查看归档')
  await api.waitFor(`return __h4.state().archivedMode === true`, { description: '空归档模式' })
  check('归档一条都没有 → 「没有归档任务」（不是主列表那句空态）',
    await api.evaluate(bodyHas('没有归档任务'))
    && !(await api.evaluate(bodyHas('还没有任务，点“快速录入”或“新建”开始')))
    && await api.evaluate(hitCount) === 0)
  await clickByText('.wb-nav', '返回任务')
  await api.waitFor(`return __h4.state().archivedMode === false`, { description: '回到任务' })

  // ---------------------------------------------------------------- 空态
  await api.evaluate('__h4.setTasks([]); return true;')
  await api.waitFor(`return document.body.textContent.includes('还没有任务')`, { description: '空列表态' })
  check('任务一条都没有 → 「还没有任务，点“快速录入”或“新建”开始」+ 命中 0 + 清空禁用',
    await api.evaluate(bodyHas('还没有任务，点“快速录入”或“新建”开始'))
    && await api.evaluate(count('.wb-list .wb-row')) === 0
    && await api.evaluate(hitCount) === 0
    && await api.evaluate(`return [...document.querySelectorAll('.wb-nav .wb-btn')].find((b) => b.textContent.trim().startsWith('清空')).disabled === true`))
  check('空列表下类型 Tab 与工具条仍在（不是整块消失）',
    await api.evaluate(count('[data-tab]')) === 10
    && await api.evaluate(`return document.querySelector('.wb-nav input[placeholder="搜索标题 / 描述"]') !== null`))
  await api.evaluate(`__h4.setTasks(${JSON.stringify([
    ['t1', '撰写检索报告', 'feature_opt', 'doing', 'p1', '2026-10-05T09:00:00.000Z', null],
    ['t2', '补充权利要求', 'code_impl', 'todo', 'p0', '2026-10-03T10:00:00.000Z', 't1'],
    ['t3', '客户沟通会', 'client_meeting', 'done', 'p2', '2026-09-28T14:00:00.000Z', null],
    ['t4', '团队周会', 'team_mgmt', 'todo', 'p3', null, null],
  ].map(([id, title, typeCode, statusCode, priorityCode, dueAt, parentId]) => ({
    id, title, typeCode, statusCode, priorityCode, dueAt, parentId,
    description: '', aiPolicyCode: 'consult', effectiveDueAt: dueAt, allDay: false, estimatedMinutes: null,
    source: 'manual', workspacePath: null, effectiveWorkspacePath: null, archived: false, extra: {},
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: statusCode === 'done' ? '2026-09-28T15:00:00.000Z' : null, cancelledAt: null,
  })))}); return true;`)
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '任务恢复' })
  check('数据回来后 4 行全回（展开集不因换数据而丢）', await api.evaluate(hitCount) === 4)
  await setInputValue('.wb-nav input[placeholder="搜索标题 / 描述"]', '不存在')
  await api.waitFor(`return document.body.textContent.includes('没有符合条件的任务')`, { description: '无命中态' })
  check('筛选无命中 → 「没有符合条件的任务，点“清空”恢复完整列表」（与"一条任务都没有"是两句不同的话）',
    await api.evaluate(bodyHas('没有符合条件的任务，点“清空”恢复完整列表'))
    && !(await api.evaluate(bodyHas('还没有任务，点“快速录入”或“新建”开始')))
    && await api.evaluate(hitCount) === 0)
  await clickByText('.wb-nav', '清空')
  await api.waitFor(`return document.querySelectorAll('.wb-list .wb-row').length === 4`, { description: '清空恢复' })
  check('从"无命中"点「清空」→ 完整列表回来', await api.evaluate(hitCount) === 4)

  // ---------------------------------------------------------------- 页面无异常
  check('无页面异常 / 无 console error', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))

  await clickRow('撰写检索报告')
  await api.screenshot(SHOT)
  console.log(`\n截图：${SHOT.replace(`${ROOT}/`, '')}`)
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-6 真浏览器验证：全绿' : `\nH4-6 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
