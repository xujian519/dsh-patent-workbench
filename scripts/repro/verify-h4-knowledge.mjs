#!/usr/bin/env node
/**
 * H4-4 的**真浏览器**验证：左栏 `KnowledgeView` + 右栏 `KnowledgeDetailPane` 一起挂进页面。
 *
 * 这个驱动比前几个更"实"：容器那一侧用的是**生产代码**（`useKnowledgeView` 真 hook +
 * `buildKnowledgePayload` 真函数），所以"搜索/筛选/排序/翻页/落盘"与"表单 → 载荷"整条链
 * 走的就是产品实现；退化成记录器的只有"意图 → 请求"那几个回调。
 *
 * 用法：node scripts/repro/verify-h4-knowledge.mjs
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
const PAGE = join(OUT_DIR, 'knowledge-harness.html')
const SHOT = join(OUT_DIR, 'h4-4-knowledge.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-4 KnowledgeView</title></head>',
  '<body style="margin:0">',
  '<script src="./knowledge-harness.js"></script>',
  '</body></html>',
].join('\n'), 'utf8')

const api = await launchDebugBrowser({ browserPath: browser.path, appUrl: 'about:blank', windowSize: '1400,900' })
let failed = 0
let skipped = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const skip = (name, why) => { skipped += 1; console.log(`⏭️  ${name} — ${why}`) }

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

/** 按文案点（`startsWith`：带图标的按钮文本里 svg 无文本、Tab 带计数）。 */
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

