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
import { MatterDetail, MatterList, UpcomingDeadlines, createMatterSectionState, deadlineStatusLabel, filterMatters, isMatterFilterActive, matterListCountLabel, matterStageOptions, reconcileMatterSectionState, retainSelectedMatterId, toggleMatterSection } from '../lib/client/components/MattersView.js'
import { MatterDetailPane } from '../lib/client/components/views/MatterDetailPane.js'
import { MatterPane } from '../lib/client/components/views/MatterPane.js'
import { buildMatterTimeline } from '../lib/client/matterTimeline.js'

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const clientSource = read('src/client/index.tsx')
const viewSource = read('src/client/components/MattersView.tsx')
/**
 * H4-5 把案卷视图主体（案卷条 + 列表 + 详情）搬去了 `components/views/MatterPane.tsx`。
 * 扫描范围因此**扩到新落点**（plan §5.4：迁移而不是删除）——`viewSource` 仍是那两个部件的
 * 家，视图装配那几条改看 `paneSource`，并各补一条反向断言（`index.tsx` 不许再直接渲染它们）。
 *
 * 2026-10-16：案卷视图拆成左右两半（`.wb-nav` 左栏 = `MatterPane`，`.wb-detail` 右栏 =
 * `MatterDetailPane`）。详情那条判据的**落点**随之从 `paneSource` 迁到 `detailPaneSource`，
 * 意图一个字没改（详情必须由视图组件渲染，不许回到容器），并补了三条反向判据 ——
 * 左栏不许再画详情、容器必须挂右栏组件、那次挂载必须在 `.wb-detail` 之后。
 */
const paneSource = read('src/client/components/views/MatterPane.tsx')
const detailPaneSource = read('src/client/components/views/MatterDetailPane.tsx')
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
  /**
   * H4-5 之后"主体"是那个搬出去的组件：容器只许挂一个 `<MatterPane …/>`，
   * 列表与详情只许在它里面渲染（多一处就是"同一语义两处实现"，本项目第一大 bug 类别）。
   */
  assert.match(clientSource, /<MatterPane\b/, 'matters 视图主体必须挂新的 MatterPane（H4-5）')
  assert.doesNotMatch(clientSource, /<Matter(List|Detail)\b/, 'index.tsx 不许再直接渲染列表/详情（已搬进 MatterPane）')
  assert.match(paneSource, /<MatterList\b/, 'MatterPane 里必须真的挂列表')
  /**
   * 详情那半边（2026-10-16 迁落点，判据意图不变）。
   * ⚠️ `/<MatterDetail\b/` 匹配不到 `<MatterDetailPane`（`\b` 在 `Detail` 与 `Pane` 之间不成立），
   * 所以这两条断言各盯各的组件，一个字都不用放宽。
   */
  assert.match(detailPaneSource, /<MatterDetail\b/, 'MatterDetailPane 里必须真的挂详情')
  assert.doesNotMatch(paneSource, /<MatterDetail\b/, 'MatterPane（左栏）不许再画详情 —— 详情在右栏的 MatterDetailPane')
  assert.match(clientSource, /<MatterDetailPane\b/, '容器必须挂 MatterDetailPane（右栏）')
  /**
   * 只看"挂了一次"不够：挂回左栏照样是一次，而用户要的是"**详情在右侧**"。
   * 所以再加一条位置判据 —— 那次挂载必须在 `.wb-detail` 这个 div 之后（用 `indexOf` 比较，不写行号）。
   * ⚠️ 这只是**顺序启发式**，证明不了包含关系（挂到文件更靠后的弹窗里照样绿）；
   * 结构真相在真浏览器断言里：`verify-h4-matters.mjs` 量 `.wb-nav [data-matter-detail]` 必须为 0。
   */
  assert.ok(
    clientSource.indexOf('<div className="wb-detail">') < clientSource.indexOf('<MatterDetailPane'),
    'MatterDetailPane 必须挂在右栏容器 .wb-detail 里（在 .wb-detail 之后出现）',
  )
  // 占位文案跟着详情走：左栏那句「选一个案卷看详情与时间线。」已随详情搬到右栏。
  assert.doesNotMatch(paneSource, /选一个案卷看详情/, '左栏不再出详情占位（详情那一半搬走了）')
  assert.match(detailPaneSource, /从左侧选择一个案卷查看详情/, '右栏要有"还没选"的占位')
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
  assert.match(html, /data-matter-sticky/)
  assert.match(html, /data-matter-summary/)
  assert.match(html, /申请撰写 · — · —/)
  assert.equal((html.match(/data-matter-open="1"/g) ?? []).length, 4, '四区默认展开')
  assert.doesNotMatch(html, /hidden=""/, '默认展开时身体不要带 hidden')
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
// 2026-10-16：右栏（`MatterDetailPane`）—— 详情搬去 `.wb-detail` 之后的真渲染
// ---------------------------------------------------------------------------

