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
import { MatterDetail, MatterList, UpcomingDeadlines, deadlineStatusLabel } from '../lib/client/components/MattersView.js'
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
  /**
   * 入口文案用「案卷」而不是「案件」：本仓对**实体**的既有称谓是「案卷」（阶段 2/3 的注释、
   * 工具描述、设计文档、`workspacePath` 的界面标签都用它），只有"案卷所在的目录"才叫案卷目录。
   * 术语统一由 `test/matterView.test.mjs` 这条 + `docs` 里的称谓一起守。
   */
  assert.match(clientSource, /<Icon name="folder" \/>案卷/, '入口文案是「案卷」（与阶段 2/3 的既有称谓一致）')
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
    deadlines: [], engineAvailable: true, recomputeNote: '', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
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
    deadlines: [], engineAvailable: true, recomputeNote: '', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }))
  assert.match(html, /data-matter-undated/)
  assert.match(html, /没有可用日期/)
  assert.match(html, /导入时缺日期/)
})

// ---------------------------------------------------------------------------
// 阶段 5 · 5C：期限看板（跨案卷 + 案卷详情）
// ---------------------------------------------------------------------------

/**
 * 取出带某个 data 属性的 `<button>` 标签全文。
 *
 * ⚠️ 为什么不直接写 `/data-x[^>]*disabled/`：SSR 的属性顺序**跟 JSX 里的书写顺序一致**，
 * `disabled` 通常在 `data-*` 之前，于是这个"看起来合理"的正则永远匹配不上（本轮实测踩到）。
 * 先抓标签、再在标签内找属性，顺序怎么变都对。
 */
const buttonTag = (html, attr) => new RegExp(`<button[^>]*${attr}[^>]*>`).exec(html)?.[0] ?? ''

const deadlineRow = (over = {}) => ({
  id: 'dl1', label: '答复第一次审查意见', dueDate: '2026-10-20', dueDateRaw: '2026-10-15',
  basis: '专利法实施细则', status: 'pending', ...over,
})

test('5C：期限状态标签是闭集 —— 客户端这张表必须与仓储的 allowed 列表逐字一致', () => {
  /**
   * 跨文件判据：写入口只有一个（`repo/matters.ts#setMatterDeadlineStatus` 的 `allowed`），
   * 显示名只有一处（客户端的 `DEADLINE_STATUS_LABELS`）。两边各加一个值而另一边不知道，
   * 表现就是界面上冒出一个英文码（或更糟：一个没人能改的状态）。
   */
  const allowed = /const allowed = \[([^\]]+)\]/.exec(repoSource)
  assert.ok(allowed, '找不到仓储的 allowed 列表 —— 判据失去了对照物')
  const backendStatuses = allowed[1].split(',').map((part) => part.trim().replace(/['"]/g, '')).filter((part) => part !== '').sort()
  const labelSource = /const DEADLINE_STATUS_LABELS: Record<string, string> = \{([^}]*)\}/.exec(viewSource)
  assert.ok(labelSource, '找不到客户端的 DEADLINE_STATUS_LABELS')
  const clientStatuses = [...labelSource[1].matchAll(/(\w+):/g)].map((match) => match[1]).sort()
  assert.deepEqual(clientStatuses, backendStatuses, '两边必须一一对应（多一个就是幽灵标签，少一个就是英文码露给用户）')
  /**
   * 幽灵值不许出现：设计文档里那个 `calendar-uncovered` 没有任何代码产出它。
   * ⚠️ 扫之前必须**去注释**（本轮实测踩到）：文件里正有一段注释在解释"为什么不放它"，
   * 直接扫源码会把那段解释本身当成违规。
   */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.doesNotMatch(stripComments(viewSource), /calendar-uncovered/, 'calendar-uncovered 是文档里的幽灵值，不许做成标签')
  assert.equal(deadlineStatusLabel('pending'), '待处理')
  assert.equal(deadlineStatusLabel(null), '待处理', 'null 按待处理显示')
  assert.equal(deadlineStatusLabel('brand_new'), 'brand_new', '查不到原样显示码')
})

test('SSR：今日期限看板 —— 引擎缺失时明确说明降级，空看板必须能自证原因', () => {
  const degraded = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    deadlines: [], days: 7, engineAvailable: false, onRecomputeAll: () => {}, busy: false,
  }))
  assert.match(degraded, /data-deadline-degraded/, '引擎不可用时必须有一段说明')
  assert.match(degraded, /未探测到期限引擎/)
  assert.match(degraded, /明确降级/)
  // 引擎不可用时重算按钮要**禁用**（不给用户点一个必然 409 的按钮）
  assert.match(buttonTag(degraded, 'data-deadline-recompute'), /disabled/, '引擎不可用时重算按钮要禁用')

  const empty = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    deadlines: [], days: 7, engineAvailable: true, onRecomputeAll: () => {}, busy: false,
  }))
  assert.doesNotMatch(empty, /data-deadline-degraded/)
  assert.match(empty, /近 7 天内没有待办期限/)
})

