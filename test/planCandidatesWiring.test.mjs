/**
 * 接线不变量（源码级扫描）—— T2/D09、AX-C06、AX-G02。
 *
 * 本项目最大的 bug 类别是"同一个语义被独立计算多次"：本次改造把「当日候选」
 * 收进 `src/shared/dailyPlanPolicy.ts`，而它有两个消费点（AI 排序 / 手动池）。
 * **"不存在第二处实现"只能用扫描证明**，所以这里逐条钉住：
 *
 * 1. 候选判定只有 `planCandidates` 一份实现；
 * 2. `index.tsx` 不再内联"今天到期/doing/无截止"那套 filter，也不再 `.slice(0, 30)`；
 * 3. 30 条上限只有 `selectPromptCandidates` 一份，且 `dailyPlanPrompt.ts` 不自己 slice；
 * 4. `client/dailyPlanCandidates.ts` 是薄接线：不求和、不判 open、不内联默认耗时。
 *
 * 绝不断言行号（本项目明确禁止脆行号断言），只按符号与调用点断言。
 *
 * 历史：上一版叫 `capacityWiring.test.mjs`，还额外钉住"容量账本组件只吃 props"等条。
 * 容量功能已按决策 4 删除（2026-10-03），候选判定本身完整保留，故本文件随之改名收窄。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_ESTIMATE_MINUTES, DEFAULT_ESTIMATE_MINUTES } from '../lib/client/dailyPlanCandidates.js'

/**
 * ⚠️ 行尾归一化：Windows 检出是 CRLF，而下面所有片段/正则是按 `\n` 写的。
 * 不归一化就会出现"片段明明在源码里、`includes` 却说不存在"的假红。
 */
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const indexSource = read('src/client/index.tsx')
const candidatesSource = read('src/client/dailyPlanCandidates.ts')
const policySource = read('src/shared/dailyPlanPolicy.ts')
const promptSource = read('src/client/dailyPlanPrompt.ts')
const planPanelSource = read('src/client/components/PlanPanel.tsx')