/** 右栏组件的完整 props（选中项与明细可覆盖）。 */
const detailPaneProps = (over = {}) => ({
  selectedMatter: matter(), matterCount: 1, dicts: DICTS, timeline: timeline(),
  notices: [], deadlines: [], engineAvailable: true, recomputeNote: '', syncNote: '', busy: false,
  onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, onSyncEvents: () => {},
  ...over,
})

test('SSR：右栏选中案卷 —— 四块（字段/官文/期限/时间线）都真的渲染出来', () => {
  /**
   * 这条防的是"拆成两个组件之后，右栏只挂了个空壳"：详情本体在 `MatterDetail` 部件里，
   * 这里逐块点一遍（字段 / 官文 / 期限 / 时间线 / 同步按钮），确认转发没漏。
   */
  const html = renderToStaticMarkup(createElement(MatterDetailPane, detailPaneProps({
    notices: [{ id: 'n1', noticeKind: 'office_action_first', dispatchDate: '2026-10-05', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: 4, fileLink: null, note: null }],
    deadlines: [deadlineRow()],
  })))
  assert.match(html, /data-matter-detail="2026-UM-002"/)
  assert.match(html, /data-matter-field="客户">—/)
  assert.match(html, /第一次审查意见通知书/)
  assert.match(html, /届满 2026-10-20/)
  assert.match(html, /data-timeline-kind="event"/)
  assert.match(html, /data-matter-sync-events/)
  assert.doesNotMatch(html, /从左侧选择一个案卷查看详情/, '选中了就不该再出占位')
  assert.doesNotMatch(html, /undefined/)
})

test('SSR：右栏未选中 —— 有案卷时给占位；一条案卷都没有时什么都不画', () => {
  const withMatters = renderToStaticMarkup(createElement(MatterDetailPane, detailPaneProps({ selectedMatter: null, matterCount: 3 })))
  assert.match(withMatters, /data-matter-detail-empty/)
  assert.match(withMatters, /← 从左侧选择一个案卷查看详情/)
  assert.doesNotMatch(withMatters, /data-matter-detail="/, '没选中就没有详情挂点')

  /**
   * 空库这一支是**故意**不给占位的：左栏列表自己的空态写着「还没有案卷。点「新建案卷」建档…」，
   * 右栏再喊一句"从左侧选一个"是句做不到的话（与期限看板"空看板必须能自证原因"同一条口径）。
   */
  const noMatters = renderToStaticMarkup(createElement(MatterDetailPane, detailPaneProps({ selectedMatter: null, matterCount: 0 })))
  assert.equal(noMatters, '', '空库时右栏渲染空串（不是占位）')
})

test('5B：重拉案卷列表后失效的选中要清掉（否则左栏说"已选 1 个"、右栏说"请选择一个"）', () => {
  /**
   * 2026-10-16 独立复核发现：harness 一直在替容器清选中，而容器的 `loadMatters` 从不清理 ——
   * 绿的其实是脚手架。规则现在落在 `retainSelectedMatterId` 这个纯函数里（两个分支都能测），
   * 容器与 harness 都调它。为什么必须清：左栏读 id（写「案卷 3 个（已选 1 个）」）、
   * 右栏读对象（查不到就是占位），留着失效 id 会让两块同时说反话。
   */
  const list = [matter(), matter({ id: 'm2' })]
  assert.equal(retainSelectedMatterId('m2', list), 'm2', '列表里还有就必须留着 —— 每次重拉都清空会把用户的选中弄丢')
  assert.equal(retainSelectedMatterId('m9', list), null, '列表里已经没有了要清成 null')
  assert.equal(retainSelectedMatterId(null, list), null, '本来没选中就别凭空选一个')
  assert.match(clientSource, /retainSelectedMatterId\(prev,/, '容器必须真的调用它（纯函数没人调 = 死代码）')
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

const boardProps = (over = {}) => ({
  days: 7, todayKey: '2026-10-03', engineAvailable: true, onRecomputeAll: () => {}, onOpenMatter: () => {}, busy: false,
  ...over,
})

test('SSR：今日期限看板 —— 引擎缺失时明确说明降级，空看板必须能自证原因', () => {
  const degraded = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    deadlines: [], ...boardProps({ engineAvailable: false }),
  }))
  assert.match(degraded, /data-deadline-degraded/, '引擎不可用时必须有一段说明')
  assert.match(degraded, /未探测到期限引擎/)
  assert.match(degraded, /明确降级/)
  assert.match(degraded, /法定期限 · 近 7 天/)
  assert.match(degraded, /含已过期/)
  // 引擎不可用时重算按钮要**禁用**（不给用户点一个必然 409 的按钮）
  assert.match(buttonTag(degraded, 'data-deadline-recompute'), /disabled/, '引擎不可用时重算按钮要禁用')

  const empty = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    deadlines: [], ...boardProps(),
  }))
  assert.doesNotMatch(empty, /data-deadline-degraded/)
  assert.match(empty, /近 7 天内没有待办期限/)
})

