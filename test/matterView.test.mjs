/**
 * 案件视图（阶段 5 · 5B）的接线判据 —— 源码级扫描。
 *
 * 为什么这一层需要扫描而不是行为测试：这四处都是"跨文件的名字/装配"约定，
 * 错了**不会报错**，只会静默失效：
 *
 * | 判据 | 错了会怎样 |
 * |---|---|
 * | 客户端载荷字段名 == 路由读的键 | 服务端当未知字段忽略 → 用户勾了"要求优先权"，库里还是 0（**期限起算日错**） |
 * | 视图真的接进 `view` 联合与顶栏 | 代码写了但点不进去 |
 * | 详情真的拉三个端点 | 时间线永远空，看起来"这个案子没记录" |
 * | 时间线排序只在纯模块里 | 组件里再排一遍 → 同一语义两处实现（本项目第一大 bug 类别） |
 *
 * 第一条是**实测踩到**的：写客户端时先按 `MatterRow` 的 `isPctNationalPhase` 之外的名字
 *（`isPctNational`）发的载荷，而路由读的是 `isPctNationalPhase` —— 一路无错、静默丢字段。
 *
 * 绝不断言行号（本项目明确禁止脆行号断言），只按符号与片段断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MatterDetail, MatterList } from '../lib/client/components/MattersView.js'
import { buildMatterTimeline } from '../lib/client/matterTimeline.js'

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const clientSource = read('src/client/index.tsx')
const viewSource = read('src/client/components/MattersView.tsx')
const routeSource = read('src/api/routes/matters.ts')
const repoSource = read('src/db/repo/matters.ts')
const timelineSource = read('src/client/matterTimeline.ts')

test('5B：案卷载荷的字段名在四处必须一致（客户端 → 路由 → 仓储）—— 名字错了会被静默忽略', () => {
  /**
   * 逐个字段核对：客户端 `saveMatter` 发的键必须能在路由里找到同名读取，
   * 且仓储也认识这个名字。**不做"大概有就行"的弱断言** —— 判据就是这份名单。
   */
  const payloadKeys = ['caseNumber', 'title', 'clientId', 'matterType', 'patentKind', 'stageCode',
    'applicationNo', 'publicationNo', 'patentNo', 'filingDate', 'priorityDate', 'claimsPriority',
    'isPctNationalPhase', 'techField', 'ipc', 'inventors', 'applicant', 'attorney', 'workspacePath']
  for (const key of payloadKeys) {
    assert.match(clientSource, new RegExp(`\\b${key}:`), `客户端的案卷载荷缺 ${key}`)
    assert.match(routeSource, new RegExp(`\\b${key}\\b`), `路由没读 ${key} —— 发出去的会被静默丢弃`)
  }
  // 两个布尔（起算日输入）在仓储层也要认识
  for (const key of ['claimsPriority', 'isPctNationalPhase']) {
    assert.match(repoSource, new RegExp(`\\b${key}\\b`), `仓储不认识 ${key}`)
  }
  /**
   * 反向：客户端**不许**再出现仓储行字段名 `isPctNational`（少了 Phase 的那个）——
   * 它只存在于 `MatterRow`，从界面往服务端发就是丢字段。
   */
  assert.doesNotMatch(clientSource, /\bisPctNational\b(?!Phase)/, '客户端载荷里出现了 isPctNational（应为 isPctNationalPhase）')
})