/** 去掉注释：避免"注释里提到某个写法"被当成代码里的实现/第二处实现。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 唯一实现
// ---------------------------------------------------------------------------

test('AX-G02 候选判定只有一份实现：dailyPlanPolicy.ts 导出，client 只是接线', () => {
  assert.match(policySource, /export function planCandidates\(/, '权威实现必须在共享模块里')
  assert.equal((policySource.match(/export function planCandidates\(/g) ?? []).length, 1)
  // 客户端不许再定义自己的候选函数
  assert.doesNotMatch(candidatesSource, /export function planCandidates\(/)
  assert.doesNotMatch(indexSource, /function planCandidates\(/)
})

test('AX-G02 index.tsx 不再内联"今天到期/doing/无截止"那套候选 filter', () => {
  const code = stripComments(indexSource)
  // 旧实现的特征：按 effectiveDueAt 与 planDayEnd 比较、以及"今天且无截止"这条腿
  assert.doesNotMatch(code, /planDayEnd\.getTime\(\)/, '不许再内联按截止过滤的候选公式')
  assert.doesNotMatch(code, /planCandidates\b(?!Info|For)/, '不许再内联名为 planCandidates 的过滤结果')
  assert.match(code, /todayPlanCandidates\(/, '候选必须走共享函数（经 client/dailyPlanCandidates.ts 接线）')
})

test('AX-C02 30 条上限只有一份：selectPromptCandidates；调用点不许自己 slice', () => {
  assert.match(policySource, /export function selectPromptCandidates\(/)
  // 共享模块里除"定义"外**只允许**在 planCandidates 附近出现；客户端不许再实现一遍
  assert.doesNotMatch(stripComments(candidatesSource), /selectPromptCandidates/)
  assert.match(promptSource, /selectPromptCandidates\(/, '提示词模块必须复用共享的截断口径')
  assert.doesNotMatch(stripComments(promptSource), /\.slice\(0, *30\)/, '提示词模块不许自己截断')
  assert.doesNotMatch(stripComments(candidatesSource), /slice\(0, *30\)/, '候选接线不许截断候选')
  assert.doesNotMatch(stripComments(indexSource), /slice\(0, *30\)/, 'index.tsx 不许再静默截断候选')
  assert.equal((stripComments(policySource).match(/\.slice\(0, safeLimit\)/g) ?? []).length, 1, '截断只许有一处')
})

test('AX-C02 截断提示必须同时出现在提示词与发起窗口（不宣称全量）', () => {
  // 唯一的提示文案在共享模块里（"另有 N 条未列出"），提示词模块只负责把它贴进 prompt
  assert.match(policySource, /另有 \$\{omitted\} 条未列出/)
  assert.match(promptSource, /\$\{notice\} —— 未列出的条目/)
  assert.match(promptSource, /不要声称已对全量做排序/)
  /**
   * ⚠️ 2026-10-01 更新（批次2 D15）：发起窗口的提示从 `index.tsx` 的两处内联
   *（todayPromptInfo / pickedPromptInfo）经**数据层** `dayPanelModel.ts` 送进
   * 日期面板组件 `DayPanel.tsx`。判据跟着实现走、**不是放宽**：
   * 要求的仍然是"截断时界面必须说出来"，所以三段链路都要在 ——
   * index.tsx 把两个视图的提示都交给模型、模型按当前视图选一个、面板把它显示出来。
   */
  assert.match(indexSource, /todayPromptInfo,\n\s+pickedPromptInfo,/, 'index.tsx 必须把两个视图的截断信息都交给数据层')
  const model = readFileSync(new URL('../src/client/dayPanelModel.ts', import.meta.url), 'utf8')
  assert.match(model, /const promptInfo = isTodayView \? todayPromptInfo : pickedPromptInfo/,
    '数据层必须按当前视图给出对应的截断信息（两处各判一遍就是"同一语义两处实现"）')
  const dayPanel = readFileSync(new URL('../src/client/components/DayPanel.tsx', import.meta.url), 'utf8')
  assert.match(dayPanel, /promptInfo\.truncated/, '日期面板必须在截断时显示提示（不宣称全量）')
  assert.match(dayPanel, /role="status"/, '提示要带 role=status（无障碍与判据都要）')
})

