#!/usr/bin/env node
/**
 * H4-7 的**真浏览器**验证：`QuickEntryModal`（一句话 + 附件轨 + 工作区 / 技能 / 角色 / 模型 + 两个底部动作）
 * 挂进页面。
 *
 * 容器那一侧凡是纯函数都用**生产实现**现算：工作区预填与来源（`decideQuickWorkspaceDefault` +
 * `quickWorkspaceSourceLabel`）、候选集（`workspaceCandidates`）、"不收的文件为什么被拒"
 * （`partitionQuickFiles`）—— 所以断言里读到的中文文案是产品文案。
 * 退化成记录器的只有"意图 → 请求"那几处（网络在脚手架里不存在，见 harness 头部）。
 *
 * 用法：node scripts/repro/verify-h4-quick-entry.mjs
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
const PAGE = join(OUT_DIR, 'quick-entry-harness.html')
const SHOT = join(OUT_DIR, 'h4-7-quick-entry.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-7 QuickEntryModal</title></head>',
  '<body style="margin:0">',
  '<script src="./quick-entry-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '1400,900' })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 点一个元素（先 scrollIntoView 再按中心点真点，不是 DOM `.click()`）。 */
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

/** 按文案点按钮（`startsWith`：带图标的按钮文本里 svg 无文本）。限定在 `scope` 内找。 */
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

/** 按文案点一个**非按钮**元素（技能项 / 角色项是 `<label>` / `<button>` 但不是 `.wb-btn`）。 */
async function clickItem(selector, label) {
  const point = await api.evaluate(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (el === undefined) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `)
  if (point === null) throw new Error(`找不到文案以「${label}」开头的元素：${selector}`)
  await api.clickAt(point.x, point.y)
}

/** 受控 textarea / input 走正规输入路子（绕过 React 的 value tracker 才能触发 onChange）。 */
async function setInputValue(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到输入框：${selector}`)
}