test('SSR：期限看板渲染行（案号 + 标签 + 已过期标记），过期由服务端给的 overdue 决定', () => {
  const html = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    deadlines: [
      { id: 'a', matterId: 'm1', caseNumber: '2026-UM-002', matterTitle: '某装置', label: '答复一通', dueDate: '2026-09-28', status: 'pending', overdue: true },
      { id: 'b', matterId: 'm2', caseNumber: '2026-INV-001', matterTitle: '某方法', label: '缴年费', dueDate: '2026-10-02', status: 'pending', overdue: false },
    ],
    days: 7, engineAvailable: true, onRecomputeAll: () => {}, busy: false,
  }))
  assert.match(html, /2026-UM-002/)
  assert.match(html, /答复一通/)
  assert.match(html, /已过期/)
  assert.match(html, /2026-INV-001/)
  // 只有过期那条带 overdue 样式
  assert.equal((html.match(/wb-dl-row overdue/g) ?? []).length, 1)
})

test('SSR：案卷详情的期限区 —— 重算说明、顺延口径双日期、状态按钮、日历未覆盖提示', () => {
  const html = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: timeline(), notices: [],
    deadlines: [
      deadlineRow(),
      deadlineRow({ id: 'dl2', label: '缴年费', status: 'done', computedFrom: { calendarCaveat: '2027 年节假日表未覆盖' } }),
    ],
    engineAvailable: true, recomputeNote: '重算完成：2 条真日期期限；顺延口径：apply', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }))
  assert.match(html, /data-matter-recompute-note/)
  assert.match(html, /顺延口径：apply/)
  assert.match(html, /届满 2026-10-20/)
  assert.match(html, /不顺延 2026-10-15/, '顺延口径不同的两个日期都要写出来')
  assert.match(html, /待处理/)
  assert.match(html, /已完成/)
  assert.match(html, /data-deadline-caveat/, '日历未覆盖必须显示（否则用户以为届满日是权威值）')
  assert.match(html, /未覆盖/)

  // 引擎不可用：说明降级 + 重算按钮禁用
  const degraded = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: timeline(), notices: [], deadlines: [],
    engineAvailable: false, recomputeNote: '', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }))
  assert.match(degraded, /data-matter-engine-missing/)
  assert.match(buttonTag(degraded, 'data-matter-recompute'), /disabled/, '引擎不可用时重算按钮要禁用')
})

test('5C：前端全部走服务端 —— 重算/状态/看板都打端点，界面不算任何期限', () => {
  assert.match(clientSource, /\/deadlines\/recompute`/, '重算必须调引擎端点')
  assert.match(clientSource, /\/deadlines\/\$\{deadlineId\}`/, '状态改动走 PATCH 端点')
  assert.match(clientSource, /matter-deadlines\/upcoming\?days=/, '看板读聚合端点（不是遍历案卷 N+1 次）')
  // 界面不许自己拿今天比日期（时区口径只该在服务端算一次）
  assert.doesNotMatch(clientSource, /dueDate\s*<\s*localDateString/, '不许在客户端自己算"是否过期"')
  // 引擎可用性来自服务端软探测，而不是客户端猜
  assert.match(read('src/api/routes.ts'), /deadlineEngineAvailable: deps\.patentDeadline\?\.\(\) !== undefined/, 'bootstrap 要暴露引擎可用性')
  assert.match(clientSource, /bootstrap\?\.deadlineEngineAvailable === true/, '客户端读服务端的探测结果')
})

// ---------------------------------------------------------------------------
// 阶段 5 · 5D：域名词（产品名 + 实体称谓）统一
// ---------------------------------------------------------------------------

test('5D：界面/模型可见的字符串一律自称「专利工作台」（DOM 前缀与数据目录不在此列）', () => {
  /**
   * 判据的边界要说清：**改的是文案，不是标识**。以下三类**必须保留** `personal-workbench`：
   * `data-dsh-personal-workbench-*`（DOM 前缀，阶段 1 决定保留）、`~/.dsh/workbench/`（数据目录，
   * 改名等于知识库"消失"）、以及 fork 出处链接。所以这里只扫"会说给人/模型听"的字符串。
   */
  const files = [
    'src/index.ts', 'src/tools.ts', 'src/knowledge-tools.ts', 'src/knowledge-recall.ts',
    'src/review-memory.ts', 'src/client/index.tsx', 'src/client/quickAttachments.ts',
  ]
  for (const file of files) {
    const source = read(file)
    assert.doesNotMatch(source, /个人工作台/, `${file} 里还有旧产品名「个人工作台」`)
  }
  // 反向：改名不许改到标识上
  assert.match(read('src/client/styles.ts'), /data-dsh-personal-workbench-view/, 'DOM 前缀必须保留（阶段 1 的决定）')
  assert.match(read('src/db/database.ts'), /'\.dsh', 'workbench'|workbench\.db/, '数据目录必须保留（改名等于知识库消失）')
})