test('AX-C06 客户端候选接线是薄的：不求和、不判 open、不内联默认耗时', () => {
  const code = stripComments(candidatesSource)
  assert.doesNotMatch(code, /if \(task\.archived === true\) continue/, '归档过滤必须在共享函数里')
  assert.doesNotMatch(code, /statusCode === 'done'/, 'open 判定必须复用共享函数')
  assert.doesNotMatch(code, /estimatedMinutes \?\? 30/, '默认投入取值必须在共享函数里')
  assert.doesNotMatch(code, /\breduce\(/, '候选接线不许自己求和')
  assert.match(code, /planCandidates\(/, '唯一实现是共享模块的 planCandidates')
})

test('AX-C06 手动池（PlanPanel）不再内联候选过滤，吃父级喂的 candidateTasks', () => {
  const code = stripComments(planPanelSource)
  assert.match(code, /candidateTasks/, '手动池候选必须由父级用共享函数算好传进来')
  assert.doesNotMatch(code, /statusCode !== 'done' && t\.statusCode !== 'cancelled'/, '不许再内联 open 过滤')
  assert.doesNotMatch(code, /effectiveDueAt/, '不许再自己判到期')
})

test('AX-C06 各调用点都指向同一份候选：AI 排序 / 今日手动池 / 选中日手动池', () => {
  const code = stripComments(indexSource)
  // 今日手动池候选
  assert.match(code, /todayPlanCandidateRows/)
  assert.match(code, /pickedPlanCandidateRows/)
  // AI 排序提示词
  assert.match(code, /buildPlanPrompt\(/)
  /**
   * 三个入口不只"共用同一个函数"，而是**共用同一个调用点** `planCandidatesFor`。
   *
   * 2026-10-03 把提示词侧与两个手动池侧的三处逐字相同的调用收敛成一处
   * （`todayPlanCandidates` 的入参原先被抄了三遍）。这比原先的"计数 === 3"更强：
   * 现在连"再抄一遍参数"的余地都没有 —— 口径改动只可能落在 `planCandidatesFor`。
   */
  assert.equal((code.match(/todayPlanCandidates\(/g) ?? []).length, 1,
    '候选函数在 index.tsx 只允许一个调用点（planCandidatesFor）')
  assert.equal((code.match(/const planCandidatesFor = /g) ?? []).length, 1, 'planCandidatesFor 只允许定义一处')
  for (const consumer of ['candidateRowsFor(todayPlan)', 'candidateRowsFor(pickedPlan)']) {
    assert.ok(code.includes(consumer), `手动池必须吃共享调用点：${consumer}`)
  }
})

// ---------------------------------------------------------------------------
// 口径不变量
// ---------------------------------------------------------------------------

test('一分钟口径只有一处：DEFAULT / MAX 与共享模块同值', () => {
  assert.equal(DEFAULT_ESTIMATE_MINUTES, 30)
  assert.equal(MAX_ESTIMATE_MINUTES, 1440)
  assert.match(policySource, /export const DEFAULT_PLAN_MINUTES = 30/)
  assert.match(policySource, /export const MAX_PLAN_MINUTES = 1440/)
  assert.match(candidatesSource, /DEFAULT_ESTIMATE_MINUTES = DEFAULT_PLAN_MINUTES/)
})

/**
 * 编辑耗时的四个**接线点**：保存 payload / 编辑框初值 / 就地校验 / 乐观更新。
 *
 * 为什么要源码扫描而不是行为测试（2026-10-02 补，来自变异探针的反向验证）：
 * 这四处都在 `index.tsx` 的事件处理器里，而 `react-dom/server` 渲染不到交互 ——
 * 变异探针把任一处装回缺陷版时，纯函数测试与组件渲染测试**全都是绿的**
 *（实测 I2/I3/I4/I5 四条变异集体存活）。项目纪律：能搬进纯模块的就搬；
 * 搬不动的（宿主交互接线）用源码扫描钉住，并用探针反向验证"装回缺陷必须变红"。
 */
test('AX-C07 编辑耗时的四个接线点都在（保存 payload / 编辑框初值 / 就地校验 / 乐观更新）', () => {
  const code = stripComments(indexSource)
  assert.match(code, /estimatedMinutes,\n\s+allDay: editDraft\.allDay,/,
    '保存 payload 必须带上 estimatedMinutes —— 否则"编辑耗时"保存不进去（静默丢字段）')
  /**
   * ⚠️ H4-3 起这条**迁移过**：编辑框初值原来内联在详情页那一行的 onClick 里，现在收进了
   * 容器的 `beginEditTask()`（任务详情搬去了 `components/views/TaskDetailPane.tsx`，
   * 而"摊草稿"是写入口，按 H4 plan §3 留在容器）。判据的**意图不变**：初值必须来自
   * 库里那个任务的真实 `estimatedMinutes`，不许写死空串。所以用反向引用匹配
   * `X.estimatedMinutes`（两侧同一标识符），不再绑定具体变量名。
   */
  assert.match(code, /estimatedMinutes: (\w+)\.estimatedMinutes === null \? '' : String\(\1\.estimatedMinutes\)/,
    '编辑框初值必须来自库里真实值 —— 写死空串等于打开编辑框看不见真实值')
  assert.match(code, /estimated !== null && \(!Number\.isFinite\(estimated\) \|\| estimated < 1 \|\| estimated > MAX_ESTIMATE_MINUTES\)/,
    '客户端必须就地校验非法耗时 —— 否则只能靠服务端 400 猜')
  assert.match(code, /\{ \.\.\.task, estimatedMinutes, allDay: editDraft\.allDay \}/,
    '乐观更新必须把新耗时写回列表 —— 否则要刷新页面才看到变化')
})