/** 原生 `<select>`：同样绕过 value tracker 再派发 change。 */
async function setSelectValue(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到下拉：${selector}`)
}

/** 在浏览器里造真 `File` 再走隐藏 file input（`input.files` 是可写属性）。 */
async function pickFiles(label, files) {
  const ok = await api.evaluate(`
    const dt = new DataTransfer();
    ${files.map((file) => `dt.items.add(new File(['x'], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));`).join('\n    ')}
    const input = document.querySelector('.wb-quick-actions input[type=file]');
    if (input === null) return false;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到附件 file input（${label}）`)
}

/** 拖入：真 `DragEvent` + 真 `DataTransfer`（React 从 `e.dataTransfer.files` 读）。 */
async function dropFiles(label, files) {
  const ok = await api.evaluate(`
    const dt = new DataTransfer();
    ${files.map((file) => `dt.items.add(new File(['x'], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));`).join('\n    ')}
    const target = [...document.querySelectorAll('.wb-dialog-body .wb-field')]
      .find((el) => el.querySelector('.wb-quick-actions') !== null);
    if (target === undefined) return false;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到附件拖放区（${label}）`)
}

/** 粘贴：真 `ClipboardEvent` + 真 `DataTransfer`。 */
async function pasteFiles(label, files) {
  const ok = await api.evaluate(`
    const dt = new DataTransfer();
    ${files.map((file) => `dt.items.add(new File(['x'], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));`).join('\n    ')}
    const ta = document.querySelector('.wb-dialog-body textarea');
    if (ta === null) return false;
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return true;
  `)
  if (ok !== true) throw new Error(`找不到 textarea（${label}）`)
}

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const text = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent.trim()`
const value = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.value`
const state = 'return __h4.state()'
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
/** 某个按钮是否禁用：按文案在 `scope` 里找 `.wb-btn`。 */
const btnDisabled = (scope, label) => `
  const el = [...document.querySelectorAll(${JSON.stringify(`${scope} .wb-btn`)})]
    .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
  return el === undefined ? null : el.disabled;
`
const optionTexts = `return [...document.querySelectorAll('[data-workspace-select] option')].map((o) => o.textContent.trim())`
const skillNames = `return [...document.querySelectorAll('.wb-skill-list .wb-skill-name')].map((el) => el.textContent.trim())`
const chipNames = `return [...document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-name')].map((el) => el.textContent.trim())`
const typeIn = async (selector, textValue) => setInputValue(selector, textValue)
const png = (name) => ({ name, type: 'image/png' })
const pdf = (name) => ({ name, type: 'application/pdf' })

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载快速录入弹窗）' })
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '弹窗已弹出（Modal portal 到 body）' })

  const limits = await api.evaluate('return __h4.limits')

  // ---------------------------------------------------------------- 初态
  check('弹窗标题是「快速录入」', (await api.evaluate(text('.wb-dialog-head h3')) ?? '').includes('快速录入'))
  check('一句话输入框在，且带示例占位',
    (await api.evaluate(`
      const el = document.querySelector('.wb-dialog-body textarea');
      return el === null ? null : el.placeholder;
    `) ?? '').includes('一句话描述任务'))
  check('附件上限文案由共享常量现算（图片 / 文档两个上限都写出来）',
    await api.evaluate(`return document.body.textContent.includes(${JSON.stringify(`图片最多 ${limits.images} 张 · PDF/DOCX 最多 ${limits.documents} 份 · 单份 ≤ 5MB`)})`),
    `图片 ${limits.images} / 文档 ${limits.documents}`)
  check('工作区预填 = 设置里的「上次手动选择」（不是某个任务的工作区）',
    await api.evaluate(value('[data-workspace-input]')) === '/Users/xujian/projects/demo',
    String(await api.evaluate(value('[data-workspace-input]'))))
  check('来源文案由判定给出：上次手动选择',
    await api.evaluate(text('[data-workspace-picker] .wb-field-note')) === '上次手动选择',
    String(await api.evaluate(text('[data-workspace-picker] .wb-field-note'))))
  check('来源是「上次手动选择」且用户没动过 → 「不再记住」可见',
    await api.evaluate(count('[data-workspace-forget]')) === 1)
  check('候选下拉 = 占位 + 已打开 + 最近 + 默认（三个来源各一条，顺序如此）',
    JSON.stringify(await api.evaluate(optionTexts)) === JSON.stringify([
      '选择已有工作区…',
      '已打开 · /Users/xujian/projects/dsh-patent-workbench',
      '最近 · /Users/xujian/projects/demo',
      '默认 · /Users/xujian/projects/work',
    ]),
    JSON.stringify(await api.evaluate(optionTexts)))
  check('下拉当前选中的是「最近」那条（与输入框的值同键）',
    await api.evaluate(value('[data-workspace-select]')) === '/Users/xujian/projects/demo')
  check('资料夹勾选默认勾上，且说明写清了命名口径',
    await api.evaluate(`return document.querySelector('label.wb-inline-check input[type=checkbox]').checked === true`)
    && (await api.evaluate(text('label.wb-inline-check')) ?? '').includes('<任务ID>-<标题片段>'))
  check('技能目录 3 条、已选 0 条（没有已选标签）',
    JSON.stringify(await api.evaluate(skillNames)) === JSON.stringify(['patent-claim-draft', 'oa-reply', 'search-report'])
    && await api.evaluate(count('.wb-skill-tag')) === 0)
  check('技能说明写明"会在提示词开头注入加载指令"',
    (await api.evaluate(text('.wb-skill-foot')) ?? '').includes('注入'))
  check('角色默认「未指定」并高亮（不静默继承上一次）',
    await api.evaluate(count('.wb-persona-item.on')) === 1
    && (await api.evaluate(text('.wb-persona-item.on')) ?? '').includes('未指定'))
  await api.waitFor(`return document.querySelectorAll('.wb-persona-picker .wb-skill-problem').length === 1`, { description: '角色库失败原因上线' })
  check('角色库读不到 → 就地给出可读原因 + 「重试」（不静默变成一个空块）',
    (await api.evaluate(text('.wb-persona-picker .wb-skill-problem')) ?? '').includes('角色库暂不可用')
    && await api.evaluate(count('.wb-persona-picker .wb-skill-problem .wb-btn')) === 1,
    String(await api.evaluate(text('.wb-persona-picker .wb-skill-problem'))).slice(0, 80))
  check('模型选择器按钮在（模型是"这次会话怎么跑"，不是任务字段）',
    await api.evaluate(count('.wb-model-picker')) === 1)
  check('文本空 + 无附件 → 「创建澄清会话」禁用',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === true)
  check('「取消」在（与右上角 × 是两条不同的收尾路径）',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '取消')) === false)

  // ---------------------------------------------------------------- 输入
  await typeIn('.wb-dialog-body textarea', '周五 10:30 接待重要客户')
  check('输入文字 → 提交启用，且容器的 text 跟着变',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === false
    && (await api.evaluate(state)).text === '周五 10:30 接待重要客户')
  await typeIn('.wb-dialog-body textarea', '')
  check('清空文字 → 提交又禁用（判据是"文字或附件至少一个"）',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === true)

  // ---------------------------------------------------------------- 附件：三条入口
  await pickFiles('file input', [png('a.png')])
  await api.waitFor(`return document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-item').length === 1`, { description: '图片附件入轨' })
  check('file input 选 1 张 png → 1 个附件块，带缩略图与文件名，且没有"拒收"说明',
    JSON.stringify(await api.evaluate(chipNames)) === JSON.stringify(['a.png'])
    && await api.evaluate(count('.wb-quick-attach-rail img')) === 1
    && await api.evaluate(count('.wb-quick-attach-note')) === 0)
  check('只有附件、没有文字 → 提交仍可点（附件本身就是内容）',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === false)

  await dropFiles('drop', [png('drop.png'), { name: 'notes.txt', type: 'text/plain' }])
  await api.waitFor(`return document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-item').length === 2`, { description: '拖入的图片入轨' })
  check('拖入「1 图 + 1 txt」：图进来了，txt 被拒并逐条给中文原因（不静默丢弃）',
    JSON.stringify(await api.evaluate(chipNames)) === JSON.stringify(['a.png', 'drop.png'])
    && (await api.evaluate(text('.wb-quick-attach-note')) ?? '').includes('notes.txt')
    && (await api.evaluate(text('.wb-quick-attach-note')) ?? '').includes('只支持'))

  await dropFiles('drop pdf', [pdf('报告.pdf')])
  check('拖入 PDF：不收进附件轨（正文由服务端抽）→ 记一条"待抽正文"意图，说明也清空',
    JSON.stringify(await api.evaluate(lastCall('extractDocuments'))) === JSON.stringify([['报告.pdf']])
    && await api.evaluate(count('.wb-quick-attach-rail .wb-quick-attach-item')) === 2
    && await api.evaluate(count('.wb-quick-attach-note')) === 0)

  await pasteFiles('paste', [png('paste.png')])
  await api.waitFor(`return document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-item').length === 3`, { description: '粘贴的图片入轨' })
  check('粘贴图片也走同一个入口 → 3 个附件块',
    JSON.stringify(await api.evaluate(chipNames)) === JSON.stringify(['a.png', 'drop.png', 'paste.png']))

  // ---------------------------------------------------------------- 附件：上限 / 截断 / 移除
  await pickFiles('12 张', Array.from({ length: 12 }, (_, i) => png(`bulk-${i}.png`)))
  await api.waitFor(`return document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-item').length === ${limits.images}`, { description: '按上限收满' })
  check(`已有 3 张时再给 12 张：只收 ${limits.images - 3} 张（到上限就停），并说清为什么`,
    await api.evaluate(count('.wb-quick-attach-rail .wb-quick-attach-item')) === limits.images
    && (await api.evaluate(text('.wb-quick-attach-note')) ?? '').includes(`图片最多 ${limits.images} 张`))

  await clickSelector('.wb-quick-attach-rail .wb-quick-attach-remove')
  await api.waitFor(`return document.querySelectorAll('.wb-quick-attach-rail .wb-quick-attach-item').length === ${limits.images - 1}`, { description: '移除一份附件' })
  check('点 × 移除一份 → 少一个附件块，并把上一次的"拒收"说明清掉',
    await api.evaluate(count('.wb-quick-attach-rail .wb-quick-attach-item')) === limits.images - 1
    && await api.evaluate(count('.wb-quick-attach-note')) === 0)

  await pickFiles('补一张', [png('again.png')])
  check('补一张回到上限', await api.evaluate(count('.wb-quick-attach-rail .wb-quick-attach-item')) === limits.images)
  await pickFiles('再超一张', [png('overflow.png')])
  check('已到上限再给一张 → 数量不变，只多一条原因（不静默吞掉）',
    await api.evaluate(count('.wb-quick-attach-rail .wb-quick-attach-item')) === limits.images
    && (await api.evaluate(text('.wb-quick-attach-note')) ?? '').includes('overflow.png'))

  // ---------------------------------------------------------------- 工作区
  await clickSelector('[data-workspace-forget]')
  check('点「不再记住」→ 容器收到 forgetWorkspace(当前预填目录)',
    JSON.stringify(await api.evaluate(lastCall('forgetWorkspace'))) === JSON.stringify(['/Users/xujian/projects/demo']),
    JSON.stringify(await api.evaluate(lastCall('forgetWorkspace'))))

  await setSelectValue('[data-workspace-select]', '/Users/xujian/projects/dsh-patent-workbench')
  check('从下拉选「已打开」的工作区 → 值写回输入框，且算"用户动过"',
    await api.evaluate(value('[data-workspace-input]')) === '/Users/xujian/projects/dsh-patent-workbench'
    && (await api.evaluate(state)).workspaceTouched === true)
  check('用户动过之后：来源文案变「手动指定」，「不再记住」消失',
    await api.evaluate(text('[data-workspace-picker] .wb-field-note')) === '手动指定'
    && await api.evaluate(count('[data-workspace-forget]')) === 0)

  await clickSelector('[data-workspace-browse]')
  check('点「浏览…」→ 容器收到 browse 意图（目录弹窗由容器打开，弹窗不自己发请求）',
    JSON.stringify(await api.evaluate(lastCall('browse'))) === JSON.stringify([]))

  await typeIn('[data-workspace-input]', '/tmp/hand-typed/dir')
  check('手打路径也走同一个 onChange（不区分"选"与"打"）',
    await api.evaluate(value('[data-workspace-input]')) === '/tmp/hand-typed/dir'
    && (await api.evaluate(state)).workspace === '/tmp/hand-typed/dir')

  await clickSelector('label.wb-inline-check input[type=checkbox]')
  check('取消「建任务资料夹」→ 容器的 followFolder 变 false',
    (await api.evaluate(state)).followFolder === false)
  await clickSelector('label.wb-inline-check input[type=checkbox]')
  check('再点回来 → 又勾上',
    (await api.evaluate(state)).followFolder === true)

  // ---------------------------------------------------------------- 技能
  await clickItem('.wb-skill-list .wb-skill-item', 'patent-claim-draft')
  await api.waitFor(`return document.querySelectorAll('.wb-skill-tag').length === 1`, { description: '技能被选中' })
  check('点一条技能 → 出现已选标签，容器的 selectedSkills 记下它',
    JSON.stringify((await api.evaluate(state)).selectedSkills) === JSON.stringify(['patent-claim-draft'])
    && (await api.evaluate(text('.wb-skill-tag')) ?? '').includes('patent-claim-draft'))
  await typeIn('.wb-skill-search', 'oa')
  check('技能搜索按名称过滤（3 条 → 1 条）',
    JSON.stringify(await api.evaluate(skillNames)) === JSON.stringify(['oa-reply']),
    JSON.stringify(await api.evaluate(skillNames)))
  check('筛选时已选标签仍显示（选了的不因搜索消失）',
    await api.evaluate(count('.wb-skill-tag')) === 1)
  await clickItem('.wb-skill-tag', 'patent-claim-draft')
  check('点已选标签 → 取消选中',
    JSON.stringify((await api.evaluate(state)).selectedSkills) === JSON.stringify([]))
  await typeIn('.wb-skill-search', '')
  check('清空搜索 → 3 条又回来', await api.evaluate(count('.wb-skill-list .wb-skill-item')) === 3)

  // ---------------------------------------------------------------- 角色
  await clickItem('.wb-persona-list .wb-persona-item', '无角色')
  check('点「无角色」→ 容器收到 none，当前值文案跟着改',
    (await api.evaluate(state)).persona.mode === 'none'
    && (await api.evaluate(text('.wb-persona-current')) ?? '').includes('无角色'),
    String(await api.evaluate(text('.wb-persona-current'))))
  await clickItem('.wb-persona-list .wb-persona-item', '未指定')
  check('点回「未指定」→ 复位成不留痕的默认值',
    (await api.evaluate(state)).persona.mode === 'inherit')

  // ---------------------------------------------------------------- 模型（降级路径）
  await clickSelector('.wb-model-picker')
  check('拿不到模型目录 → 菜单不打开（不摆一份假列表），而是把可读原因交给容器',
    await api.evaluate(count('.wb-model-menu')) === 0
    && ((await api.evaluate(state)).error ?? '').includes('无法读取模型列表')
    && ((await api.evaluate(state)).error ?? '').includes('跟随 DSH 默认模型'),
    String((await api.evaluate(state)).error))

  // ---------------------------------------------------------------- 提交
  await typeIn('.wb-dialog-body textarea', '周五 10:30 接待重要客户')
  const idsBeforeSubmit = (await api.evaluate(state)).attachmentIds
  await api.screenshot(SHOT)
  await clickByText('.wb-dialog-foot', '创建澄清会话')
  check('点「创建澄清会话」→ 容器收到完整意图（文字 / 工作区 / 资料夹开关 / 角色 / 附件 id）',
    JSON.stringify(await api.evaluate(lastCall('submit'))) === JSON.stringify([{
      text: '周五 10:30 接待重要客户',
      workspace: '/tmp/hand-typed/dir',
      followFolder: true,
      persona: { mode: 'inherit' },
      attachments: idsBeforeSubmit,
    }]),
    JSON.stringify(await api.evaluate(lastCall('submit'))))
  check('脚手架不导航 → 弹窗仍在（证明"提交只发意图，不自己收尾"）',
    await api.evaluate(count('.wb-dialog')) === 1)

  // ---------------------------------------------------------------- 关闭语义：× / ESC 不动附件，「取消」清空
  const beforeClose = (await api.evaluate(state)).attachmentIds
  await clickSelector('.wb-dialog-close')
  await api.waitFor(`return document.querySelector('.wb-dialog') === null`, { description: '点 × 收起弹窗' })
  check('点右上角 × → 容器只收到 close，附件**原样留着**（不顺手清空）',
    JSON.stringify(await api.evaluate(lastCall('close'))) === JSON.stringify([])
    && JSON.stringify((await api.evaluate(state)).attachmentIds) === JSON.stringify(beforeClose))
  await api.evaluate('__h4.setOpen(true); return true')
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '重新打开弹窗' })
  check('重新打开 → 附件仍在（现有语义就是"跨开关保留"，H4-7 一个 state 都没搬）',
    JSON.stringify((await api.evaluate(state)).attachmentIds) === JSON.stringify(beforeClose))

  await clickByText('.wb-dialog-foot', '取消')
  await api.waitFor(`return document.querySelector('.wb-dialog') === null`, { description: '点「取消」收起弹窗' })
  const cancelArgs = await api.evaluate(lastCall('cancel'))
  check('点「取消」→ 收到 cancel（带上了当时的附件数），附件真的被清空、说明也清掉',
    JSON.stringify(cancelArgs) === JSON.stringify([beforeClose.length])
    && JSON.stringify((await api.evaluate(state)).attachmentIds) === JSON.stringify([])
    && (await api.evaluate(state)).attachmentNotice === null,
    JSON.stringify(cancelArgs))
  await api.evaluate('__h4.setOpen(true); return true')
  await api.waitFor(`return document.querySelector('.wb-dialog') !== null`, { description: '再打开弹窗' })
  check('再打开 → 附件是空的（上一轮取消清的）',
    (await api.evaluate(state)).attachmentIds.length === 0)

  // ---------------------------------------------------------------- busy
  await typeIn('.wb-dialog-body textarea', '忙的时候也要能取消')
  await api.evaluate('__h4.setBusy(true); return true')
  check('busy：提交 / 添加附件 / 模型按钮都禁用',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === true
    && await api.evaluate(btnDisabled('.wb-quick-actions', '添加附件')) === true
    && await api.evaluate(`return document.querySelector('.wb-model-picker').disabled === true`))
  check('busy：「取消」**不**禁用（忙住了也得能退出）',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '取消')) === false)
  await api.evaluate('__h4.setBusy(false); return true')
  check('忙完了：提交恢复可点',
    await api.evaluate(btnDisabled('.wb-dialog-foot', '创建澄清会话')) === false)

  /**
   * 页面异常：脚手架是 `file://` 单页，**没有服务端**，所以角色库那次 `GET /api/workbench/personas`
   * 必然失败（CORS）—— 那正是上面"降级必须可读"那条用例的输入。除了它（与它带出的资源加载失败）
   * 之外不许有别的异常，尤其不许有 React 渲染期抛错。
   */
  const unexpectedErrors = api.pageErrors.filter((line) => !line.includes('/api/workbench/personas') && !line.includes('net::ERR_FAILED'))
  check('除脚手架里必然失败的 GET /personas 外，没有其它页面异常',
    unexpectedErrors.length === 0, JSON.stringify(unexpectedErrors).slice(0, 300))
} catch (error) {
  failed += 1
  console.log(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