test('5D：实体的既有称谓是「案卷」—— 界面文案不再出现「案件」', () => {
  /**
   * 术语不统一是**可核实**的问题：同一屏里「案件」与「案卷」混用，用户会以为它们是两个东西。
   * 历史迁移注释里的旧表述（"案件 = 根任务"）是**当时的记录**，按纪律不改写，所以只扫这几处文案源。
   */
  const uiSources = ['src/client/index.tsx', 'src/client/components/MattersView.tsx', 'src/client/matterTimeline.ts']
  for (const file of uiSources) {
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.doesNotMatch(stripped, /案件/, `${file} 的用户可见文案里还有「案件」`)
  }
  assert.match(read('src/api/routes/matters.ts'), /案卷事件/, '路由注释的术语同步')
  assert.match(read('src/client/index.tsx'), /案卷目录/, '工作目录仍叫「案卷目录」（那是目录，不是实体）')
})

test('5D：package.json 描述与 README 已不宣称被删掉的功能（日报周报/点子/容量/重复）', () => {
  /**
   * 阶段 4 删了四块功能，但 `package.json` 的描述里还写着「日报周报」——
   * 这类"装盘页/仓库页上还宣传已删功能"的代价是用户照着找，找不到就说插件坏了。
   */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const word of ['日报', '周报', '点子', '容量', '重复任务']) {
    assert.doesNotMatch(pkg.description, new RegExp(word), `package.json 描述里还在宣传已删功能：${word}`)
  }
  assert.match(pkg.description, /案卷/, '描述要说出这个工作台的核心实体')
  assert.match(pkg.description, /期限/, '描述要说出期限看板')
  const readme = read('README.md')
  assert.doesNotMatch(readme, /仍是改造前的通用工作台形态/, 'README 的"现状"段不该再说改造前')
  /**
   * ⚠️ 只扫**功能列表**（版本历史之前）：`## 版本历史` 里 "1.15.2 …容量账本透明化" 是
   * **历史发版记录**，按本仓纪律不改写（它是"当时确实发过这个版"的事实）。
   */
  /**
   * 扫的是**功能条目行**（`- ✨ …` 那种），不是整段散文：
   * "现状"那段会**点名说"删掉了 X / Y"**（那是告知，不是宣传），把它算作违规会让判据变成噪声。
   * 真正的风险是功能列表里还挂着已删功能的卖点。
   */
  const bullets = readme.split('\n').filter((line) => line.startsWith('- ') || line.startsWith('- **')).join('\n')
  assert.ok(bullets.length > 0, '找不到 README 的功能条目 —— 判据失去对照物')
  for (const word of ['容量账本', '点子', '日报周报']) {
    assert.doesNotMatch(bullets, new RegExp(word), `README 功能列表里还在宣传已删功能：${word}`)
  }
  assert.match(bullets, /案卷/, 'README 功能列表要说出这个工作台的核心实体')
  /**
   * 历史部分（版本历史）**不许**被这条判据牵连：里面的 "容量账本透明化" 是发版记录，
   * 按纪律不改写。这里反向确认一下它确实还在（防止有人"顺手清理"历史）。
   */
  assert.match(readme.slice(readme.indexOf('## 版本历史')), /容量账本/, '版本历史里的发版记录不许被清理')
})

// ---------------------------------------------------------------------------
// 阶段 6 · bridge 收口：投影器的界面接线
// ---------------------------------------------------------------------------

test('SSR：时间线卡带「同步事件日志」按钮与方向说明（用户得能看出它不改案卷目录）', () => {
  const html = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: timeline(), notices: [],
    deadlines: [], engineAvailable: true, recomputeNote: '', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }))
  assert.match(html, /data-matter-sync-events/, '要有同步按钮')
  assert.match(html, /同步事件日志/)
  assert.match(html, /data-matter-sync-hint/, '要有方向说明')
  assert.match(html, /唯一事实源/, '说明里要点出日志是唯一事实源')
  assert.match(html, /_matter-log\.md/)
  assert.match(html, /不改写文件、不改已有事件/)

  const withNote = renderToStaticMarkup(createElement(MatterDetail, {
    matter: matter(), dicts: DICTS, timeline: timeline(), notices: [],
    deadlines: [], engineAvailable: true, recomputeNote: '',
    onSyncEvents: () => {}, syncNote: '已从 /x/_matter-log.md 同步：新增 2 条，已存在 0 条。⚠️ 1 行没解析出来（未进事件）：第 5 行（缺少动作）',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }))
  assert.match(withNote, /data-matter-sync-note/)
  assert.match(withNote, /没解析出来/)
  assert.match(withNote, /第 5 行/)
})

test('6：投影走服务端端点，界面与工具都不许自己解析日志格式', () => {
  assert.match(clientSource, /\/events\/sync`/, '界面必须走 sync 端点')
  assert.match(read('src/shared/matterLog.ts'), /export function parseMatterLog/)
  assert.match(read('src/db/repo/matters.ts'), /export function projectMatterLogEvents/)
  assert.doesNotMatch(read('src/client/components/MattersView.tsx'), /parseMatterLog|split\('\|'\)/, '界面不许自己解析日志')
  assert.match(read('src/matter-tools.ts'), /parseMatterLog\(content\)/, '工具复用同一份解析')
  assert.doesNotMatch(read('src/matter-tools.ts'), /split\('\|'\)/, '工具不许另写一份解析')
})