test('5B：案件视图已接进视图联合与顶栏（否则代码在、点不进去）', () => {
  assert.match(clientSource, /useState<'today' \| 'calendar' \| 'list' \| 'knowledge' \| 'matters'>/, 'view 联合里必须有 matters')
  assert.match(clientSource, /view === 'matters' \? 'on' : ''/, '顶栏要有「案件」入口且带选中态')
  assert.match(clientSource, /<Icon name="folder" \/>案件/, '入口文案是「案件」')
  assert.match(clientSource, /view === 'matters' && \(/, '视图主体要挂在 matters 上')
})

test('5B：详情真的拉官文/期限/事件三份（少一份时间线就会静默缺一块）', () => {
  for (const part of ['notices', 'deadlines', 'events']) {
    assert.match(clientSource, new RegExp(`/api/workbench/matters/\\$\\{matterId\\}/${part}`), `详情没拉 ${part}`)
  }
  assert.match(clientSource, /Promise\.all\(/, '三份一起拉（分三次 setState 会闪出"只有官文、没有期限"的中间态）')
})

test('5B：时间线排序只在纯模块里 —— 组件与 index 都不许自己排', () => {
  assert.match(timelineSource, /export function buildMatterTimeline/, '纯模块必须导出唯一实现')
  assert.doesNotMatch(viewSource, /\.sort\(/, '组件不许再排一遍（同一语义两处实现）')
  assert.match(clientSource, /buildMatterTimeline\(\{/, 'index 必须走纯模块')
})

test('5B：字典查不到时原样显示码（不猜、更不留空）', () => {
  /**
   * 兜底责任在**两个真实查字典的地方**（视图的 `dictLabel` 与 index 注入给纯模块的
   * `labelOf`）；纯模块自己不碰字典，它只**约定** `labelOf` 不许返回空串
   *（所以这里断言的是"它确实把码交给调用方翻" + 那两处都兜到 code）。
   */
  assert.match(viewSource, /\?\? code/, 'dictLabel 的兜底必须是 code 本身')
  assert.match(clientSource, /\?\?\.code \?\? code|\?\.name \?\? code/, 'index 注入的 labelOf 兜底必须是 code 本身')
  assert.equal((timelineSource.match(/input\.labelOf\(/g) ?? []).length, 3, '三份数据源都要经 labelOf 翻中文（纯模块不自己查字典）')
  assert.match(timelineSource, /查不到\*\*必须原样返回 code\*\*/, '纯模块要把"不许返回空串"这条约定写在注释里')
  assert.match(viewSource, /const text = value === null \|\| value === undefined \|\| value === '' \? '—' : value/, '字段缺失要显示 "—"（留空看不出是"没有"还是"没渲染"）')
})

test('5B：新客户端模块必须登记进 `tsconfig.build.json` 的显式清单（本仓踩过的坑）', () => {
  /**
   * `tsconfig.build.json` 是**显式 include 清单**，且 tsc 对清单里不存在的文件**静默跳过**。
   * 后果有两面：删文件不同步 → 清单里留死条目；加文件不同步 → 新模块**根本没被编译**
   *（`lib/` 里缺文件，但 build 一路绿，只在测试里以 ERR_MODULE_NOT_FOUND 炸出来）。
   * 阶段 4 · C 片正是在这里踩过一次，所以两面都钉住。
   */
  const include = JSON.parse(readFileSync('tsconfig.build.json', 'utf8').replace(/\/\/.*/g, '')).include
  const missing = include.filter((entry) => !existsSync(entry))
  assert.deepEqual(missing, [], `tsconfig.build.json 里有不存在的条目：${missing.join(' / ')}`)
  for (const entry of ['src/client/matterTimeline.ts', 'src/client/components/MattersView.tsx']) {
    assert.ok(include.includes(entry), `新模块没登记进构建清单：${entry}（不登记就不会被编译）`)
  }
})

// ---------------------------------------------------------------------------
// SSR 冒烟：这两个组件会被真渲染（`index.tsx` 在案件视图里直接挂它们）
// ---------------------------------------------------------------------------

const DICTS = [
  { kind: 'matter_stage', code: 'open', name: '建档', config: { color: '#4F86F7' } },
  { kind: 'matter_type', code: 'drafting', name: '申请撰写', config: {} },
  { kind: 'patent_kind', code: 'utility_model', name: '实用新型', config: {} },
  { kind: 'notice_kind', code: 'office_action_first', name: '第一次审查意见通知书', config: {} },
  { kind: 'delivery_mode', code: 'electronic', name: '电子送达', config: {} },
]

const matter = (over = {}) => ({
  id: 'm1', caseNumber: '2026-UM-002', title: '一种兽用中药智能熬制设备', clientId: null,
  matterType: 'drafting', patentKind: 'utility_model', stageCode: 'open',
  applicationNo: null, publicationNo: null, patentNo: null, filingDate: '2026-09-20',
  priorityDate: null, claimsPriority: false, isPctNationalPhase: false, ipc: null, techField: null,
  inventors: null, applicant: null, attorney: null, workspacePath: null, closedAt: null,
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', ...over,
})

const timeline = () => buildMatterTimeline({
  events: [{ id: 'e1', action: '建案', artifact: null, approver: null, note: '签了委托书', at: '2026-09-20T10:00:00.000Z' }],
  notices: [{ id: 'n1', noticeKind: 'office_action_first', dispatchDate: '2026-10-05', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: 4, fileLink: null, note: null }],
  deadlines: [],
  labelOf: (kind, code) => DICTS.find((d) => d.kind === kind && d.code === code)?.name ?? code,
})

test('SSR：空列表给的是"去建档"的空态（不是空白页）', () => {
  const html = renderToStaticMarkup(createElement(MatterList, { matters: [], dicts: DICTS, selectedId: null, onOpen: () => {} }))
  assert.match(html, /还没有案卷/)
  assert.match(html, /data-matter-empty/)
})

test('SSR：列表带案号/名称/阶段中文名，缺失字段不崩', () => {
  const html = renderToStaticMarkup(createElement(MatterList, {
    matters: [matter(), matter({ id: 'm2', caseNumber: '2026-INV-001', title: '另一件', patentKind: null, filingDate: null })],
    dicts: DICTS, selectedId: 'm1', onOpen: () => {},
  }))
  assert.match(html, /2026-UM-002/)
  assert.match(html, /一种兽用中药智能熬制设备/)
  assert.match(html, /建档/)
  assert.match(html, /实用新型/)
  assert.match(html, /2026-INV-001/)
  assert.doesNotMatch(html, /undefined/, '缺字段不许渲染出 undefined')
})

test('SSR：详情渲染字段区 + 官文 + 时间线；字段缺失显示 —（不是空）', () => {
  const html = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: timeline(),
    notices: [{ id: 'n1', noticeKind: 'office_action_first', dispatchDate: '2026-10-05', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: 4, fileLink: null, note: null }],
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, busy: false,
  }))
  assert.match(html, /data-matter-detail="2026-UM-002"/)
  assert.match(html, /申请日/)
  assert.match(html, /2026-09-20/)
  assert.match(html, /第一次审查意见通知书/)
  assert.match(html, /发文 2026-10-05/)
  assert.match(html, /data-timeline-kind="event"/)
  assert.match(html, /data-timeline-kind="notice"/)
  assert.match(html, /签了委托书/)
  // 客户没填 → 显示 "—"，不留空
  assert.match(html, /data-matter-field="客户">—/)
  assert.doesNotMatch(html, /undefined/)
})

test('SSR：时间线里没有日期的条目要单独列出来并说明（不静默丢掉）', () => {
  const withUndated = buildMatterTimeline({
    events: [{ id: 'e9', action: '导入时缺日期', artifact: null, approver: null, note: null, at: '' }],
    notices: [], deadlines: [], labelOf: (_kind, code) => code,
  })
  const html = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: withUndated, notices: [],
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, busy: false,
  }))
  assert.match(html, /data-matter-undated/)
  assert.match(html, /没有可用日期/)
  assert.match(html, /导入时缺日期/)
})