test('SSR：期限看板按已过期 → 今日届满 → 其余折叠；过期只信服务端 overdue', () => {
  const html = renderToStaticMarkup(createElement(UpcomingDeadlines, {
    ...boardProps(),
    deadlines: [
      { id: 'a', matterId: 'm1', caseNumber: '2026-UM-002', matterTitle: '某装置', label: '答复一通', dueDate: '2026-09-28', status: 'pending', overdue: true },
      // 届满日等于面板日键，但服务端说已过期：仍只进「已过期」，不许客户端改判成今日届满
      { id: 'c', matterId: 'm3', caseNumber: '2026-UM-009', matterTitle: '某电路', label: '补正', dueDate: '2026-10-03', status: 'pending', overdue: true },
      { id: 'd', matterId: 'm4', caseNumber: '2026-INV-003', matterTitle: '某结构', label: '今日答复', dueDate: '2026-10-03', status: 'pending', overdue: false },
      { id: 'b', matterId: 'm2', caseNumber: '2026-INV-001', matterTitle: '某方法', label: '缴年费', dueDate: '2026-10-02', status: 'pending', overdue: false },
    ],
  }))
  assert.match(html, /2026-UM-002/)
  assert.match(html, /答复一通/)
  assert.match(html, /某装置/)
  assert.match(html, /已过期/)
  assert.match(html, /今日届满/)
  assert.match(html, /今日答复/)
  assert.match(html, /data-matter-id="m4"/)
  // 其余默认不进 DOM
  assert.doesNotMatch(html, /缴年费/)
  assert.doesNotMatch(html, /2026-INV-001/)
  assert.match(html, /另有 1 条未展开/)
  assert.doesNotMatch(html, /data-deadline-group="rest"/)
  const overdueAt = html.indexOf('data-deadline-group="overdue"')
  const todayAt = html.indexOf('data-deadline-group="due-today"')
  const moreAt = html.indexOf('data-deadline-more')
  assert.ok(overdueAt >= 0 && todayAt > overdueAt && moreAt > todayAt, '组顺序必须是已过期 → 今日届满 → 折叠其余')
  // 只有服务端 overdue 的两条带 overdue 样式（今日届满那条届满日相同，但 overdue=false）
  assert.equal((html.match(/wb-dl-row overdue/g) ?? []).length, 2)
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
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')
  for (const file of [
    'src/client/index.tsx',
    'src/client/deadlineBoard.ts',
    'src/client/components/MattersView.tsx',
    'src/client/components/views/TodayView.tsx',
  ]) {
    assert.doesNotMatch(stripComments(read(file)), /dueDate\s*<\s*/, `${file} 不许自己比日期判过期`)
  }
  // 容器里的 `localDateString(new Date())` 是日期面板既有日键，不在这条禁令里。
  // 看板与今日视图不许再取一次时钟。
  for (const file of [
    'src/client/deadlineBoard.ts',
    'src/client/components/MattersView.tsx',
    'src/client/components/views/TodayView.tsx',
  ]) {
    assert.doesNotMatch(stripComments(read(file)), /new Date\s*\(/, `${file} 不许另取本地时钟重算过期或今日`)
  }
  assert.match(read('src/client/deadlineBoard.ts'), /deadline\.overdue/, '已过期只读服务端字段')
  assert.match(read('src/client/deadlineBoard.ts'), /dueDate === todayKey/, '今日届满只跟传入日键比相等')
  assert.match(read('src/client/components/views/TodayView.tsx'), /todayKey=\{dayPanelProps\.day\}/, '日键必须来自日期面板')
  assert.match(read('src/client/components/views/TodayView.tsx'), /onTabChange\('overdue'\)/, '点「任务逾期」切日期面板逾期页签')
  assert.match(read('src/client/components/views/TodayView.tsx'), /onTabChange\('plan'\)/, '点「今日到期」回到计划页签（今日到期任务的落点）')
  assert.match(clientSource, /onOpenMatter=\{\(matterId\) => \{ setSelectedMatterId\(matterId\); setView\('matters'\) \}\}/, '点期限行打开案卷详情')
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
  const uiSources = ['src/client/index.tsx', 'src/client/components/MattersView.tsx', 'src/client/components/views/MatterPane.tsx', 'src/client/matterTimeline.ts',
    /**
     * 2026-10-16：案卷详情拆去右栏，`MatterDetailPane.tsx` 渲染的同样是用户可见文案
     *（占位那句 + 转发给 `MatterDetail` 的部分），扫描范围跟着扩（迁移而不是缩小覆盖面）。
     */
    'src/client/components/views/MatterDetailPane.tsx',
    /**
     * H4-8：建档 / 官文登记表单搬去了 `components/dialogs/` —— 它们渲染的同样是用户可见文案，
     * 扫描范围跟着扩（plan §5.4：迁移而不是缩小覆盖面）。
     */
    'src/client/components/dialogs/MatterDraftModal.tsx', 'src/client/components/dialogs/NoticeDraftModal.tsx',
    /**
     * 方案 A：导入完成脚注曾经写成「案件」。弹窗同样是用户可见文案，扫描范围必须带上，
     * 否则这句会再次漏出术语扫描。
     */
    'src/client/components/dialogs/MatterImportModal.tsx',
    // H4-8（第 4 批）：「待你处理」弹窗同批搬出，它也是用户可见文案的落点。
    'src/client/components/dialogs/PendingModal.tsx']
  for (const file of uiSources) {
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.doesNotMatch(stripped, /案件/, `${file} 的用户可见文案里还有「案件」`)
  }
  assert.match(read('src/api/routes/matters.ts'), /案卷事件/, '路由注释的术语同步')
  // H4-8：这个字段标签随表单搬进了 MatterDraftModal（判据随落点迁移）。
  assert.match(read('src/client/components/dialogs/MatterDraftModal.tsx'), /案卷目录/, '工作目录仍叫「案卷目录」（那是目录，不是实体）')
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

// ---------------------------------------------------------------------------
// 方案 A：列表搜筛（内存过滤，不重排）+ 详情抬头固定 / 四区可折
// ---------------------------------------------------------------------------

test('方案 A：未筛时列表顺序与入参一致；关键字只匹配案号/名称；阶段是与关系', () => {
  const rows = [
    matter({ id: 'm1', caseNumber: 'B-2', title: '后更新但排在前', stageCode: 'open', updatedAt: '2026-01-01T00:00:00.000Z' }),
    matter({ id: 'm2', caseNumber: 'A-1', title: '兽用设备', stageCode: 'drafting', updatedAt: '2026-09-01T00:00:00.000Z', applicationNo: 'CN999' }),
    matter({ id: 'm3', caseNumber: 'C-9', title: '无关名称', stageCode: 'open', updatedAt: '2026-08-01T00:00:00.000Z' }),
  ]
  assert.equal(filterMatters(rows, '', ''), rows, '未筛必须原样返回（不复制、不重排）')
  assert.equal(filterMatters(rows, '   ', ''), rows, '空白关键字不算筛')
  assert.equal(isMatterFilterActive('  ', ''), false)
  assert.equal(isMatterFilterActive('a', ''), true)
  assert.equal(isMatterFilterActive('', 'open'), true)
  assert.deepEqual(filterMatters(rows, '兽用', '').map((item) => item.id), ['m2'])
  assert.deepEqual(filterMatters(rows, 'b-2', '').map((item) => item.id), ['m1'], '案号大小写不敏感')
  assert.deepEqual(filterMatters(rows, 'CN999', '').map((item) => item.id), [], '不匹配申请号')
  assert.deepEqual(filterMatters(rows, '', 'open').map((item) => item.id), ['m1', 'm3'], '阶段筛保持原顺序')
  assert.deepEqual(filterMatters(rows, '无关', 'drafting').map((item) => item.id), [], '关键字与阶段同时不满足则排除')
  assert.deepEqual(filterMatters(rows, '无关', 'open').map((item) => item.id), ['m3'])
})

test('方案 A：计数文案 —— 未筛仍是「案卷 N 个」，有筛才加「已筛 M」', () => {
  assert.equal(matterListCountLabel(3, 3, false, false), '案卷 3 个')
  assert.equal(matterListCountLabel(3, 3, false, true), '案卷 3 个（已选 1 个）')
  assert.equal(matterListCountLabel(3, 1, true, false), '案卷 3 个 · 已筛 1')
  assert.equal(matterListCountLabel(3, 0, true, true), '案卷 3 个 · 已筛 0（已选 1 个）')
  assert.deepEqual(
    matterStageOptions([
      { kind: 'matter_type', code: 'drafting', name: '申请撰写', config: {} },
      { kind: 'matter_stage', code: 'grant', name: '授权', config: {} },
      { kind: 'matter_stage', code: 'open', name: '', config: {} },
    ]),
    [{ code: 'grant', name: '授权' }, { code: 'open', name: 'open' }],
    '阶段选项只取 matter_stage，顺序跟字典，空名字回落到码',
  )
})

test('SSR：无命中是另一句空态，空库仍是「还没有案卷」', () => {
  const missed = renderToStaticMarkup(createElement(MatterList, {
    matters: [], dicts: DICTS, selectedId: null, onOpen: () => {}, noMatch: true,
  }))
  assert.match(missed, /data-matter-filter-empty/)
  assert.match(missed, /没有匹配的案卷。试试清空筛选。/)
  assert.doesNotMatch(missed, /还没有案卷/)

  const library = renderToStaticMarkup(createElement(MatterList, {
    matters: [], dicts: DICTS, selectedId: null, onOpen: () => {},
  }))
  assert.match(library, /data-matter-empty/)
  assert.match(library, /还没有案卷/)
  assert.doesNotMatch(library, /没有匹配的案卷/)
})

test('SSR：案卷左栏默认可见搜索框与阶段「全部」，未筛时行顺序不动', () => {
  const html = renderToStaticMarkup(createElement(MatterPane, {
    matters: [
      matter({ id: 'm1', caseNumber: '2026-UM-002', title: '一种兽用中药智能熬制设备' }),
      matter({ id: 'm2', caseNumber: '2026-INV-001', title: '另一件', stageCode: 'drafting' }),
    ],
    dicts: [
      ...DICTS,
      { kind: 'matter_stage', code: 'drafting', name: '撰写中', config: {} },
    ],
    selectedMatterId: null, busy: false, onOpen: () => {}, onCreate: () => {}, onImport: () => {}, onRefresh: () => {},
  }))
  assert.match(html, /data-matter-search/)
  assert.match(html, /placeholder="搜索案号或名称"/)
  assert.match(html, /aria-label="阶段"/)
  assert.match(html, /<option value=""[^>]*>全部<\/option>/)
  assert.ok(html.indexOf('value="open"') < html.indexOf('value="drafting"'), '阶段选项按字典顺序')
  assert.match(html, /案卷 2 个/)
  assert.doesNotMatch(html, /已筛/)
  assert.doesNotMatch(html, /清空筛选/, '没在筛时不放清空按钮')
  assert.ok(html.indexOf('2026-UM-002') < html.indexOf('2026-INV-001'), '未筛时行顺序与入参一致')
  assert.match(html, /data-matter-refresh/)
  assert.match(html, /data-matter-import/)
  assert.match(html, /data-matter-create/)
})

test('方案 A：搜筛与折叠留在 pane / 详情，不回流 index，也不进今日', () => {
  assert.match(paneSource, /filterMatters\(/)
  assert.match(paneSource, /<MatterList\b/)
  assert.match(viewSource, /data-matter-fold/)
  assert.match(viewSource, /hidden=\{!open\}/, '折合只隐藏，不把子树从渲染里拿掉')
  assert.doesNotMatch(clientSource, /data-matter-search|data-matter-fold|sectionOpen/, '容器不持有搜筛或折叠')
  assert.doesNotMatch(read('src/client/components/views/TodayView.tsx'), /data-matter-search|data-matter-fold/)
  assert.match(read('src/client/components/dialogs/MatterImportModal.tsx'), /已出现在「案卷」列表里/)
})

test('方案 A：四区开合 —— 默认全展开；切卷重置；从 0 变有内容时展开；折合不改另一区', () => {
  const empty = { notices: 0, deadlines: 0, timeline: 0 }
  const base = createMatterSectionState('m1', empty)
  assert.deepEqual(base.open, { fields: true, notices: true, deadlines: true, timeline: true })
  assert.equal(reconcileMatterSectionState(base, 'm1', empty), base, '计数没变就保持同一状态')
  const collapsed = toggleMatterSection(base, 'notices')
  assert.equal(base.open.notices, true, '切换不可就地改原状态')
  assert.equal(collapsed.open.notices, false)
  assert.equal(collapsed.open.deadlines, true)
  const gained = reconcileMatterSectionState(collapsed, 'm1', { notices: 1, deadlines: 0, timeline: 0 })
  assert.equal(gained.open.notices, true, '这一区从空变成有内容时展开，免得登记完看不见')
  const withRows = createMatterSectionState('m1', { notices: 1, deadlines: 2, timeline: 3 })
  const closedDeadline = toggleMatterSection(withRows, 'deadlines')
  const grew = reconcileMatterSectionState(closedDeadline, 'm1', { notices: 1, deadlines: 3, timeline: 3 })
  assert.equal(grew.open.deadlines, false, '本来就有内容时再增减，不打断用户折上的那一区')
  const switched = reconcileMatterSectionState(closedDeadline, 'm2', { notices: 1, deadlines: 2, timeline: 3 })
  assert.equal(switched.matterId, 'm2')
  assert.equal(switched.open.deadlines, true, '换一卷重置为展开')
  assert.equal(switched.open.fields, true)
})

test('SSR：折合后官文与期限仍在标记里，再按展开标志能对上同一批内容', () => {
  const notices = [{ id: 'n1', noticeKind: 'office_action_first', dispatchDate: '2026-10-05', deliveryMode: 'electronic', deliveryDate: null, designatedMonths: 4, fileLink: null, note: null }]
  const deadlines = [deadlineRow()]
  const shared = {
    matter: matter(), dicts: DICTS, timeline: timeline(), notices, deadlines,
    engineAvailable: true, recomputeNote: '重算完成：1 条', onSyncEvents: () => {}, syncNote: '',
    onEdit: () => {}, onAddNotice: () => {}, onDeleteNotice: () => {}, onRecompute: () => {}, onSetDeadlineStatus: () => {}, busy: false,
  }
  const openHtml = renderToStaticMarkup(createElement(MatterDetail, shared))
  const closedHtml = renderToStaticMarkup(createElement(MatterDetail, {
    ...shared,
    sectionOpen: { notices: false, deadlines: false, timeline: false },
  }))
  for (const html of [openHtml, closedHtml]) {
    assert.match(html, /第一次审查意见通知书/)
    assert.match(html, /届满 2026-10-20/)
    assert.match(html, /签了委托书/)
    assert.match(html, /标记完成/)
    assert.match(html, /免除/)
    assert.match(html, /data-matter-add-notice/)
    assert.match(html, /data-matter-recompute/)
    assert.match(html, /data-matter-sync-events/)
    assert.match(html, /data-matter-sticky/)
    assert.match(html, /data-matter-edit/)
  }
  assert.match(closedHtml, /id="wb-matter-section-notices"[^>]*hidden=""/)
  assert.match(closedHtml, /id="wb-matter-section-deadlines"[^>]*hidden=""/)
  assert.match(closedHtml, /id="wb-matter-section-timeline"[^>]*hidden=""/)
  assert.doesNotMatch(closedHtml, /id="wb-matter-section-fields"[^>]*hidden=""/, '字段区这次没折')
  assert.match(openHtml, /data-matter-section="notices"[^>]*data-matter-open="1"/)
  assert.match(closedHtml, /data-matter-section="notices"[^>]*data-matter-open="0"/)
  assert.doesNotMatch(closedHtml, /完成度|任务列表|任务闭环/)
})
