#!/usr/bin/env node
/**
 * H4-5 的**真浏览器**验证：`MatterPane`（案卷条 + 列表 + 详情）挂进页面。
 *
 * 容器那一侧用**生产函数**复刻：时间线由 `buildMatterTimeline()` 现算（与容器里那个
 * `useMemo` 同一处调用、同一份字典 labelOf），所以"事件/官文/期限 → 时间线"这条链在
 * 浏览器里跑的是产品实现。退化成记录器的只有"意图 → 请求"那几个回调。
 *
 * 用法：node scripts/repro/verify-h4-matters.mjs
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
const PAGE = join(OUT_DIR, 'matters-harness.html')
const SHOT = join(OUT_DIR, 'h4-5-matters.png')

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>H4-5 MatterPane</title></head>',
  '<body style="margin:0">',
  '<script src="./matters-harness.js"></script>',
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

/** 按文案点（`startsWith`：带图标的按钮文本里 svg 无文本）。限定在 `scope` 内找，避免拿错行。 */
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

const count = (selector) => `return document.querySelectorAll(${JSON.stringify(selector)}).length`
const bodyHas = (text) => `return document.body.textContent.includes(${JSON.stringify(text)})`
const lastCall = (name) => `
  const hits = __h4.calls().filter((c) => c.name === ${JSON.stringify(name)});
  return hits.length === 0 ? null : hits[hits.length - 1].args;
`
const rowCaseNumbers = `return [...document.querySelectorAll('[data-matter-row]')].map((el) => el.dataset.matterRow)`
const timelineKinds = `return [...document.querySelectorAll('[data-timeline-kind]')].map((el) => el.dataset.timelineKind)`
const timelineTexts = `return [...document.querySelectorAll('.wb-matter-tl [data-timeline-kind]')].map((el) => el.textContent.trim())`