/** 受控 select：必须走原型 setter + 冒泡 change，否则 React 收不到。 */
async function setSelect(selector, value) {
  const ok = await api.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  if (!ok) throw new Error(`找不到 select：${selector}`)
}

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
const rowTitles = `return [...document.querySelectorAll('[data-kb-row] .wb-kb-title')].map((el) => el.textContent)`
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载知识视图两半）' })

  // ---------------------------------------------------------------- 工具条与首屏
  check('工具条四件套在（搜索 / 排序 / 命中数 / 三个按钮）',
    await api.evaluate(`return document.querySelector('[data-kb-search]') !== null && document.querySelector('.wb-kb-sortkey') !== null && document.querySelector('[data-kb-hit]') !== null && document.querySelector('[data-kb-new]') !== null && document.querySelector('[data-kb-summarize]') !== null && document.querySelector('[data-kb-clear]') !== null`))
  check('命中数 = 12（全部条目）', await api.evaluate(textOf('[data-kb-hit]') + ' === "命中 12 条"'), await api.evaluate(textOf('[data-kb-hit]')))
  check('分类 Tab 由字典拼出（全部 / 经验教训 / 笔记 / 决策）',
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('[data-tabbar] .wb-tab')].map((el) => el.textContent.replace(/\\d+/g, '').trim())`)) === JSON.stringify(['全部', '经验教训', '笔记', '决策']),
    JSON.stringify(await api.evaluate(`return [...document.querySelectorAll('[data-tabbar] .wb-tab')].map((el) => el.textContent.trim())`)))
  check('首屏列表 10 行（默认每页 10）', await api.evaluate(count('[data-kb-row]')) === 10, String(await api.evaluate(count('[data-kb-row]'))))
  check('分页器写清"第 1–10 条 / 共 12 条"', await api.evaluate(bodyHas('第 1–10 条 / 共 12 条')))
  check('时间分组表头在（列表按更新时间分组）', await api.evaluate(count('[data-kb-group]') + ' >= 1'))

  // ---------------------------------------------------------------- 翻页 → 搜索把页码拨回 0
  await clickSelector('[data-kb-page="1"]')
  check('点第 2 页 → 当前页变 1（0 起）',
    (await api.evaluate('return __h4.page().page')) === 1, JSON.stringify(await api.evaluate('return __h4.page()')))
  check('第 2 页只剩 2 行', await api.evaluate(count('[data-kb-row]')) === 2, String(await api.evaluate(count('[data-kb-row]'))))
  await typeInto('[data-kb-search]', '经验 C')
  check('搜索"经验 C" → 命中 1 条', await api.evaluate(textOf('[data-kb-hit]') + ' === "命中 1 条"'), await api.evaluate(textOf('[data-kb-hit]')))
  check('搜索会把页码拨回第 1 页（否则搜完可能停在空页）',
    (await api.evaluate('return __h4.page().page')) === 0)
  check('只剩命中那一条', JSON.stringify(await api.evaluate(rowTitles)) === JSON.stringify(['经验 C']),
    JSON.stringify(await api.evaluate(rowTitles)))

  // ---------------------------------------------------------------- 分类 Tab / 标签 / 清空
  await clickSelector('[data-kb-search]')
  await typeInto('[data-kb-search]', '')
  await clickByText('[data-tabbar] .wb-tab', '经验教训')
  check('点「经验教训」Tab → 只留该分类（12 条里 4 条：k01/k04/k07/k10）',
    await api.evaluate(count('[data-kb-row]')) === 4 && await api.evaluate(bodyHas('命中 4 条')),
    String(await api.evaluate(count('[data-kb-row]'))))
  check('选中态落在 Tab 上（走共用 TabBar 的选中判定）',
    await api.evaluate(`return document.querySelector('[data-tab="lesson"]').className.includes('on')`))
  await clickSelector('[data-kb-tag="检索"]')
  check('点标签「检索」→ 分类 ∩ 标签（4 条经验教训里标签为"检索"的 2 条：k01/k07）',
    await api.evaluate(count('[data-kb-row]')) === 2 && await api.evaluate(bodyHas('命中 2 条')),
    String(await api.evaluate(count('[data-kb-row]'))))
  check('清空筛选按钮此时可点（有生效条件）',
    await api.evaluate(`return document.querySelector('[data-kb-clear]').disabled === false`))
  await clickSelector('[data-kb-clear]')
  check('点「清空筛选」→ 回到全部 12 条、Tab 回「全部」、搜索框清空',
    await api.evaluate(count('[data-kb-row]')) === 10 && await api.evaluate(bodyHas('命中 12 条')) && await api.evaluate(`return document.querySelector('[data-kb-search]').value === '' && document.querySelector('[data-tab="all"]').className.includes('on')`),
    String(await api.evaluate(count('[data-kb-row]'))))

  // ---------------------------------------------------------------- 排序与每页条数
  check('默认按更新时间：updatedAt 全并列 ⇒ 保持输入顺序（首行 经验 C）',
    (await api.evaluate(`return document.querySelector('[data-kb-row] .wb-kb-title').textContent`)) === '经验 C',
    String(await api.evaluate(`return document.querySelector('[data-kb-row] .wb-kb-title').textContent`)))
  await setSelect('.wb-kb-sortkey', 'title')
  // 默认方向是 desc（`DEFAULT_SORT_DIR`）→ 标题降序：L 开头、A 收尾
  const sorted = await api.evaluate(rowTitles)
  // ⚠️ 这一页只有 10 行（共 12 条）：降序的前 10 条是 L…C，**不是** A…J
  check('排序键改「标题」→ 按标题降序（首行 经验 L、本页末行 经验 C）；命中集合不变',
    sorted[0] === '经验 L' && sorted[sorted.length - 1] === '经验 C'
    && JSON.stringify([...sorted].sort()) === JSON.stringify(['经验 C', '经验 D', '经验 E', '经验 F', '经验 G', '经验 H', '经验 I', '经验 J', '经验 K', '经验 L']),
    JSON.stringify(sorted.slice(0, 3)))
  await clickSelector('[data-kb-sortdir]')
  const reversed = await api.evaluate(rowTitles)
  /**
   * ⚠️ 断言只能断言**本页**的顺序：升序的前 10 条是 A…J（共 12 条，第 2 页才是 K、L）。
   * 第一版我写成"等于上一页的整体反转"（C…L），红了 —— 错的是我的期望，分页与排序的先后
   * 是 `listPresentation` 的既有语义（先排序、再切页）。
   */
  check('点排序方向 → 升序（首行 经验 A、本页末行 经验 J）',
    reversed[0] === '经验 A' && reversed[reversed.length - 1] === '经验 J'
    && JSON.stringify(reversed) === JSON.stringify(['经验 A', '经验 B', '经验 C', '经验 D', '经验 E', '经验 F', '经验 G', '经验 H', '经验 I', '经验 J']),
    JSON.stringify(reversed.slice(0, 3)))
  await setSelect('[data-kb-pagesize]', '20')
  check('每页改 20 → 12 条一页放完（分页器写"第 1–12 条 / 共 12 条"且没有可点的第 2 页）',
    await api.evaluate(count('[data-kb-row]')) === 12
    && await api.evaluate(bodyHas('第 1–12 条 / 共 12 条'))
    && await api.evaluate(`return [...document.querySelectorAll('[data-kb-page]')].filter((b) => !b.disabled).every((b) => b.dataset.kbPage === '0')`),
    String(await api.evaluate(count('[data-kb-row]'))))
  await clickSelector('[data-kb-sortdir]')
  await setSelect('.wb-kb-sortkey', 'updatedAt')
  await setSelect('[data-kb-pagesize]', '10')

  // ---------------------------------------------------------------- 打开条目 → 右栏
  await clickSelector('[data-kb-row="k01"]')
  check('点条目 → 容器收到 openEntry(k01)',
    JSON.stringify(await api.evaluate(lastCall('openEntry'))) === JSON.stringify(['k01']),
    JSON.stringify(await api.evaluate(lastCall('openEntry'))))
  check('列表行高亮跟着走（.sel）',
    await api.evaluate(`return document.querySelector('[data-kb-row="k01"]').className.includes('sel')`))
  check('右栏条目卡：标题 + 分类徽标 + 标签',
    (await api.evaluate(bodyHas('经验 C'))) && (await api.evaluate(bodyHas('经验教训'))) && (await api.evaluate(bodyHas('#检索'))))
  check('右栏条目卡：归入的案卷显示案号', await api.evaluate(bodyHas('案卷：2026-INV-001')))
  check('右栏条目卡：本地文件 chip + 「打开文件」',
    (await api.evaluate(bodyHas('file:///tmp/检索笔记.md'))) && (await api.evaluate(bodyHas('打开文件'))))
  check('右栏条目卡：关联任务显示**任务标题**（容器解析）', await api.evaluate(bodyHas('某案的权利要求改写')))
  check('右栏条目卡：正文渲染出来', await api.evaluate(bodyHas('正文 C 的要点')))
  await clickByText('.wb-card .wb-btn', '打开文件')
  check('点「打开文件」→ 容器 onOpenFile(链接)',
    JSON.stringify(await api.evaluate(lastCall('openFile'))) === JSON.stringify(['file:///tmp/检索笔记.md']),
    JSON.stringify(await api.evaluate(lastCall('openFile'))))
  await clickByText('.wb-card .wb-btn', '某案的权利要求改写')
  check('点关联任务 → 容器 onOpenTask(任务 id)',
    JSON.stringify(await api.evaluate(lastCall('openTask'))) === JSON.stringify(['t1']),
    JSON.stringify(await api.evaluate(lastCall('openTask'))))

  // ---------------------------------------------------------------- 编辑：初值来自库里 + 取消
  await clickByText('.wb-card .wb-btn', '编辑')
  check('点「编辑」→ 表单出现且标题写「编辑知识条目」', await api.evaluate(bodyHas('编辑知识条目')))
  check('表单初值来自这条真值（标题 / 正文）',
    await api.evaluate(`return document.querySelector('.wb-form input').value === '经验 C' && document.querySelector('.wb-form textarea').value === '正文 C 的要点'`),
    await api.evaluate(`return document.querySelector('.wb-form input')?.value ?? null`))
  check('标签数组在表单里是逗号串（join`, `）', await api.evaluate(`return [...document.querySelectorAll('.wb-form input')][1].value === '检索'`),
    await api.evaluate(`return [...document.querySelectorAll('.wb-form input')][1]?.value ?? null`))
  await clickByText('.wb-form .wb-btn', '取消')
  check('点「取消」→ 回到条目卡（表单消失）',
    (await api.evaluate(`return document.querySelector('.wb-form') === null`)) && (await api.evaluate(bodyHas('经验 C'))))

  // ---------------------------------------------------------------- 新建：表单 → 载荷（真实现）
  await clickSelector('[data-kb-new]')
  check('点工具条「新建」→ 表单出现且标题写「新建知识条目」', await api.evaluate(bodyHas('新建知识条目')))
  check('新建的初始分类是 note（与拆分前同一默认值）',
    await api.evaluate(`return document.querySelector('.wb-form select').value === 'note'`))
  await typeInto('.wb-form input', '  新经验：检索式怎么攒  ')
  await api.evaluate(`
    const el = [...document.querySelectorAll('.wb-form input')][1];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'TTS, #踩坑  经验');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await clickByText('.wb-form .wb-btn', '保存')
  const submitted = await api.evaluate(lastCall('submit'))
  check('提交 → 载荷由 `buildKnowledgePayload` 拼出（标题 trim、标签切分去重空白、空串归一 null）',
    JSON.stringify(submitted) === JSON.stringify([{
      editing: false,
      payload: {
        title: '新经验：检索式怎么攒', contentMd: '', kindCode: 'note', tags: ['TTS', '踩坑', '经验'],
        sourceTaskId: null, sourceReviewId: null, matterId: null, fileLink: null,
      },
    }]),
    JSON.stringify(submitted))
  check('提交后表单收起（容器清掉草稿）', await api.evaluate(`return document.querySelector('.wb-form') === null`))

  // ---------------------------------------------------------------- 删除：确认后清选中
  await clickSelector('[data-kb-row="k01"]')
  await clickByText('.wb-card .wb-btn', '删除')
  check('点「删除」→ 容器收到 delete(k01)（确认弹窗由容器负责，harness 直接放行）',
    JSON.stringify(await api.evaluate(lastCall('delete'))) === JSON.stringify(['k01']),
    JSON.stringify(await api.evaluate(lastCall('delete'))))
  check('删除后右栏回到占位（没有选中的条目）', await api.evaluate(bodyHas('← 从左侧选择或新建知识条目')))

  // ---------------------------------------------------------------- 空态
  await api.evaluate('__h4.setEntriesEmpty(true); return true;')
  await api.waitFor(`return document.body.textContent.includes('还没有知识条目')`, { description: '空态出现' })
  check('一条都没有时：工具条仍在 + 空态说明 + 「新建知识」入口',
    await api.evaluate(`return document.querySelector('[data-kb-search]') !== null && document.body.textContent.includes('还没有知识条目') && document.body.textContent.includes('新建知识')`))
  await api.evaluate('__h4.setEntriesEmpty(false); return true;')
  await api.waitFor('return document.querySelector("[data-kb-row]") !== null', { description: '回到列表' })

  // ---------------------------------------------------------------- 落盘：改筛选 → 刷新页面 → 还在
  const storage = await api.evaluate('return __h4.storageAvailable()')
  if (!storage) {
    skip('刷新后仍保持 Tab 与每页条数', 'file:// 页面的 localStorage 不可用（生产里由面板页提供）')
  } else {
    await clickByText('[data-tabbar] .wb-tab', '笔记')
    await setSelect('[data-kb-pagesize]', '20')
    await api.goto(pathToFileURL(PAGE).href)
    await api.waitFor('return globalThis.__h4 !== undefined', { description: '刷新后重新挂载' })
    check('刷新页面后：Tab 仍停在「笔记」、每页仍是 20（落盘 → 读回这条链）',
      await api.evaluate(`return document.querySelector('[data-tab="note"]').className.includes('on') && document.querySelector('[data-kb-pagesize]').value === '20'`),
      await api.evaluate(`return document.querySelector('[data-tabbar] .wb-tab.on')?.textContent.trim() ?? null`))
    await clickSelector('[data-kb-clear]')
    await setSelect('[data-kb-pagesize]', '10')
  }

  // ---------------------------------------------------------------- 页面无异常
  check('无页面异常 / 无 console error', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))

  await clickSelector('[data-kb-row="k01"]')
  await api.screenshot(SHOT)
  console.log(`\n截图：${SHOT.replace(`${ROOT}/`, '')}`)
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? `\nH4-4 真浏览器验证：全绿${skipped === 0 ? '' : `（${skipped} 条跳过）`}` : `\nH4-4 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
