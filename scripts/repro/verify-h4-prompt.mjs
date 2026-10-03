#!/usr/bin/env node
/**
 * H4-8 的**真浏览器**验证：共享提示词弹窗 `PromptModal`（9 个 mode 的补充提示词入口）。
 *
 * 这个弹窗的特殊之处是**它不是共用 `Modal`**，而是自建的 `.wb-modal-mask`/`.wb-modal`
 * （不 portal、不锁滚动、不抢焦点）。所以第一条断言就是把"结构没被换成共用 Modal"钉住 ——
 * 那是"纯搬家"的可见凭据，也是唯一能防止后来人"顺手统一一下"的判据。
 *
 * 用法：node scripts/repro/verify-h4-prompt.mjs
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
const PAGE = join(OUT_DIR, 'prompt-harness.html')
const SHOT = join(OUT_DIR, 'h4-8-prompt.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-8 PromptModal</title></head>',
  '<body style="margin:0">',
  '<script src="./prompt-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '1200,1000' })
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

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const text = (selector) => `const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent.trim()`
const state = 'return __h4.state()'
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
const bodyHas = (needle) => `return document.body.textContent.includes(${JSON.stringify(needle)})`
/** 三个选择器在弹窗里的**文档流顺序**（按 DOM 位置比较，不按源码）。 */
const pickerOrder = `
  const sels = ['.wb-persona-picker', '.wb-skill-picker', '.wb-model-picker'];
  const els = sels.map((s) => ({ s, el: document.querySelector(s) }));
  const missing = els.filter((x) => x.el === null).map((x) => x.s);
  if (missing.length > 0) return missing.map((s) => s + ':MISSING');
  return els.slice().sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1).map((x) => x.s);
`
const open = async (title) => { await api.evaluate(`__h4.open(${JSON.stringify(title)}); return true`) }

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪' })
  await open('AI 咨询')
  await api.waitFor(`return document.querySelector('.wb-modal') !== null`, { description: '提示词弹窗打开' })

  // ---------------------------------------------------------------- 结构：它**不是**共用 Modal
  check('结构仍是自建的 `.wb-modal-mask` + `.wb-modal`（没被换成共用 Modal）',
    await api.evaluate(count('.wb-modal-mask')) === 1
    && await api.evaluate(count('.wb-modal')) === 1
    && await api.evaluate(count('.wb-overlay')) === 0
    && await api.evaluate(count('.wb-dialog')) === 0)
  check('宽度仍是 `min(620px, 94vw)`（观感没动）',
    (await api.evaluate(`return document.querySelector('.wb-modal').style.width`)) === 'min(620px, 94vw)')
  check('标题是「补充 AI 提示词」，正文用容器给的 mode 标签（AI 咨询）+ "可留空"说明',
    await api.evaluate(text('.wb-modal h4')) === '补充 AI 提示词'
    && await api.evaluate(text('.wb-modal p')) === 'AI 咨询：可留空，留空则继续使用原有默认提示词；填写后会在默认提示词末尾追加你的补充要求。',
    String(await api.evaluate(text('.wb-modal p'))))
  check('输入框带 autoFocus 与示例占位',
    (await api.evaluate(`return document.querySelector('.wb-modal textarea').placeholder`) ?? '').includes('补充要求')
    && await api.evaluate(`return document.activeElement.tagName`) === 'TEXTAREA')
  check('底部两个动作在 `.wb-modal-actions` 里，顺序是「取消 / 开始」',
    await api.evaluate(count('.wb-modal-actions .wb-btn')) === 2
    && JSON.stringify((await api.evaluate(`return [...document.querySelectorAll('.wb-modal-actions .wb-btn')].map((b) => b.textContent.trim())`)))
      === JSON.stringify(['取消', '开始']))
  check('三个选择器按「角色 → 技能 → 模型」的文档流顺序渲染（AX-R07）',
    JSON.stringify(await api.evaluate(pickerOrder)) === JSON.stringify(['.wb-persona-picker', '.wb-skill-picker', '.wb-model-picker']),
    JSON.stringify(await api.evaluate(pickerOrder)))

  // ---------------------------------------------------------------- 输入与产物
  check('（可留空）还没输入时点「开始」也能确认 —— 空串等于"沿用原有默认提示词"',
    await api.evaluate(count('.wb-modal-actions .wb-btn.primary')) === 1)
  await clickByText('.wb-modal-actions', '开始')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'confirm')`, { description: '确认回调' })
  check('点「开始」→ 容器收到 resolve 载荷（text 为空串 + 技能空数组 + 角色为「未指定」）',
    JSON.stringify(await api.evaluate(lastCall('confirm'))) === JSON.stringify([{ text: '', skills: [], persona: { mode: 'inherit' } }]),
    JSON.stringify(await api.evaluate(lastCall('confirm'))))
  check('确认后弹窗收起（容器 `confirmPrompt` 里 `setPromptModal(null)`）',
    await api.evaluate(count('.wb-modal')) === 0)

  await open('AI 拆解')
  await api.waitFor(`return document.querySelector('.wb-modal') !== null`, { description: '再次打开' })
  check('再次打开：正文换成新的 mode 标签，输入框被容器复位成空',
    (await api.evaluate(text('.wb-modal p')) ?? '').startsWith('AI 拆解')
    && await api.evaluate(`return document.querySelector('.wb-modal textarea').value`) === '')
  await setInputValue('.wb-modal textarea', '只保留必要技术特征')
  check('输入正文 → 写回容器的 promptModal.value（弹窗自己不存副本）',
    (await api.evaluate(state)).promptModal.value === '只保留必要技术特征')

  // ---------------------------------------------------------------- 三组选择器
  await clickItem('.wb-persona-list .wb-persona-item', '无角色')
  check('角色：点「无角色」→ 容器收到 none，当前值文案跟着改',
    (await api.evaluate(state)).persona.mode === 'none'
    && (await api.evaluate(text('.wb-persona-current')) ?? '').includes('无角色'))
  await clickItem('.wb-skill-list .wb-skill-item', 'oa-reply')
  await api.waitFor(`return document.querySelectorAll('.wb-skill-tag').length === 1`, { description: '技能被选中' })
  check('技能：点一条 → 容器记下它，并出现已选标签',
    JSON.stringify((await api.evaluate(state)).selectedSkills) === JSON.stringify(['oa-reply'])
    && (await api.evaluate(text('.wb-skill-tag')) ?? '').includes('oa-reply'))
  await clickSelector('.wb-model-picker')
  check('模型：拿不到目录 → 菜单不打开（不摆假列表），把可读原因交给容器',
    await api.evaluate(count('.wb-model-menu')) === 0
    && ((await api.evaluate(state)).error ?? '').includes('无法读取模型列表'),
    String((await api.evaluate(state)).error))
  await api.screenshot(SHOT)

  // 产物契约：三样东西一起交给容器
  await clickByText('.wb-modal-actions', '开始')
  await api.waitFor(`return __h4.calls().filter((c) => c.name === 'confirm').length === 2`, { description: '第二次确认' })
  check('点「开始」→ 载荷同时带上正文 / 已选技能 / 角色（三样都跟着走，不是只带正文）',
    JSON.stringify(await api.evaluate(lastCall('confirm'))) === JSON.stringify([{
      text: '只保留必要技术特征', skills: ['oa-reply'], persona: { mode: 'none' },
    }]),
    JSON.stringify(await api.evaluate(lastCall('confirm'))))

  // ---------------------------------------------------------------- 关闭的两条路
  await open('AI 复盘')
  await api.waitFor(`return document.querySelector('.wb-modal') !== null`, { description: '第三次打开' })
  check('每次打开都复位（技能清空 + 角色回「未指定」）—— 上一次的选择不会静默继承',
    (await api.evaluate(state)).selectedSkills.length === 0
    && (await api.evaluate(state)).persona.mode === 'inherit'
    && await api.evaluate(count('.wb-skill-tag')) === 0
    && await api.evaluate(count('.wb-persona-item.on')) === 1)
  await clickByText('.wb-modal-actions', '取消')
  await api.waitFor(`return __h4.calls().some((c) => c.name === 'cancel')`, { description: '取消回调' })
  check('点「取消」→ 只发 cancel（不发 confirm），弹窗收起',
    JSON.stringify(await api.evaluate(lastCall('cancel'))) === JSON.stringify([])
    && await api.evaluate(count('.wb-modal')) === 0)

  // ---------------------------------------------------------------- 遮罩关闭 vs 点内部
  await open('AI 执行')
  await api.waitFor(`return document.querySelector('.wb-modal') !== null`, { description: '第四次打开' })
  await clickSelector('.wb-modal h4')
  check('点弹窗**内部**不关闭（`onClick` 里 stopPropagation 仍在）',
    await api.evaluate(count('.wb-modal')) === 1)
  /**
   * 点遮罩要落在"弹窗之外"：遮罩铺满视口，而它的**中心点**正好被居中的 `.wb-modal` 盖住 ——
   * 点中心会打到弹窗内部（stopPropagation）从而不关闭。所以取弹窗左侧 20px。
   */
  const maskPoint = await api.evaluate(`
    const modal = document.querySelector('.wb-modal').getBoundingClientRect();
    return { x: Math.round(modal.left - 20), y: Math.round(modal.top + 40) };
  `)
  await api.clickAt(maskPoint.x, maskPoint.y)
  await api.waitFor(`return __h4.calls().filter((c) => c.name === 'cancel').length === 2`, { description: '点遮罩取消' })
  check('点遮罩（弹窗之外）→ 走同一条 cancel 路径',
    JSON.stringify(await api.evaluate(lastCall('cancel'))) === JSON.stringify([])
    && await api.evaluate(count('.wb-modal')) === 0,
    JSON.stringify(await api.evaluate(lastCall('cancel'))))

  // ---------------------------------------------------------------- 技能降级 + busy
  await open('AI 计划')
  await api.waitFor(`return document.querySelector('.wb-modal') !== null`, { description: '第五次打开' })
  await api.evaluate(`__h4.setSkillsUnavailable('宿主没有装 skills 服务'); return true`)
  await api.waitFor(`return document.querySelector('.wb-skill-problem') !== null`, { description: '技能降级原因上线' })
  check('技能目录不可用 → 就地给原因 + 「重试」（不静默变成一个空块）',
    (await api.evaluate(text('.wb-skill-picker .wb-skill-problem')) ?? '').includes('暂不可用')
    && (await api.evaluate(text('.wb-skill-picker .wb-skill-problem')) ?? '').includes('宿主没有装 skills 服务')
    && await api.evaluate(count('.wb-skill-picker .wb-skill-problem .wb-btn')) === 1)
  check('降级时不让搜索/选择装作可用（列表整块不渲染）',
    await api.evaluate(count('.wb-skill-list')) === 0)
  await clickByText('.wb-skill-problem', '重试')
  check('点「重试」→ 容器收到 retrySkills 意图（弹窗不自己发请求）',
    JSON.stringify(await api.evaluate(lastCall('retrySkills'))) === JSON.stringify([]))

  await api.evaluate('__h4.setBusy(true); return true')
  check('busy：三个选择器都禁用（模型按钮 / 角色项 / 技能搜索都不许动）',
    await api.evaluate(`return document.querySelector('.wb-model-picker').disabled === true`)
    && await api.evaluate(`return [...document.querySelectorAll('.wb-persona-item')].every((el) => el.disabled === true)`)
    && await api.evaluate(`return document.querySelector('.wb-persona-item').disabled === true`))
  await api.evaluate('__h4.setBusy(false); return true')

  /**
   * 页面异常：脚手架是 `file://` 单页、没有服务端，角色库那次 `GET /api/workbench/personas`
   * 必然 CORS 失败 —— 那正是上面"降级要可读"那条用例的输入。除它（与它带出的资源加载失败）
   * 之外不许有别的异常，尤其不许有 React 渲染期抛错。
   */
  const unexpectedErrors = api.pageErrors.filter((line) => !line.includes('/api/workbench/personas') && !line.includes('net::ERR_FAILED'))
  check('除脚手架里必然失败的 GET /personas 外，没有其它页面异常',
    unexpectedErrors.length === 0, JSON.stringify(unexpectedErrors).slice(0, 300))
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-8 共享提示词弹窗：全绿' : `\nH4-8 共享提示词弹窗：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