try {
  await api.goto(pathToFileURL(PAGE).href)
  await api.waitFor('return globalThis.__h4 !== undefined', { description: 'harness 就绪（挂载案卷视图）' })

  // ---------------------------------------------------------------- 案卷条与列表
  check('案卷条写清总数（未选中时不提"已选"）',
    await api.evaluate(bodyHas('案卷 3 个')) && !(await api.evaluate(bodyHas('（已选 1 个）'))))
  check('列表三行、按容器给的顺序（后端 updated_at DESC）',
    JSON.stringify(await api.evaluate(rowCaseNumbers)) === JSON.stringify(['2026-INV-001', '2026-UM-002', '2026-INV-003']),
    JSON.stringify(await api.evaluate(rowCaseNumbers)))
  check('行元信息：阶段徽标 + 案型中文 + 专利类型 + 申请日',
    await api.evaluate(`return document.querySelector('[data-matter-row="2026-INV-001"]').textContent.includes('撰写中')`)
    && await api.evaluate(`return document.querySelector('[data-matter-row="2026-INV-001"]').textContent.includes('发明专利')`)
    && await api.evaluate(`return document.querySelector('[data-matter-row="2026-INV-001"]').textContent.includes('申请日 2026-09-20')`))
  check('无专利类型的行不渲染那一格（m2 只有案型「实用新型」）',
    await api.evaluate(`return document.querySelector('[data-matter-row="2026-UM-002"]').textContent.includes('实用新型')`))
  check('还没选中时详情区只给一句提示',
    await api.evaluate(bodyHas('选一个案卷看详情与时间线。')) && await api.evaluate(count('[data-matter-detail]')) === 0)

  // ---------------------------------------------------------------- 选中一行 → 明细三份一起到位
  await clickSelector('[data-matter-row="2026-UM-002"]')
  check('点一行 → 容器收到 open(m2) 且自己的选中 id 换掉',
    JSON.stringify(await api.evaluate(lastCall('open'))) === JSON.stringify(['m2'])
    && (await api.evaluate('return __h4.selectedId()')) === 'm2',
    JSON.stringify(await api.evaluate(lastCall('open'))))
  check('列表行高亮跟着走（.on）',
    await api.evaluate(`return document.querySelector('[data-matter-row="2026-UM-002"]').className.includes('on')`))
  check('案卷条改口「案卷 3 个（已选 1 个）」', await api.evaluate(bodyHas('案卷 3 个（已选 1 个）')))
  check('详情出现（按案号挂钩）且那句提示消失',
    await api.evaluate(`return document.querySelector('[data-matter-detail="2026-UM-002"]') !== null`) && !(await api.evaluate(bodyHas('选一个案卷看详情与时间线。'))))

  // ---------------------------------------------------------------- 字段区（缺失显示 "—"）
  check('字段区：案型翻译成中文、缺失的客户与申请日显示 "—"（不是 undefined）',
    await api.evaluate(`return document.querySelector('[data-matter-field="案型"]').textContent === '实用新型'`)
    && await api.evaluate(`return document.querySelector('[data-matter-field="客户"]').textContent === '—'`)
    && await api.evaluate(`return document.querySelector('[data-matter-field="申请日"]').textContent === '—'`)
    && !(await api.evaluate(bodyHas('undefined'))),
    await api.evaluate(`return document.querySelector('[data-matter-field="客户"]')?.textContent ?? null`))

  // ---------------------------------------------------------------- 官文登记
  check('官文区：计数 2 + 类型/发文日/送达方式/指定月数/文件链接都渲染',
    await api.evaluate(count('[data-matter-notice]')) === 2
    && await api.evaluate(bodyHas('第一次审查意见通知书'))
    && await api.evaluate(bodyHas('发文 2026-10-05'))
    && await api.evaluate(bodyHas('指定 4 个月'))
    && await api.evaluate(bodyHas('file:///tmp/oa1.pdf')))
  check('没填指定月数的那条官文不渲染"指定 个月"',
    (await api.evaluate(count('[data-matter-notice="n2"]'))) === 1
    && !(await api.evaluate(`return document.querySelector('[data-matter-notice="n2"]').textContent.includes('指定')`)))
  await clickByText('.wb-card', '登记官文')
  check('点「登记官文」→ 容器收到 addNotice（弹窗由容器摊开）',
    JSON.stringify(await api.evaluate(lastCall('addNotice'))) === JSON.stringify([]),
    JSON.stringify(await api.evaluate(lastCall('addNotice'))))
  await clickSelector('[data-matter-notice="n1"] .wb-btn')
  check('点某条官文的删除 → 容器收到 deleteNotice(n1)（确认弹窗由容器负责）',
    JSON.stringify(await api.evaluate(lastCall('deleteNotice'))) === JSON.stringify(['n1']),
    JSON.stringify(await api.evaluate(lastCall('deleteNotice'))))

  // ---------------------------------------------------------------- 期限
  check('期限区：届满日 / 不顺延的原始日 / 依据 / 状态中文 / 日历未覆盖标记都在',
    await api.evaluate(bodyHas('届满 2026-12-15'))
    && await api.evaluate(bodyHas('不顺延 2026-12-10'))
    && await api.evaluate(bodyHas('专利法实施细则'))
    && await api.evaluate(bodyHas('待处理'))
    && await api.evaluate(bodyHas('已完成'))
    && await api.evaluate(count('[data-deadline-caveat]') + ' === 1')
    && await api.evaluate(bodyHas('日历未覆盖')))
  check('重算说明按容器给的原话渲染（含引擎 pending 口径）',
    await api.evaluate(bodyHas('重算完成：2 条真日期期限')))
  await clickSelector('[data-matter-recompute]')
  check('点「重算期限」→ 容器收到 recompute(当前案卷 id)',
    JSON.stringify(await api.evaluate(lastCall('recompute'))) === JSON.stringify(['m2']),
    JSON.stringify(await api.evaluate(lastCall('recompute'))))
  await clickByText('[data-matter-deadline="d1"]', '标记完成')
  check('pending 的期限点「标记完成」→ setDeadlineStatus(d1, done)',
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))) === JSON.stringify(['d1', 'done']),
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))))
  await clickByText('[data-matter-deadline="d2"]', '标记未完成')
  check('已完成的那条按钮文案是「标记未完成」，点了回 pending',
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))) === JSON.stringify(['d2', 'pending']),
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))))
  await clickByText('[data-matter-deadline="d1"]', '免除')
  check('点「免除」→ setDeadlineStatus(d1, waived)',
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))) === JSON.stringify(['d1', 'waived']),
    JSON.stringify(await api.evaluate(lastCall('setDeadlineStatus'))))

  // ---------------------------------------------------------------- 时间线（生产函数现算）
  check('时间线计数 = 有日期的 5 条（事件 1 + 官文 2 + 期限 2）',
    await api.evaluate(count('.wb-matter-tl [data-timeline-kind]')) === 5,
    String(await api.evaluate(count('.wb-matter-tl [data-timeline-kind]'))))
  check('时间线三种 kind 都出现（事件 / 官文 / 期限）',
    JSON.stringify([...new Set(await api.evaluate(timelineKinds))].sort()) === JSON.stringify(['deadline', 'event', 'notice']),
    JSON.stringify(await api.evaluate(timelineKinds)))
  const first = await api.evaluate(timelineTexts)
  check('时间线按日期降序（首条是最近届满的 2026-12-15）',
    first[0].includes('2026-12-15'),
    JSON.stringify(first[0] ?? null))
  check('无日期的条目单独列出来并说明条数（不静默丢掉）',
    await api.evaluate(count('[data-matter-undated]')) === 1
    && await api.evaluate(bodyHas('以下 1 条没有可用日期')))

  // ---------------------------------------------------------------- 编辑 / 新建 / 同步
  await clickByText('.wb-card', '编辑')
  check('点「编辑」→ 容器收到 edit(当前案卷 id)（编辑框初值由容器填空）',
    JSON.stringify(await api.evaluate(lastCall('edit'))) === JSON.stringify(['m2']),
    JSON.stringify(await api.evaluate(lastCall('edit'))))
  await clickSelector('[data-matter-create]')
  check('点「新建案卷」→ 容器收到 create()（不带参数 = 新建）',
    JSON.stringify(await api.evaluate(lastCall('create'))) === JSON.stringify([]),
    JSON.stringify(await api.evaluate(lastCall('create'))))
  await clickSelector('[data-matter-sync-events]')
  check('点「同步事件日志」→ 容器收到 syncEvents(当前案卷 id)',
    JSON.stringify(await api.evaluate(lastCall('syncEvents'))) === JSON.stringify(['m2']),
    JSON.stringify(await api.evaluate(lastCall('syncEvents'))))
  check('同步按钮旁写清方向（"只读、不改写文件"）',
    await api.evaluate(bodyHas('_matter-log.md')) && await api.evaluate(bodyHas('不改写文件、不改已有事件')))

  // ---------------------------------------------------------------- 引擎降级
  await api.evaluate('__h4.setEngineAvailable(false); return true;')
  await api.waitFor(`return document.querySelector('[data-matter-engine-missing]') !== null`, { description: '降级说明出现' })
  check('引擎不可用 → 出现降级说明且「重算期限」被禁用',
    await api.evaluate(bodyHas('未探测到期限引擎'))
    && await api.evaluate(`return document.querySelector('[data-matter-recompute]').disabled === true`))
  await api.evaluate('__h4.setEngineAvailable(true); return true;')
  await api.waitFor(`return document.querySelector('[data-matter-engine-missing]') === null`, { description: '降级说明消失' })
  check('引擎恢复 → 说明消失、按钮可点',
    await api.evaluate(`return document.querySelector('[data-matter-recompute]').disabled === false`))

  // ---------------------------------------------------------------- 空态
  await api.evaluate('__h4.setMattersEmpty(true); return true;')
  await api.waitFor(`return document.querySelector('[data-matter-empty]') !== null`, { description: '空态出现' })
  check('一条都没有 → 「还没有案卷」+ 案卷条写 0 个 + 不渲染详情占位',
    await api.evaluate(bodyHas('还没有案卷'))
    && await api.evaluate(bodyHas('案卷 0 个'))
    && !(await api.evaluate(bodyHas('选一个案卷看详情与时间线。'))))
  check('空态下「新建案卷」仍可点（这是唯一的出口）',
    await api.evaluate(`return document.querySelector('[data-matter-create]').disabled === false`))
  await api.evaluate('__h4.setMattersEmpty(false); return true;')
  await api.waitFor(`return document.querySelector('[data-matter-row]') !== null`, { description: '回到列表' })
  check('恢复列表后选中被清空（容器在换数据时一并清掉）',
    (await api.evaluate('return __h4.selectedId()')) === null && await api.evaluate(bodyHas('选一个案卷看详情与时间线。')))

  // ---------------------------------------------------------------- 页面无异常
  check('无页面异常 / 无 console error', api.pageErrors.length === 0, JSON.stringify(api.pageErrors).slice(0, 300))

  await clickSelector('[data-matter-row="2026-UM-002"]')
  await api.screenshot(SHOT)
  console.log(`\n截图：${SHOT.replace(`${ROOT}/`, '')}`)
} catch (error) {
  failed += 1
  console.error(`❌ 驱动失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await api.close()
}

console.log(failed === 0 ? '\nH4-5 真浏览器验证：全绿' : `\nH4-5 真浏览器验证：${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
