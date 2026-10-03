# H4 拆分清单（逐步勾选）

> 规则见 `plan.md` §3（state 归属）与 §5（每步验证协议）。**一步一改，改动范围各自独立、可单独回退**
>（提交节奏由会话决定，本清单只记录"改到哪一步、证据是什么"）。

## H4-1 日历视图 ✅ 完成（2026-10-03）

- [x] 新增 `src/client/calendarView.ts`：周/月格子与翻页落点收成**纯函数**
      （`weekDaysOf` / `monthGridOf` / `shiftCalendarDate` / `calendarTodayDate`），
      两个 state（游标、周月模式）收进 `useCalendarView(now)` —— **由容器调用**，
      视图卸载不重置（plan §3 那条规则）。
- [x] 新增 `src/client/components/CalendarView.tsx`：日历 JSX（导航 + 周网格 + 月网格 + 同一个
      `DayPanel` 实例）搬出 `WorkbenchApp`；props 只有 5 个
      （`now` / `picked` / `onPickDay` / `cal` / `dayPanelProps`）。
- [x] `index.tsx`：删掉 `cursor` / `calMode` 两个 `useState`、4 段内联派生，
      改为 `const cal = useCalendarView(now)` 一行 + `<CalendarView … />`；
      顺手去掉 3 个因此不再使用的导入（`isTaskDueOnDay` / `sameDay` / `startOfWeek`）。
- [x] 测试：新增 `test/calendarView.test.mjs`（7 条纯函数断言，期望值全部手写）。
- [x] 真浏览器验证：新增 `scripts/verify/harness/calendarHarness.tsx` +
      `scripts/verify/harness/tsdown.config.mjs`（现打包 IIFE，不入库构建）+
      `scripts/repro/verify-h4-calendar.mjs`（CDP 驱动，21 条交互断言）。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `pnpm test` | 1033 用例 / 1031 通过 / 0 失败 / 2 跳过（新增 7 条日历纯函数断言） |
| `node scripts/repro/verify-h4-calendar.mjs` | 21 条断言全绿，截图 `_local-build/h4/h4-1-calendar.png` |
| `src/client/index.tsx` | 5512 → **5458** 行 |
| `WorkbenchApp` 内 `useState` | **−2**（`cursor` / `calMode`）。绝对数按 plan §1 那条命令量：108 → 106 |
| 受影响的源码扫描测试 | **0**（日历视图此前无任何测试耦合） |

真浏览器断言覆盖：周视图 7 格与周一制周首、`today`/`selected` 高亮落在正确格子、
已取消任务不计入当日标记、`dayPanelProps.day` 透传到面板、空态「AI 智能排序」走到
`onSort`、点格选中回调收到当天 00:00、周↔月切换、▶/◀ 翻页落点、「今天」
（月视图落**今天所在的月**）、**切页签再切回模式不丢**、无页面异常。

> 过程中红过一次：我自己把月视图「今天」的期望写成"游标原来的月份"（2026年9月），
> 实际语义是"今天所在的月"（2026年10月）—— 与拆分前那行内联表达式一致。
> 红的是**断言**，不是组件（已在驱动脚本里注明）。

## H4-2 今日视图 ✅ 完成（2026-10-03）

- [x] 新增 `src/client/components/views/TodayView.tsx`：统计卡 + 期限看板 + 日期面板
      today 实例三块搬出 `WorkbenchApp`；props 9 个
      （`stats` / `deadlines` / `upcomingDays` / `engineAvailable` / `onRecomputeAll` /
      `busy` / `dayPanelProps` / `onQuickEntry` / `onNewTask`）。
      **本组件 0 个 `useState`** —— 今日视图本来就没有自有状态，所以"切页签会不会丢"这个问题在它身上不存在。
- [x] `index.tsx`：原来的 47 行块换成 `<TodayView … />`；「重算全部」的逐案卷循环**留在容器**
      （它依赖 `matters` 与重算函数，是装配而不是画法）。
- [x] `DayPanel` 在 `index.tsx` 里只剩**类型**用途（`DayPanelProps` 没直接用、`DayTab` 还在），
      所以那一行导入改成 `import type { DayTab }`。
- [x] 复核测试耦合（原计划里的风险点）：`matterView.test.mjs` 的两条相关断言
      （`matter-deadlines/upcoming?days=`、`bootstrap?.deadlineEngineAvailable === true`）
      分别落在**逻辑段**（`loadUpcomingDeadlines`）与**案卷视图**里，都不在这次搬动范围内 → **0 条需迁移**。
- [x] 真浏览器验证：新增 `scripts/verify/harness/todayHarness.tsx` + `scripts/repro/verify-h4-today.mjs`
      （24 条交互断言），`tsdown.config.mjs` 改成两个入口（calendar / today）。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.build.json` | 干净 |
| 脚手架类型检查（plan §5.1 那条命令，两个 harness 一起） | 干净（**补上了 H4-1 漏掉的这一步**） |
| `pnpm test` | 1033 用例 / 1031 通过 / 0 失败 / 2 跳过 |
| `node scripts/repro/verify-h4-today.mjs` | 24 条断言全绿，截图 `_local-build/h4/h4-2-today.png` |
| `node scripts/repro/verify-h4-calendar.mjs` | 仍 21 条全绿（两入口构建配置没破坏 H4-1） |
| `src/client/index.tsx` | 5458 → **5433** 行（本步 −25） |
| `WorkbenchApp` 内 `useState` | **−0**（视图无状态；这是设计，不是遗漏） |
| 受影响的源码扫描测试 | **0** |

真浏览器断言覆盖：四格统计数字与标签、看板两行与「只有 overdue=1 那条带 overdue 样式」、
「已过期」文案、引擎可用时不显示降级说明、点「重算全部」走到容器回调、计划页签用**本视图私有**
空态（不是面板兜底文案）、空态两个按钮分别走到 `onQuickEntry` / `onNewTask`、
`dayPanelProps.day` 透传（非今天时按钮文案带日键）、点「逾期」页签后**树容器真的换成 overdue**、
**切页签再切回仍是逾期**（`dayTab` 挂在容器上）、引擎降级态出现/消失与按钮禁用、
`busy` 时禁用重算、无页面异常。

> 过程中红过一次：「日键透传」那条在**逾期**页签下等 `AI 智能排序（2026-10-03）`，
> 而那一行工具条只在 `activeTab === 'plan'` 时渲染 —— 红的是**我的断言顺序**，不是组件
> （已把这条断言挪到切页签之前，并在脚本里注明原因）。

## H4-3 右栏详情 📌 立项时的原始规划（已被下一节取代，保留备查）

> 这一节是立项时写的设想，**不要**照它判断进度 —— 实际做法（拆成两半、先做任务详情）
> 见下面那节，结论也写进了 `plan.md` §4。

- 目标：`wb-detail`（3535–3934，约 400 行）→ `components/views/DetailPane.tsx`。
- 预计耦合：`progressWiring.test.mjs` 的 `<TaskProgress` 与 `pending={pendingMap}`。
- 注意：详情区读的状态很多（选中任务/知识/案卷 + 一堆回调），props 会长 ——
  但**那是显式的长**，比"读全局"强；若 props 超过 ~30 个，说明该视图的状态需要一起搬。

## H4-3 任务详情 ✅ 完成（2026-10-03）

- [x] 新增 `src/client/components/views/TaskDetailPane.tsx`（456 行）：右栏里"选中一个任务"的
      那一半 —— 任务卡、进度卡、动作行、描述/子任务/会话/记录四个页签。**本组件 0 个 `useState`**。
- [x] **范围与 plan 的偏差（刻意，且已在 plan §4 记录）**：原本写的是"整个 `wb-detail` → `DetailPane.tsx`"。
      实际只搬了**任务**那一半，命名 `TaskDetailPane.tsx`；右栏里知识详情那一支仍留在 `index.tsx`，
      因为 H4-4 的定义就是"左栏 + 右栏知识详情一起搬"——先搬过去再拆出来会是同一次搬动做两遍。
- [x] 视图**不发请求**：编辑/归档/恢复/改状态/存进度/完成任务/建子任务/加提醒/关联会话
      全部改成回调解意图，容器新增 `restoreSelectedTask` / `beginEditTask` / `patchSelectedTask` /
      `saveSelectedProgress` / `completeSelectedFromProgress` / `startDetailAI` / `createSubtask` /
      `openKnowledgeEntry` / `sinkReviewToKnowledge`（动作与原内联写法逐字同义）。
      会话选择器的状态收成一个 `sessionPicker` 子对象（那 4 个 state 里 `query`/`role` 还被容器
      自己的候选过滤与关联复用，不能给视图）。
- [x] 判据迁移（按 plan §5.4，**迁移而不是删除**）：
      `progressWiring.test.mjs` 的"详情接线"一条改为"详情那一处必须存在 + `index.tsx` 不许再有第二处"；
      `planCandidatesWiring.test.mjs` 的"编辑框初值"一条由 `selected.task.X` 改为反向引用
      `(\w+).X`（不绑变量名），并单独验过它对"写死空串"这个缺陷仍然会红。
- [x] 真浏览器验证：新增 `scripts/verify/harness/taskDetailHarness.tsx` +
      `scripts/repro/verify-h4-task-detail.mjs`（**55 条交互断言**），`tsdown.config.mjs` 加第 3 个入口。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.build.json` | 干净 |
| 脚手架类型检查（plan §5.1 那条命令，3 个 harness 一起） | 干净 |
| `pnpm test` | 1033 用例 / 1031 通过 / 0 失败 / 2 跳过（含 2 条迁移后的扫描） |
| `node scripts/repro/verify-h4-task-detail.mjs` | **55 条断言全绿**，截图 `_local-build/h4/h4-3-task-detail.png` |
| `node scripts/repro/verify-h4-calendar.mjs` / `verify-h4-today.mjs` | 21 / 24 条仍全绿（三个 harness 并行不冲突） |
| `src/client/index.tsx` | 5433 → **5251** 行（本步 −182） |
| `WorkbenchApp` 内 `useState` | **−0**（详情十几个 UI state 一个都没搬，理由见文件头） |
| 产物落盘 | `lib/client/components/views/TaskDetailPane.js` 已生成，`lib/client.js` 里能搜到搬走的文案 |
| 「纯搬家」的机械证据 | 取旧块与新组件的**中文文案集合**做差集：旧块 48 条一条都没丢 —— 差异只有 4 条，其中 2 条是变量改名（`selected.task.X` → `task.X`）、2 条是刻意搬去容器的通知文案（`任务已恢复` / `复盘：…`）；反向差集 10 条全在注释里，界面文案零新增 |

真浏览器断言覆盖：任务卡三段信息（含"默认 25 分钟""AI 工作区回落"）、进度档位 → `onSaveProgress(50)`、
编辑 / 归档 / AI 执行（禁用→开启可执行后放行）/ AI 协助 / AI 拆解、状态与 AI 策略下拉 → `onPatch`、
复盘入口两种文案（有/无复盘会话）→ `onStartAI('review')`、子任务页签 + 新建表单
（`onCreateSubtask` 收到 `{title, typeCode, priorityCode, dueAt:null}`，创建后表单收起、取消不发请求）、
点行 → `onOpenTask(整个任务)`、会话页签（可用会话 `onOpenSession`；已被归档/删除的会话只给提示不裸切）、
「添加已有对话」选择器（候选/已关联禁用/搜索/角色/`onLink`/取消清空）、记录页签（四种提醒终态、
`重新武装` 只在终态行出现 → `onResetReminder`、"提前30分" → `onAddReminder(30)`）、
复盘沉淀两种态（`onSinkReview` 带 reviewId 与摘要原文 / `onOpenKnowledge` 带整条）、
变更历史默认 5 条 → 展开 7 条 + 日期分组、归档态只留「恢复任务」→ `onRestore`、
编辑态让位（动作行与页签都不渲染）、未选中画占位、无页面异常。

> 过程中红了四次，**四次都是我的断言写错**，不是组件：①把"已完成任务仍可编辑/归档"写成"终态只读"
> （真判据是 `!archived`，与状态无关）；②`onOpenTask` / `onOpenKnowledge` 传的是**整个对象**而不是 id；
> ③`.wb-card` 选择器也命中任务卡与进度卡（卡数不是 3）；④两个沉淀按钮带 emoji 前缀，
> `startsWith('沉淀为经验')` 匹配不到。脚本里已逐条注明。

> ⚠️ **未覆盖**：容器新增的 `startDetailAI` 里，"已有复盘会话且仍可用 → 复用，否则新建"这一支
> （`aiSessionUsable` 要读宿主快照）**没有新增覆盖** —— 它原先内联在按钮里同样不可达，
> 本次是逐字搬家，覆盖缺口与拆分前一致。

## H4-4 知识视图 ✅ 完成（2026-10-03）

- [x] 左栏 → `src/client/components/views/KnowledgeView.tsx`（85 行）：工具条 + 列表 + 分页 + 空态。
- [x] 右栏 → `src/client/components/views/KnowledgeDetailPane.tsx`（119 行）：草稿表单 / 条目卡 / 占位。
      **两个组件而不是一个**（与 plan 原本写的单个 `KnowledgeView.tsx` 不同）：左栏 `.wb-nav` 与
      右栏 `.wb-detail` 是 `.wb-body` 下的**两个兄弟容器**，一个组件盖不住两块 DOM ——
      硬合成就要改布局与样式，而 H4 的非目标写着"样式一行不动"。
- [x] 筛选状态 + 列表派生 + 落盘/对账两个 effect → `src/client/knowledgeView.ts`（187 行）：
      `useKnowledgeView()` **由容器调用**（照 `calendarView.ts` 的先例，state 仍住在容器实例里 ——
      知识库的 Tab / 排序 / 每页条数是"刷新后保持"的验收项，切页签也不该重置）。
- [x] 顺手把**载荷拼装**搬成纯函数 `buildKnowledgePayload()`（原先是表单 `onSubmit` 里的内联代码，
      `index.tsx` 跑不起来 = 测不到）：标签切分/去空/上限 20、文本 trim、空串归一成 null。
      新增 `test/knowledgeView.test.mjs`（6 条手写期望的断言）。
- [x] 视图**不发请求**：新建/编辑/取消/删除/打开文件/打开关联任务都是回调解意图；容器新增
      `beginNewKnowledge` / `beginEditKnowledge` / `cancelKnowledgeDraft` / `updateKnowledgeDraft` /
      `saveKnowledgeDraft` / `deleteKnowledge` / `openKnowledgeById` / `knowledgeTaskTitle`。
      列表点条目复用 H4-3 已有的 `openKnowledgeEntry`（同一件事不开第二个入口）。
- [x] 判据迁移（plan §5.4，**迁移而不是删除**）：`listViewWiring.test.mjs` 里 6 处落点改指
      `knowledgeView.ts` / `KnowledgeView.tsx`，并各补一条反向断言（`index.tsx` 不许再有第二份筛选状态、
      视图不许自己 `buildListPage`/`toContentItem`）。
- [x] 真浏览器验证：新增 `scripts/verify/harness/knowledgeHarness.tsx` +
      `scripts/repro/verify-h4-knowledge.mjs`（**42 条交互断言**），tsdown 脚手架加第 4 个入口。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.build.json` | 干净 |
| 脚手架类型检查（plan §5.1 那条命令，4 个 harness 一起） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / 0 失败 / 2 跳过（新增 6 条纯函数断言） |
| `node scripts/repro/verify-h4-knowledge.mjs` | **42 条断言全绿**（0 跳过），截图 `_local-build/h4/h4-4-knowledge.png` |
| 另外三个驱动（H4-1/H4-2/H4-3） | 21 / 24 / 55 条仍全绿 |
| `src/client/index.tsx` | 5251 → **5148** 行（本步 −103） |
| `WorkbenchApp` 内 hook 数 | `useState` 106 → **105**、`useMemo` 17 → **16**、`useEffect` 22 → **20**（三个 knowledge 状态/派生/effect 收进 hook） |
| 「纯搬家」的机械证据 | 旧两段知识 JSX 的 14 条中文文案一条没丢（含搬去容器的 `知识条目已创建` 等通知文案） |
| 产物落盘 | `lib/client/components/views/{KnowledgeView,KnowledgeDetailPane}.js` 已生成，`lib/client.js` 里能搜到搬走的文案 |

真浏览器断言覆盖：工具条四件套与命中数、分类 Tab 由字典拼出、首屏 10 行 + 「第 1–10 条 / 共 12 条」、
翻到第 2 页、搜索命中并把页码拨回 0、分类 ∩ 标签（4 → 2 条）、清空筛选、按更新时间（并列保持输入顺序）
→ 切「标题」降序 → 切方向升序、每页 20 一页放完、点条目 → `openEntry(id)` + 行高亮 + 右栏四段内容
（分类徽标/标签、案卷案号、本地文件 chip、关联任务标题、正文）、打开文件、打开关联任务、编辑表单初值
来自库里真值 + 取消、新建表单默认分类 note + 提交载荷逐字比对 + 收起、删除 → `delete(id)` + 回占位、
空态（工具条仍在 + 「新建知识」入口）、**改筛选后刷新页面 Tab/每页条数仍保持**、无页面异常。

> 过程中红了 **9 次**，全部是**我的断言/夹具写错**：①换夹具（ASCII 标题 + `updatedAt` 全并列）后
> 忘了同步旧标题期望；②三处把 `api.evaluate(...)` 的**结果字符串**拼进另一个 `evaluate`
> （`bodyHas('A') + '&&' + bodyHas('B')` 这种）——这是本会话第二次踩，已改用各自 `await` 后比较；
> ③降序首页只有 10 行，我却按"末尾是 A"断言（分页先于排序展示）；④分页器上被禁用的 `›`
> 也带 `data-kb-page="1"`，"没有第 2 页"要按**可点**按钮判；⑤升序页与降序页不是彼此的反转
> （分页与排序的先后是既有语义）。脚本里逐条注明了。

## H4-5 案卷视图 ✅ 完成（2026-10-03）

- [x] 左栏 `view === 'matters'` 块（案卷条 + `MatterList` + `selectedMatter === null ? 提示 : MatterDetail`）
      → `src/client/components/views/MatterPane.tsx`（98 行，**0 个 `useState`**）：props 19 个。
      视图**不发请求**：选中 / 新建 / 编辑 / 登记官文 / 删官文 / 重算期限 / 改期限状态 / 同步事件
      八个入口都是回调解意图，`void` 与落库仍在容器。
- [x] 文件名与 plan 写的 `MattersView.tsx` **不同**（`MatterPane.tsx`）：`components/MattersView.tsx`
      已经占着这个名字（它是列表/详情两个部件，不是视图），而 H4 非目标写着"不重命名既有组件"。
      两个只差一层 `views/` 的同名文件，将来改导入必然拿错 —— 直接叫 `MatterPane`。
- [x] 容器**一个 state 都没搬**（`selectedMatterId` / `selectedMatter` / 三份明细 / 两条回执 / `matterDraft`
      全留）：它们活得比视图久（plan §3），且 `loadMatterDetail` 的 effect 仍在容器里按
      `view === 'matters'` 触发。`matterTimeline` 的 `useMemo` 也留在容器 —— 它是**派生**不是状态，
      搬到视图里会让它在每次挂载时重算一遍，那是行为变化，不是纯搬家。
- [x] ⚠️ 共享面复核（最终结论）：跨视图共享的只有**案卷列表 `matters`** ——
      今日视图「重算全部」的逐案卷循环（H4-2 已留在容器闭包里）与知识表单的「归入案卷」下拉
      （H4-4 已作为 props 传进 `KnowledgeDetailPane`）。两者这次都没碰。
- [x] 判据迁移（plan §5.4，**迁移而不是删除**）：`matterView.test.mjs` 里
      视图装配那一条由"`index.tsx` 自己也挂列表/详情"改为"容器只许挂 `<MatterPane/>` + 部件只许在
      MatterPane 里渲染"，并补两条反向断言；术语扫描（「案件」）的 `uiSources` 加上新文件。
      `matterView` 其余 20 余条扫描（载荷字段名、三个端点、`Promise.all`、`buildMatterTimeline`、
      `labelOf` 兜底）都落在**没搬走**的容器代码上 → 逐条复核后 0 条失效。
- [x] 真浏览器验证：新增 `scripts/verify/harness/mattersHarness.tsx` +
      `scripts/repro/verify-h4-matters.mjs`（**35 条交互断言**），tsdown 脚手架加第 5 个入口。
      脚手架的时间线用**生产函数** `buildMatterTimeline()` 现算（与容器那个 `useMemo` 逐字同构）。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.build.json` | 干净 |
| 脚手架类型检查（plan §5.1 那条命令，5 个 harness 一起） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / 0 失败 / 2 跳过 |
| `node scripts/repro/verify-h4-matters.mjs` | **35 条断言全绿**，截图 `_local-build/h4/h4-5-matters.png` |
| `verify-h4-calendar / today / task-detail / knowledge` | 21 / 24 / 55 / 42 条仍全绿（5 个 harness 并存不冲突） |
| `src/client/index.tsx` | 5148 → **5144** 行（本步 −4） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | 105 / 16 / 20 → **105 / 16 / 20**（本步一个都没搬，见上） |
| 产物落盘 | `lib/client/components/views/MatterPane.js` 已生成，`lib/client.js` 里能搜到搬走的文案 |
| 「纯搬家」的机械证据 | 搬走块里的中文界面文案只有 4 条（`案卷 N 个` / `（已选 1 个）` / `新建案卷` / `选一个案卷看详情与时间线。`），4 条全在新文件里；`MatterList`/`MatterDetail` 的渲染代码本就在 `components/MattersView.tsx`，未动 |

> **行数几乎没降（−4）是实话**：搬走的是 34 行 JSX，接回来的是 29 行 props + 注释。
> 这一步的收益不在行数，而在两件事：①容器不再知道案卷视图的 DOM 结构与那句占位文案；
> ②这块以前没有任何行为测试（`index.tsx` 跑不起来），现在有 35 条真浏览器交互断言。

真浏览器断言覆盖：案卷条"共 N 个 / 已选 1 个"、列表顺序与行元信息（阶段徽标 / 案型 /
专利类型 / 申请日）、未选中时的占位、点行 → `onOpen` 且高亮与详情跟着换、字段缺失显示 `—`
（不渲染 `undefined`）、官文两条（含"没填指定月数就不渲染那段"）、期限两条（届满日 / 不顺延
原始日 / 依据 / 状态中文 / 日历未覆盖标记）、`pending` 与已完成两种按钮文案 → 分别
`setDeadlineStatus(id, done|waived|pending)`、重算 → `recompute(当前案卷)`、编辑 → `edit(当前案卷)`、
新建 → `create()`、同步事件 → `syncEvents(当前案卷)` 且方向说明在位、**时间线由生产函数现算**
（5 条有日期 + 1 条无日期单独列出，日期降序）、引擎不可用 → 降级说明 + 重算禁用、恢复后可点、
空列表 → 「还没有案卷」且不给占位与详情、空态下「新建案卷」仍可点、无页面异常。

> 过程中红过一次：我自己把 `onCreate` / `onAddNotice` 写成 `onClick={记录器}`，React 把**点击事件**
> 当参数传进去，驱动里序列化那个合成事件直接报 `Object reference chain is too long` ——
> 红的是**脚手架**，不是组件（已改成零参包装并注明原因）。

## H4-6 任务视图 ✅ 完成（2026-10-03）

- [x] 左栏 `view === 'list'` 块（搜索框 + 状态/优先级多选下拉 + 类型 TabBar + 排序行 + 任务树 + 三处空态）
      → `src/client/components/views/TasksView.tsx`（143 行，**0 个 `useState`**）：props 29 个。
      文件名照 plan 给的 `TasksView.tsx`（这次没有改名）—— `components/TaskList.tsx` 是**部件**库
      （行/树/多选下拉/Badge），两个名字不撞。
- [x] 容器**一个 state 都没搬**：`taskFilter` / `taskSortKey` / `taskSortDir` / `archivedMode` /
      `archivedTasks` / `expanded` / `openFilter` 全留。理由是它们都跟容器里的派生咬在一起：
      前四个喂给 `visibleTaskTree`（`filterTaskTree ∘ buildTaskTree`）与 `taskTypeTabs`
      （`countTasksByType` + `buildTabs`）两个 `useMemo`，而 `expanded` 还被顶栏的
      **「收起全部」**（`collapseAll`）一起复位 —— 搬进视图就得把派生与那个按钮的语义一起搬，
      那是行为变化，不是纯搬家（plan §3：拿不准就留容器）。
- [x] 唯一一处"动到容器"的编辑：`openFilter` 的类型由 `'status' | 'priority' | 'type' | null`
      收成 `'status' | 'priority' | null`。`'type'` 这个成员早已无写入口（类型升 Tab 后没人再
      `setOpenFilter('type')`），是死成员；不收窄，视图的 props 就得跟着背上这个不相干的成员。
- [x] 视图**不发请求**：清空、Tab 点选、搜索输入、方向切换都是回调解意图；「查看归档」的
      `GET /api/workbench/tasks?archived=true` 与 `setArchivedTasks` 仍留在容器
      （`onToggleArchived` 只表达"用户要切换"）。`toggleTab` 那段"怎么把点选写回 `typeCodes`"
      的判定也留在容器（视图只发 `onSelectType(code, multi)`）。
- [x] 判据迁移（plan §5.4，**迁移而不是删除**）：
      - `progressWiring.test.mjs` 的 `pending={pendingMap}` 由"index.tsx 里必须有它"改成
        **整条链**：容器 `<TasksView>` + `pending={pendingMap}` → 视图 `<TaskTreeRows>` + `pending={pending}`
        → 并补反向断言"`index.tsx` 不许再直接渲染 `<TaskTreeRows>`"（扫之前剥注释）；
      - `listViewWiring.test.mjs` 两条：①共用 TabBar —— 断言改成"知识库与任务视图各挂一次、
        `index.tsx` 里 0 次"；②类型升 Tab —— 落点由 `index.tsx` 的 `view === 'list'` 段改到
        `TasksView.tsx`，并补"视图不许自己写选中逻辑（不许出现 `toggleTab(`）"。
      - 其余源码扫描（`countTasksByType(buildTaskTree(`、`buildTabs(taskTypeDicts, …)`、
        `gridTemplateColumns`、类型徽标已删等）都落在**没搬走**的容器/部件代码上 → 逐条 grep 复核后 0 条失效。
- [x] 真浏览器验证：新增 `scripts/verify/harness/tasksHarness.tsx` +
      `scripts/repro/verify-h4-tasks.mjs`（**46 条交互断言**），tsdown 脚手架加第 6 个入口。
      脚手架的三条派生（排序 / 过滤 / Tab 条数）用**生产函数**现算，`onSelectType` 逐字照抄容器写法。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` / `npx tsc -p tsconfig.build.json` | 干净 |
| 脚手架类型检查（plan §5.1 那条命令，6 个 harness 一起） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / 0 失败 / 2 跳过（条数不变：本步**迁移**断言，没有新增） |
| `node scripts/repro/verify-h4-tasks.mjs` | **46 条断言全绿**（0 跳过），截图 `_local-build/h4/h4-6-tasks.png` |
| `verify-h4-calendar / today / task-detail / knowledge / matters` | 21 / 24 / 55 / 42 / 35 条仍全绿（6 个 harness 并存不冲突） |
| `src/client/index.tsx` | 5144 → **5120** 行（本步 −24） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | 105 / 16 / 20 → **105 / 16 / 20**（一个都没搬，见上） |
| 产物落盘 | `lib/client/components/views/TasksView.js` 已生成，`lib/client.js` 里能搜到搬走的文案 |
| 清理掉的导入 | `index.tsx` 不再从 `components/TaskList.js` 导入任何东西（`MultiSelectDropdown` / `TaskTreeRows` / `countTaskTree` 随块搬走）；`TabBar` 组件也不再直接导入（只剩纯函数 `buildTabs` / `toggleTab` / `ALL`） |
| 「纯搬家」的机械证据 | 旧块的 27 个中文片段（含原样搬走的 JSX 注释）在新落点（`TasksView.tsx` + 容器那段说明注释）里 **0 条缺失** |

真浏览器断言覆盖：类型 Tab 由字典拼出 10 条（无「其他」）与「全部/各 1 条」徽标、默认选中「全部」、
命中数是整棵树（折叠时 3 行但「共 4 条」）、行序（dueAt 升序 + 无截止最后）、展开箭头 ▶/·/▼、
点箭头**不**触发打开任务、点行 → `open(整条任务)` + `.selected`、搜索命中 1 条与「清空」启用/禁用、
状态下拉（6 选项、`openFilter` 写回、勾「待办」命中 3 = 两条待办 + **父链上下文**的父任务、
再勾「已完成」回 4 行、触发器「已选 N 项」、点遮罩关闭**但筛选不丢**、逐个取消回到完整列表）、
优先级下拉（同时只开一个下拉、勾「高」只剩 1 条）、类型 Tab 单选 / Ctrl+多选 / 点「全部」清零、
Tab 条数**不含类型维度自身**（选了「代码实现」后「全部」仍 4）、排序三键 + 升降序
（优先级 weight 序 / 标题拼音序 / 截稿时间序，子任务始终紧跟父行）、
待验收投影透传（没投影时**只有终态徽标**、给了投影只有 t1 出现「待验收」）、
归档模式（`toggleArchived(true)` + 换数据源 + Tab 条数按归档源重算 + 按钮文案复位）、
归档为空 → 「没有归档任务」（与主列表空态是两句不同的话）、
任务空列表 → 「还没有任务…」+ 命中 0 + 清空禁用 + 工具条与 Tab 仍在、
筛选无命中 → 「没有符合条件的任务…」、换数据源后展开集不丢、无页面异常。

> 过程中红了三次，**三次都是我的断言/口径写错**，不是组件：
> ①筛「待办」我按 2 行写期望，实际是 3 行 —— 团队周会也是待办，我把夹具忘了；
> ②`.wb-progress-badge` 也命中已完成那条的**终态**徽标（本就该显示），要判"没有待验收"得看
> `.wb-progress-badge.pending`；③第一版截图时状态面板正盖着排序行右端，看不清「清空/查看归档」，
> 改成关掉面板再截（面板本身已由断言覆盖）。脚本里逐条注明。

> ⚠️ **未覆盖**：「查看归档」在容器里那条 `api('/api/workbench/tasks?archived=true')` 的
> **请求形状与失败分支**（`catch(() => undefined)`）本次没有新增断言 —— 它原先也不在任何测试里
>（`index.tsx` 跑不起来），本步是逐字搬家，覆盖缺口与拆分前一致。

## H4-7 快速录入弹窗 ✅ 完成（2026-10-03）

- [x] 新增 `src/client/components/dialogs/QuickEntryModal.tsx`（289 行）：一句话输入 + 附件轨
      （拖入 / 粘贴 / 选择三条入口 + 上限说明 + 逐条拒收原因）+ 工作区 / 技能 / 角色 / 模型四组选择
      + 底部两个动作，全部搬出 `WorkbenchApp`。**props 37 个，一个 `useState` 都没有**。
- [x] `index.tsx`：原来 204 行的 `{showQuick && (<Modal …>)}` 换成 49 行的 `<QuickEntryModal … />`；
      底部按钮的动作提成**具名回调** `submitQuickEntry`（放在 `openQuickEntry` 之后），
      容器传 `onSubmit={submitQuickEntry}`。
- [x] 顺手收掉：容器里的 `quickImageInputRef` 删掉（全仓只有这个弹窗读它）→ 改成弹窗自有的
      `fileInputRef`；`MAX_QUICK_IMAGES` / `MAX_QUICK_DOCUMENTS` 从 `index.tsx` 的导入里去掉
      （只剩弹窗用，弹窗直接从 `quickAttachments.js` 导入）。
- [x] 测试：3 条源码扫描断言**迁移落点**（plan §5.4：迁移而不是删除，每条都补了反向断言）。
- [x] 真浏览器验证：新增 `scripts/verify/harness/quickEntryHarness.tsx` + 该 harness 的
      `tsdown.config.mjs` 条目 + `scripts/repro/verify-h4-quick-entry.mjs`（CDP 驱动，52 条交互断言）。

### 先做的事：这个弹窗到底读哪些 state（清单见下，**结论是一个都不搬**）

| 它读的东西 | 归属 | 为什么不能搬进弹窗 |
|---|---|---|
| `showQuick` | 容器 | 它决定弹窗挂不挂载（`{showQuick && …}`），挂载开关不能住在被挂载者里 |
| `quickText` / `quickWorkspace` / `quickWorkspaceTouched` / `quickWorkspaceSource` / `quickFollowFolder` | 容器 | **`openQuickEntry` + `applyQuickWorkspaceDecision` 是容器唯一的预填判定点**，且被 `test/quickIntakeDefaultWiring.test.mjs` **逐字抽出来跑行为断言**（R3/R4/R5 三个变异验证过）。搬走 = 这套行为测试只能删掉 |
| `quickAttachments` / `quickAttachmentNotice` / `quickAttachmentsRef` | 容器 | 现有语义是**跨开关保留**（`openQuickEntry` 不清附件，只有「取消」清）—— 搬进弹窗就变成"每次关闭自动清空"，这是行为变更而不是搬家 |
| `quickPersona` / `selectedSkills` / `skillQuery` | 容器 | 由 `openQuickEntry` 复位（每次打开都回到"未指定 / 无技能"）；`personaWiring` 直接扫这段函数体 |
| `quickModelSelection`（+ setter 别名 `promptModelSelection`） | 容器 | 与**共享提示词弹窗共用同一个 state**（同 localStorage 键 + 同内存状态）；搬进弹窗就会出现"这个入口选完、那个入口还是旧的" |
| `skillCatalog` / `skillsLoading` / `skillsAvailable` / `skillProblem` / `modelModalityTable` / `runtime` / `busy` / `settings` / `error` / `workspaceChoices` | 容器 | 跨弹窗共享或来自 bootstrap / 宿主，本来就不是弹窗的 |
| `addQuickAttachments` / `removeQuickAttachment` / `clearQuickAttachments` / `loadSkills` / `toggleSkill` / `openDirPicker` / `forgetQuickWorkspace` / `loadModelModalityTable` | 容器 | 都要发请求或写设置 —— 弹窗只发**意图**（`onAddFiles` / `onRemoveAttachment` / `onRetrySkills` / `onBrowse` / `onForget` / `onModelLoaded`） |

> 计划里那句"状态最独立的一块（~40 个 `useState`）"**实测是反的**：这 ~40 个 state 全是
> **容器级且被别处共用**的，弹窗只是最大的**读方**。所以本步的收益是"搬走 204 行 JSX + 4 组选择的装配"，
> 不是"搬走状态"。把它记在这里，免得 H4-8 / H4-9 再按错误的预期排期。

### 接口上的三处改名（不是我顺手改的，是"容器→视图"必然的）

| 原来（写在容器 JSX 里） | 现在 | 为什么 |
|---|---|---|
| `onClick={() => { clearQuickAttachments(); setShowQuick(false) }}` | `onClick={onCancel}` | 弹窗不该知道容器的函数名；但**语义差别必须保留**：右上角 × / ESC / 遮罩走 `onClose`（**不动附件**），「取消」走 `onCancel`（清附件）——两条路径在驱动里各有一条断言 |
| `onClick={() => removeQuickAttachment(item.id)}` | `onClick={() => onRemoveAttachment(item.id)}` | 同上 |
| `placeholder={settings.defaultWorkspace \|\| '例如 D:\\Code\\my-repo …'}` | `placeholder={workspacePlaceholder}` | 占位文案是"默认工作区没设"的投影，判定留在容器（弹窗只画） |

### 迁移的 3 条源码扫描断言

| 测试文件 | 原判据 | 迁移后 |
|---|---|---|
| `workspacePickerWiring` | `index.tsx` 里 `<WorkspacePicker` 恰好 3 处 | 两文件**求和** = 3（`index.tsx` 2 + 弹窗 1），并各留一条计数；三个 `openDirPicker('…')` 仍在容器（意图来自容器） |
| `personaWiring` | `index.tsx` 里 `<PersonaPicker` 恰好 2 处 + 组件只有一个来源 | 两文件各 1 处、求和 = 2；"只有一个来源"改成**两处 import 指向同一个 `components/PersonaPicker.js`**（计数在跨文件后已不再表达该意图） |
| `quickIntakeClient`（三个选择器接在同一处） | `index.tsx` 里 `<PersonaPicker` / `<SkillPicker` / `<ModelPicker` 各 2 处 | 两文件求和 = 2，并各断言"弹窗里 1 处 + index.tsx 1 处"；promptModal 的"角色在技能之前"顺序断言原样留在 `index.tsx` |

`quickWorkspaceDefault` / `quickIntakeDefaultWiring` / `modelPickerDegrade` / `intakeWorkspace` **0 条需迁移** ——
这是刻意设计的：把"要不要显示「不再记住」""来源文案""提交闸门"这些**判定**留在容器（用 `showForget` /
`workspaceSourceLabel` / `onSubmit` 三个 props 传下去），它们扫的表达式就一个字都不用动。

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json` | 干净 |
| harness 那条 tsc（`scripts/verify/harness/*.tsx`，7 个入口） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / **0 失败** / 2 跳过（与 H4-6 同数：本步没有新增/删除用例，只迁移了 3 条） |
| `node scripts/repro/verify-h4-quick-entry.mjs` | **52 条断言全绿**，截图 `_local-build/h4/h4-7-quick-entry.png` |
| 其余 6 个驱动（calendar / today / task-detail / knowledge / matters / tasks） | 全绿（本步没碰它们渲染的组件） |
| `src/client/index.tsx` | 5120 → **4987** 行（−133） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | **105 / 16 / 20**（一个都没变 —— 本步没搬状态） |
| 新增 `src/client/components/dialogs/QuickEntryModal.tsx` | 289 行（含搬过来的 4 段"为什么这么写"注释） |
| 纯搬家的机械校验 | 老块里 16 行含中文的**代码**行：13 行逐字出现，3 行是上面那三处改名；5 个中文字符串字面量 + 5 个 JSX 文本节点**全部逐字保留**；`创建澄清会话` / `移除附件` 在 `lib/client.js` 里各只出现 **1 次**（没搬成两份） |

真浏览器断言覆盖（52 条，分组）：弹窗标题与占位；附件上限由 `MAX_QUICK_*` 现算；
工作区预填 = 「上次手动选择」且来源文案由判定给出；候选下拉四项的顺序与标签（占位 / 已打开 / 最近 / 默认）；
资料夹勾选默认值与命名说明；技能目录 3 条 + 说明行；角色默认「未指定」高亮；
角色库读不到时**就地给出可读原因 + 「重试」**；模型按钮在；文本空 + 无附件时提交禁用；
输入 / 清空对提交启用态的翻转；**三条附件入口**（file input / 拖入 / 粘贴）都入轨；
拖入「1 图 + 1 txt」时 txt 被拒并给出逐条中文原因；拖入 PDF 只记"待抽正文"意图、不入轨；
**上限**（已有 3 张再给 12 张只收 7 张 + 说清为什么；到顶再给一张数量不变但多一条原因）；
点 × 移除并清掉上一次的说明；点「不再记住」发出 `forgetWorkspace(预填目录)`；
下拉改选「已打开」工作区 → 值写回 + 算"用户动过" + 来源文案变「手动指定」+「不再记住」消失；
点「浏览…」发 `browse` 意图；手打路径走同一个 onChange；勾选框来回切；
技能选中 / 搜索过滤 / 筛选时已选标签仍在 / 点标签取消 / 清空搜索恢复；
角色点「无角色」→ 容器收到 none 且当前值文案跟着改，点回「未指定」复位；
模型目录不可用 → **菜单不打开、不摆假列表**，把可读原因交给容器（含"跟随 DSH 默认模型"）；
提交时容器收到**完整意图**（文字 / 工作区 / 资料夹开关 / 角色 / 10 个附件 id）；
脚手架不导航（提交只发意图）；**关闭语义**：× 不动附件、重开附件仍在、「取消」清空且带出附件数；
busy 时提交 / 添加附件 / 模型按钮禁用而「取消」仍可点；除脚手架里必然失败的 `GET /personas` 外无页面异常。

> 过程中红过两次，两次都是**驱动自己**的问题，不是组件：
> ① `dropFiles` 取的是弹窗里第一个 `.wb-field`，而那是 textarea 那一块（附件块是第二个）——
> 改成按"含 `.wb-quick-actions`"定位；② 角色库那条断言在 `waitFor(弹窗出现)` 之后立刻跑，
> 而 fetch 的失败是异步落地的 —— 补一条 `waitFor(失败原因上线)`。
> 另外最后那条"无页面异常"必须**白名单**：`file://` 下没有服务端，`GET /api/workbench/personas`
> 必然 CORS 失败（正是"降级要可读"那条用例的输入），所以判据写成"除它与其带出的
> `net::ERR_FAILED` 外没有别的异常"，并在脚本里注明理由。

> ⚠️ **未覆盖**：① 容器把文档附件 POST 给 `/quick-attachments/extract-text` 的请求形状与失败分支
> —— 脚手架里没有服务端，harness 只记录"待抽正文"的意图（这条原先也不在任何测试里，
> 覆盖缺口与拆分前一致）；② 组装后的真应用（`index.tsx` 容器 + 宿主面板）没有启动，
> 走的是 H4-1…H4-6 同一条 harness 路线（plan §5.3）；③ `skillQuery` 这个 state 只写不读
> （`openQuickEntry` 里 `setSkillQuery('')`、全仓无读取点）—— 属既有死代码，本步按"精准修改"
> 未动它，留给技术债清单。

## H4-8 对话框组 · 第一批（4 张）✅ 完成（2026-10-03）

> 8 张弹窗里的前 4 张。第二批（共享提示词弹窗）见下一节；剩余 3 张见本节末尾的"待做"表。
> **全部 8 张的进度以 `plan.md` §4 那一行为准**（会随每轮更新）。

本步规划里就写着"逐个搬，每个都是独立小步"。这一轮做掉**四张最小、耦合最少的**，
剩下四张（prompt / newTask / editTask / pendingOpen）留待下一步 —— 它们各自都牵着源码扫描断言
（见下"为什么先做这四张"）。

- [x] `src/client/components/dialogs/MatterDraftModal.tsx`（75 行）—— 建档 / 编辑案卷表单
      （19 个字段 + 2 个勾选框，**字段顺序有理由，注释一并搬走**）。
- [x] `src/client/components/dialogs/NoticeDraftModal.tsx`（57 行）—— 登记官文表单。
- [x] `src/client/components/dialogs/ReminderModal.tsx`（52 行）—— 到期提醒列表（含「知道了」逐条回执）。
- [x] `src/client/components/dialogs/DuplicatePromptModal.tsx`（61 行）—— 同名任务二选一。
- [x] `index.tsx`：四块 `{… !== null && (<Modal …/>)}` 换成四个 `<…Modal … />`（含各自的指路注释）；
      四张弹窗**合计 0 个 `useState` 搬走**（理由见下表）。
- [x] 测试：`matterView` 的 1 条断言**迁移落点**（并把术语扫描范围扩到新落点）。
- [x] 真浏览器验证：`scripts/verify/harness/dialogsHarness.tsx`（一张 harness 覆盖四张弹窗，
      用 `__h4.show(which)` 切换）+ `tsdown.config.mjs` 第 8 个入口 +
      `scripts/repro/verify-h4-dialogs.mjs`（39 条交互断言）。

### 为什么先做这四张

先按"耦合多少"排的（不是按大小）：把四个弹窗里的每一句用户可见文案都在 `test/*.mjs` 里搜了一遍 ——

| 弹窗 | 测试耦合 | 结论 |
|---|---|---|
| 建档/编辑案卷 | `matterView`：`assert.match(index.tsx, /案卷目录/)` | 1 条，已迁移 |
| 登记官文 | 无 | 0 条 |
| 到期提醒 | `reminderWiring` 只在**注释**里出现「到期提醒」（讲调度器退避，不是讲 UI） | 0 条 |
| 同名任务选择 | 无（`duplicateTask.test.mjs` 是服务端重复建单的行为测试） | 0 条 |

剩下四张的耦合明显更重：`personaWiring` 与 `quickIntakeClient` 都扫 promptModal 区域，
`workspacePickerWiring` 数着三处 `WorkspacePicker`（newTask / editTask 各占一处），
所以它们更适合各自单独一轮。

### 状态归属：四张弹窗合计 0 个 state 搬走

| 弹窗 | 它读的状态 | 为什么留下 |
|---|---|---|
| 建档/编辑案卷 | `matterDraft`（整份 `Record<string,string>`）/ `matterEditId` / 三个字典切片 / `busy` | `saveMatter` 要从**整份**草稿拼载荷（19 个键）、并按 `matterEditId` 决定 POST 还是 PUT；标题文案（新建/编辑）也由它判定 |
| 登记官文 | `noticeDraft` / 两个字典切片 / `busy` | 同上：`saveNotice` 从整份草稿拼载荷 |
| 到期提醒 | `reminders` / `reminderModalOpen` | 轮询与调度器都会写它们；而且"非空才挂载"这条条件在容器里 |
| 同名任务选择 | `duplicatePrompt`（含 `draftId` / `newTaskId` 等弹窗用不到的字段） | `reuseExistingTask` 要整份对象（它要拿 `draftId` + `newTaskId` 去归档本次新建的那条） |

写法上只把"改哪个字段"留在弹窗：`const set = (field, value) => onChange({ ...draft, [field]: value })`
（容器原先是内联的 `setX((prev) => prev === null ? prev : { ...prev, <field>: v })`，逐字等价，
只是不再需要 `prev === null` 那层空判 —— 弹窗只在非空时挂载，类型上就是非空）。

### 迁移的断言

| 测试文件 | 原判据 | 迁移后 |
|---|---|---|
| `matterView`（5D 术语） | `assert.match(index.tsx, /案卷目录/)`（那个字段标签） | 断言落到 `components/dialogs/MatterDraftModal.tsx`；同时把该测试的 `uiSources`（扫「案件」越界词）**扩容**到 `MatterDraftModal.tsx` + `NoticeDraftModal.tsx` —— 否则 UI 文案搬走了、扫描范围没跟上，覆盖会静默缩小 |

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json` | 干净 |
| harness 那条 tsc（8 个入口） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / **0 失败** / 2 跳过 |
| `node scripts/repro/verify-h4-dialogs.mjs` | **39 条断言全绿**，截图 `_local-build/h4/h4-8-matter-form.png`、`h4-8-reminder.png` |
| 其余 7 个驱动（calendar→quick-entry） | 全绿 |
| `src/client/index.tsx` | 4987 → **4920** 行（−67） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | **105 / 16 / 20**（不变 —— 本步也没搬状态） |
| 新增四个弹窗文件 | 75 + 57 + 52 + 61 = 245 行（含搬过来的注释） |
| 纯搬家的机械校验 | 四块里 **11 个中文字符串字面量 + 37 个中文 JSX 文本节点全部逐字保留**；结构令牌（`id="wb-matter-form"` / `id="wb-notice-form"` / `form=…` / `required` / `min={1}` / `max={36}` / `slice(0, 8)` / `wb-inline-check` / `wb-scroll-area` 等 24 项）各出现 1 次，没有搬成两份 |

真浏览器断言覆盖（39 条，分组）：
**建档**：标题由容器判定（新建态）；`form` 属性把底部保存按钮与表单绑在一处；
案型 9 条 / 专利类型「（未定）+3」/ 阶段 6 条且默认 `open`；只有案号与名称带 `required`；
两个勾选框默认不勾；输入写回整份草稿（弹窗不存副本）；勾选写入的是 `'1'`（字符串，非布尔）；
**必填为空时点保存不会提交**（浏览器原生校验真的生效）；填齐后提交→容器收到**可取消且已被拦住**的事件
（否则整页跳走）+ 真实草稿值；busy 时保存禁用；× 关闭并把草稿清空。
**编辑**：标题变「编辑案卷」；19 个字段带出原值；两个勾选框反映原值；专利类型选中 `utility-model`。
**官文**：标题 / `form` 绑定；官文类型 7 条且 `required`、发文日 `required` 且预填；
送达方式下拉来自传入的字典切片；指定期限 `min=1 max=36` + 「留空 = 不指定」；
官文文件占位点明 `file://` 机制；填写后点登记→容器收到事件与三个字段；× 关闭清草稿。
**提醒**：标题带条数「到期提醒（2）」；两行文案与**生产 `fmtTime`** 现算的期望逐字一致；
点第二行的「知道了」只回执 `r2` 且那一行消失（剩 1 行）；「稍后处理」只收起不回执；
**列表为空时弹窗不渲染**（容器那条 `reminders.length > 0 &&` 是必要条件）。
**同名任务**：标题点名原因；已有标题加粗 + 只显示 id 前 8 位（完整 id 不外露）；
`sameDescription` / `sameWorkspace` 两个判据各自驱动两句不同的话；「就用已有那条」的后果说明
（收口 + 归档 + 可恢复）；两条路分别是"收起"与"发 `reuseExisting(id)`"。
**收尾**：四张弹窗都不发请求 → 全程无页面异常。

> 过程中红过一次，红的是**断言**不是组件：`DuplicatePromptModal` 里那两句话是 **JS 字符串**、
> 不是 Markdown，所以页面上**真的会看到 `**` 星号**（`两条的描述**不同** —— …`）。
> 我第一版断言写成"页面上不该有星号"，被实测打回。这是**既有**的显示瑕疵（H4-8 之前就是这样），
> 本步是纯搬家、不改样式，所以**按纪律没顺手修**，只在驱动里把事实逐字钉住并注明来源，
> 免得以后被误判成"拆分引入的 bug"。同类瑕疵还有快速录入里那个 `` `<任务ID>-<标题片段>` ``
> 的反引号（H4-7 同样按原样搬走）。两处都记在这里，作为独立的小修（属于 M 批那种"文案瑕疵"）。

> ⚠️ **未覆盖**：① `saveMatter` / `saveNotice` 的**请求形状与失败分支**（POST/PUT 的 URL、载荷键名、
> 出错回显）仍没有断言 —— 驱动只能证明"表单事件被原样交给容器、可取消、草稿值正确"，
> 真正的网络部分在容器里（`index.tsx` 跑不起来）；`matterView` 有一条"载荷键名在路由/仓储里都能找到"
> 的静态扫描，但它扫的是 `index.tsx` 里的 `saveMatter`，与本次搬动的 JSX 无关。
> ② `delivery_mode` **出厂没有字典行**（`src/db/schema.ts` 只种了 matter_type / matter_stage /
> patent_kind / notice_kind 四组）——真机上"送达方式"下拉是空的。属既有缺口，与 H4-8 无关，
> harness 里用两条**合成**条目才能断言"选项来自传入的切片"，已在 harness 头部注明。
> ③ 组装后的真应用仍未启动（同 H4-1…H4-7 的 harness 路线）。

## H4-8（续）共享提示词弹窗 ✅ 完成（2026-10-03）

这一轮做掉 8 张里的第 5 张 —— 也是耦合最多的那张：**共享提示词弹窗**（9 个 mode 的补充提示词入口）。

- [x] 新增 `src/client/components/dialogs/PromptModal.tsx`（121 行）：`<h4>` + 说明段 + 正文 textarea
      + 角色 / 技能 / 模型三个选择器 + 底部「取消 / 开始」。**props 22 个，一个 `useState` 都没有**。
- [x] `index.tsx`：`{promptModal !== null && (…)}` 那 59 行换成 32 行的 `<PromptModal … />`。
- [x] 测试：3 条源码扫描断言**迁移落点**（`personaWiring` 2 条 + `quickIntakeClient` 1 条），
      每条都补了"index.tsx 里不许再有"的反向断言。
- [x] 真浏览器验证：新增 `scripts/verify/harness/promptHarness.tsx` + `tsdown.config.mjs` 第 9 个入口 +
      `scripts/repro/verify-h4-prompt.mjs`（24 条交互断言）。

### ⚠️ 这张弹窗的特殊之处：它不是共用 `Modal`

它用的是**自建**的 `.wb-modal-mask` / `.wb-modal`（**不 portal、不锁滚动、不抢焦点**），
而其他对话框都走 `components/Modal.tsx`。这看起来不一致，但本步是**纯搬家**：
换成 `Modal` 会同时改观感（多出标题栏与关闭按钮）、改层级（portal 到 body，DOM 位置变了）
与改行为（锁滚动 + 焦点陷阱），那是**行为变更**，不在拆分范围内。
所以结构逐字保留，并且**加了一条断言把这件事钉住**（`.wb-modal-mask`/`.wb-modal` 在、`.wb-overlay`/`.wb-dialog` 不在）——
否则后来人"顺手统一一下"就会悄悄改掉观感与行为。
（是否该统一，见下面「顺手发现」第 3 条，作为独立议题。）

### 状态归属：又是 0 个 state 搬走

| 它读的东西 | 为什么留下 |
|---|---|
| `promptModal`（title + value） | 打开/确认是 `askUserPrompt()` 那对裸 Promise 的两端（`promptResolveRef` 在容器里），正文值也只能住容器 |
| `promptPersona` / `selectedSkills` / `skillQuery` | 由 `askUserPrompt` 每次打开复位（技能清空 + 角色回「未指定」）；且**与快速录入共用**同一批 props |
| `promptModelSelection`（= `quickModelSelection`） | 与快速录入**同一个 state**（同 localStorage 键 + 同内存状态） |
| `promptResolveRef` / `AI_PROMPT_LABELS` / `cancelPrompt` / `confirmPrompt` | resolve 那个 Promise 是容器的活；弹窗只发 `onCancel` / `onConfirm` 意图 |

### 迁移的 3 条断言

| 测试文件 | 原判据 | 迁移后 |
|---|---|---|
| `personaWiring`（AX-R07 两处入口） | `index.tsx` 1 处 `<PersonaPicker` + 快速录入弹窗 1 处 | `index.tsx` **0** 处 + 两张弹窗各 1 处（求和仍 = 2）；"组件只有一个来源"改成两张弹窗各自从 `../PersonaPicker.js` 导入 |
| `personaWiring`（AX-R07 顺序） | 从 `index.tsx` 的 `{promptModal !== null && (` 切到 `wb-modal-actions` | 改成扫 `PromptModal.tsx` 整体（顺序意图不变：角色在技能之前），并补一条"index.tsx 不许再直接渲染 `<PersonaPicker`" |
| `quickIntakeClient`（三个选择器接在同一处） | `index.tsx` + QuickEntryModal 两个文件求和 = 2（每个选择器 index 1 + 弹窗 1） | 三个文件求和：`index.tsx` **0** + 两张弹窗各 1；顺序断言随落点搬进 `PromptModal.tsx`；测试名改成"两个 AI 弹窗"（原名"三个 AI 入口"是笔误级的旧措辞） |

**证据**

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json` | 干净 |
| harness 那条 tsc（9 个入口） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / **0 失败** / 2 跳过 |
| `node scripts/repro/verify-h4-prompt.mjs` | **24 条断言全绿**，截图 `_local-build/h4/h4-8-prompt.png` |
| 其余 8 个驱动（calendar→dialogs） | 全绿 |
| `src/client/index.tsx` | 4920 → **4894** 行（−26） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | **105 / 16 / 20**（不变） |
| 新增 `PromptModal.tsx` | 121 行（含搬过来的三段"为什么这么写"注释） |
| 纯搬家的机械校验 | 老块里 1 个中文字符串字面量 + 3 个中文 JSX 文本节点全部逐字保留；`min(620px, 94vw)` 全仓只出现 **1 次**（在弹窗里）、`补充 AI 提示词` 只出现 **1 次**；`index.tsx` 里剩下的 `wb-modal-mask` 命中都在**注释**里（无残留代码） |

真浏览器断言覆盖（24 条）：**结构没被换成共用 Modal**（`.wb-modal-mask`/`.wb-modal` 在、`.wb-overlay`/`.wb-dialog` 不在）；
宽度 `min(620px, 94vw)` 未动；标题 + 容器给的 mode 标签（`AI 咨询：可留空…`）；textarea 的 `autoFocus` 与占位；
底部两动作的顺序与文案；**三个选择器按「角色 → 技能 → 模型」的 DOM 顺序**渲染（按 `compareDocumentPosition` 判，不按源码）；
**空正文也能确认**（空串 = 沿用原有默认提示词）；确认时容器拿到 `{text, skills, persona}` 三样；
再次打开时 mode 标签换新、正文被复位成空；输入写回容器的 `promptModal.value`；
角色点「无角色」→ 容器收到 `none` 且当前值文案跟着改；技能选中 → 容器记下并出现已选标签；
模型拿不到目录 → 菜单不打开且把可读原因交给容器；**每次打开都复位**（技能清空 + 角色回「未指定」）；
「取消」只发 cancel 不发 confirm；**点弹窗内部不关闭**（`stopPropagation` 仍在）而点遮罩走同一条 cancel 路径；
技能目录不可用时就地给原因 + 「重试」（降级时列表整块不渲染）；busy 时三个选择器都禁用；
除脚手架里必然失败的 `GET /personas` 外无页面异常。

> 过程中红过两次，两次都是**驱动**的问题：① 我用 `.wb-modal > *` 的 className 过滤来找三个选择器的顺序，
> 而模型选择器外面套了一个**没有 className 的 `<div style="display:flex">`** —— 改成按
> `compareDocumentPosition` 比较三个选择器自身的 DOM 位置（更接近"用户看到的顺序"）；
> ② 点遮罩时用了元素**中心点**，而遮罩铺满视口、中心正好被居中的 `.wb-modal` 盖住 ——
> 点下去打的是弹窗内部（`stopPropagation`，不关闭，这是**正确行为**），改成取弹窗左侧 20px。
> 两条都写进了脚本注释。

> ⚠️ **未覆盖**：① `askUserPrompt()` 那对 Promise 的真实 resolve 时机（`confirmPrompt` 里先
> `promptResolveRef.current = null` 再 resolve）没有断言 —— 容器逻辑，`index.tsx` 跑不起来，
> 驱动只证明"弹窗发对了意图、载荷形状正确"。② `AI_PROMPT_LABELS` 的 9 个 mode 标签只验了
> 3 个（AI 咨询 / AI 拆解 / AI 复盘 / AI 执行 / AI 计划），其余靠容器映射本身。③ 组装后的真应用仍未启动。

### 顺手发现（H4 范围内**不修**，留给技术债清单）

按"纯搬家、不改行为/样式"的纪律，H4-8 只是把代码挪了地方，下面这些是搬的过程中**看到但没动**的东西：

1. **`**` 星号被当成正文渲染**：`DuplicatePromptModal` 里 `两条的描述**不同** —— …` 是 JS 字符串、不是 Markdown，
   页面上真的会看到星号（同类：写注释的人以为会加粗）。修法是一句话的事，但它改的是**用户可见文案**，
   与拆分无关 —— 单独一个小修。
2. **反引号被当成正文渲染**：`QuickEntryModal` 里 `` `<任务ID>-<标题片段>` `` 同理（截图里能看到反引号）。
3. **`PromptModal` 是唯一不用共用 `Modal` 的对话框**（自建 `.wb-modal-mask`，不 portal、不锁滚动、不抢焦点）。
   要不要统一是**产品决策**（观感 + 层级 + 行为三样都会变），不是重构顺手能做的；
   本步已加断言把现状钉住，改的时候会红。
4. **`delivery_mode` 字典出厂没种**：`src/db/schema.ts` 只种了 matter_type / matter_stage / patent_kind /
   notice_kind，所以「登记官文」里的"送达方式"下拉在真机上是空的（值仍能提交，因为默认 `electronic`）。
5. **`skillQuery` 是只写不读的死 state**（`openQuickEntry` / `askUserPrompt` 里各 `setSkillQuery('')` 一次，
   全仓无读取点）。`noUnusedLocals` 未开所以活着；H4-7 / H4-8 都按"精准修改"没动它。
6. **耗时输入 `min={1} step={5}` 会让「填 30」提交不了**（H4-8 第 3 批验证时实测到的**既有**缺陷，
   详见下面那节的证据）：原生校验以 `min` 为基准，合法值只有 1、6、11…，而新建任务是
   `<form>` + `type="submit"` → 浏览器直接拦住提交。修法一行（`min={5}` 或去掉 `step`），
   但它改的是**校验行为**，不在"纯搬家"这一步里做；驱动已用断言把现状钉住。
7. **「提醒行」的画法有两份**：`ReminderModal`（到期提醒弹窗）与 `PendingModal`（待你处理清单）
   各画一份「标题 · 时刻 + 知道了」。**不是本步引入**（搬之前 `index.tsx` 里同样是两份），
   抽一个 `ReminderRow` 会同时改动两个弹窗的画法 —— 记为待办，留给技术债清单决定。

## H4-8（续）新建任务 + 编辑任务 ✅ 完成（2026-10-03）

两张任务表单合成一轮（同一个 `wb-form` 骨架、同一个 `WorkspacePicker` 耦合点）：

| 弹窗 | 新文件 | 行数 | 容器调用点 |
|---|---|---|---|
| 新建任务（**非受控** FormData 表单） | `components/dialogs/NewTaskModal.tsx` | 95 | 搜 `{showForm && (` |
| 编辑任务（**受控**草稿表单） | `components/dialogs/EditTaskModal.tsx` | 138 | 搜 `{editDraft !== null && selected !== null && (` |

### 状态归属：又是 0 个 state 搬走

| state | 留在容器的理由 |
|---|---|
| `showForm` | 打开它的是任务列表 / 今日等入口，`createTask` 提交后还要 `setShowForm(false)` |
| `formWorkspace` | 「浏览…」的写回口是容器的 `applyWorkspaceDir`（三入口共用**一次**分派）；`if (showForm) setFormWorkspace('')` 也在容器 |
| `editDraft` | `beginEditTask` 摊草稿（`toLocalInput` 的时区口径）、`saveEditDraft` 拼 payload + 乐观更新、`reparentCandidates` 都依赖它 |
| `busy` / `workspaceChoices` / 字典切片 | 容器共有，按 plan §3 只传**结果** |

两张弹窗各自的 `useState` 计数 = **0**：新建那张连 ref 都没有（唯一受控值是 `formWorkspace`，住容器）；
编辑那张自带一个 `set(field, value)` 小闭包 —— 整份草稿写给容器，不在弹窗里分叉。

### 接口上新增两处类型定义（不是复制，是**收口**）

`EditTaskDraft` 原来是 `index.tsx` 里 `useState` 的**内联字面量**；搬走后形状必须有唯一定义处，
于是定义在 `EditTaskModal.tsx`、容器 `import type` 回来 —— **不是**两边各写一份
（"同一语义两处实现"是头号 bug 类别）。`ReparentCandidate`（`{id,title,depth}`）同理。

### 迁移的断言（`workspacePickerWiring`）

| 原判据 | 迁移后 |
|---|---|
| `<WorkspacePicker` 求和 = 3（index 2 + quick-entry 1） | **四文件求和** = 3，且逐文件计数一次钉死：index **0** + QuickEntryModal 1 + NewTaskModal 1 + EditTaskModal 1 |
| `name="workspacePath"` 在 `index.tsx` | 迁到 `NewTaskModal.tsx`（并加一条"hidden 输入必须承接受控值"），**反向断言** `index.tsx` 里不再出现该字段名（否则就是第二条提交路径） |
| `const [formWorkspace, setFormWorkspace]` / `if (showForm) setFormWorkspace('')` | **不动**（本来就是容器的事） |

`planCandidatesWiring` 的 4 条（保存 payload / 编辑框初值 / 就地校验 / 乐观更新）**0 条需迁移** ——
它们落在容器的事件处理器里（`beginEditTask` / `saveEditDraft`），不在 JSX 里；立项时写的"可能耦合"不成立。

### 证据

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json` | 干净 |
| harness 那条 tsc（10 个入口） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / **0 失败** / 2 跳过（迁移是就地改写，用例数不变） |
| `node scripts/repro/verify-h4-task-forms.mjs` | **47 条断言全绿**；截图 `_local-build/h4/h4-8-new-task.png`、`h4-8-edit-task.png` |
| 其余 9 个驱动（calendar→prompt） | 全绿（回归） |
| `src/client/index.tsx` | 4894 → **4824** 行（−70） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | **105 / 16 / 20**（不变） |
| 纯搬家的机械校验 | 旧块 43 条中文片段（归一化空白后）**0 条丢失**；结构 token（`wb-new-task-form` / 8 个 `name=` / `wb-btn primary lg` / `u00a0` / `reparentCandidates` / `workspaceChoices` / `saveEditDraft` / `createTask` / `openDirPicker` / 两个 `settings.*`）全部只在新落点；`index.tsx` 里 `全天任务` / `保存任务` / `AI 策略` 的残留命中都在**注释**里 |

真浏览器断言覆盖（47 条）：新建/编辑两张弹窗的标题与"一个入口一张弹窗"；
新建表单**非受控**链路（8 个 `name=` 字段一份不漏地进 `FormData`，含 hidden 的 `workspacePath`）；
三个下拉的**出厂 9 / 4 / 6 条**与默认选中（`client_meeting` / `p2` / `todo`）；
`required` 真的落在 DOM 上（空必填点保存**不提交**）；事件可 `preventDefault` 且已被拦住；
「浏览…」发的意图分别是 `form` 与 `edit`；受控值写回后手打框 + hidden 同步（一条链路）；
`busy` 时下拉/手打/浏览三处禁用；两个「取消」与 ×（同一条关闭路径）；
编辑态四个下拉（含 AI 策略 3 条）选中草稿里的 code；截止时间 = 生产 `toLocalInput` 现算的本地串；
耗时占位与说明文案、两入口**逐字相同**；勾全天写回草稿；父任务下拉 = 「（顶层）」+ 3 条候选、
缩进按 `depth` 给 `\u00a0`（0/2/4 个）；标题全空白 → 保存禁用且**点了也不触发**；保存交回**整份草稿**
（含未改动字段原样保留）；关闭后草稿清空；重新打开工作区被清空；全程无页面异常。

> ⚠️ **顺带发现一个既有缺陷**（本步不修）：耗时输入是 `min={1} step={5}`，而原生校验以 `min`
> 为基准 —— 合法值只有 1、6、11…，**填 30（正好是默认值）会被判非法**；新建任务又是
> `<form>` + `type="submit"`，浏览器直接拦住提交（驱动里实测 `checkValidity() === false`）。
> 对照 `SettingsModal.tsx` 同类字段写的是 `min={5} step={5}`（基数一致），所以这是漏改。
> 一行可修（`min={5}` = 强制 5 的倍数，或去掉 `step` = 任意整数），但那改的是**校验行为**，
> 与"纯搬家"无关；驱动已用两条断言把现状钉住（填 30 非法 / 填 86 合法），修的时候会红。

> ⚠️ **未覆盖**：① 组装后的真应用仍未启动（`formWorkspace` 的写回在真实流程里走
> `dirPickerPath` → 目录浏览弹窗 → `applyWorkspaceDir`，驱动是直接调 `applyWorkspaceDir` 模拟的）。
> ② `createTask` 提交成功后的 `refresh()` 与 toast、`saveEditDraft` 的乐观更新与失败 toast
> 都留在容器，没断言。③ 编辑态的时间口径只验了"等于 `toLocalInput` 的现算值"，没验时区边界。

## H4-8（完）待处理弹窗 ✅ 完成（2026-10-03）

最后一张弹窗，H4-8 到此 **8/8**：「待你处理（N）」是把**三种东西**并在一张清单里 ——
待确认草稿（服务端清单）、已暂存草稿、到点提醒。

| 弹窗 | 新文件 | 行数 | 容器调用点 |
|---|---|---|---|
| 「待你处理（N）」（待确认 + 已暂存 + 提醒） | `components/dialogs/PendingModal.tsx` | 96 | 搜 `{pendingOpen && (` |

### 状态归属：还是 0 个 state 搬走

| state | 留在容器的理由 |
|---|---|
| `pendingOpen` | 开关在铃铛按钮（`pendingCount > 0` 才画）与三处 handler 里，容器是唯一调度方 |
| `allPendingDrafts` | 5 秒轮询（`refresh`）与服务端回执都写它；它同时是计数与清单的来源 |
| `deferredDrafts` | 同上（`resumeDeferredDraft` 里也用回执刷新它） |
| `reminders` | 轮询 / `ackReminder` / 重新武装都写它 |
| `pendingDraft` | 它是「正在弹框里编辑的那一份」，`dismissDraft` / `resumePendingDraft` 都读写 |

`PendingModal` 的 `useState` 计数 = **0**（连 ref 都没有）。

### 「判」与「画」的分界（本步唯一需要拿主意的地方）

- 清单的过滤 `allPendingDrafts.filter((d) => d.deferredAt === null)` **留在容器**（就留在调用点上）：
  它是判定，不是画法。组件收到的已经是"待确认那一撮"。
- `pendingDraft !== null` 只影响**一个 10px 间距**（「已暂存」小节与上方要不要隔开）。
  为它把整个 `pendingDraft` 传进去会白白扩大接口，于是传布尔 `activeDraftOpen` ——
  表达式原样写在调用点上，读代码的人一眼能看出它的来源。
- `DraftView` 直接透传：它是 `src/shared/contracts.ts` 的共享类型，`DraftBanner.tsx` 也是这么用的；
  窄接口（`PendingReminderItem`）只给容器里那个**内联匿名声明的**提醒条目用。

### 迁移的断言：0 条需迁移，扩了 1 处覆盖面

`test/` 下没有任何断言引用被搬走的画法（`pendingOpen` / `allPendingDrafts` / `deferredDrafts` /
`resumePendingDraft` / `resumeDeferredDraft` / `待你处理` / `唤回处理` / `打开弹框` / `draftKindLabel` /
`ackReminder` 逐个 grep，只命中 `test/routes.test.mjs` 里的 **API 级** `deferredDrafts` 字段 —— 与界面无关）。

扩的一处：`matterView.test.mjs` 的「实体称谓是『案卷』」术语扫描加了 `PendingModal.tsx`
（那是用户可见文案的落点，按 plan §5.4 只扩不缩）。

### 证据

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json` | 干净 |
| harness 那条 tsc（**11** 个入口） | 干净 |
| `pnpm test` | 1039 用例 / 1037 通过 / **0 失败** / 2 跳过（用例数不变） |
| `node scripts/repro/verify-h4-pending.mjs` | **26 条断言全绿**；截图 `_local-build/h4/h4-8-pending.png` |
| 其余 10 个驱动（calendar→task-forms） | 全绿（回归） |
| `src/client/index.tsx` | 4824 → **4794** 行（−30） |
| `WorkbenchApp` 内 `useState` / `useMemo` / `useEffect` | **105 / 16 / 20**（不变） |
| 纯搬家的机械校验 | 旧块 20 条中文片段（归一化空白后）**0 条丢失**；结构 token（`wb-scroll-area` / `wb-row` / `cursor: 'default'` / `alignItems: 'flex-start'` / `wb-switch-desc` / `wb-btn primary` / `wb-hint` / `deferCount > 1` / `deferredAt ?? updatedAt` / `draftKindLabel` / `fmtTime`）全部只在新落点；`index.tsx` 里 `打开弹框` / `唤回处理` / `待你处理（` / `暂无待处理事项` / `已暂存（` **0 条残留** |
| 顺带清掉的死引用 | `index.tsx` 里 `import { Modal }`（pendingOpen 是最后一处用法）与 `draftKindLabel`（同批搬走）已删 |

真浏览器断言覆盖（26 条）：标题计数 = 清单条数 + 提醒条数（**现算**：点掉一条提醒后 5 → 4）；
`sm` 尺寸、只渲染一张、footer 只有一个「关闭」；**过滤仍在容器**（清单 3 条只画 1 条待确认，
另 2 条不重复画）；待确认行的标签 / 说明 / 按钮三处文案；行的 `cursor: default` 与 `alignItems: flex-start`；
「已暂存（2）」抬头；`draftKindLabel` 的中文标签 + 生产 `fmtTime` 现算的暂存时刻；
`deferCount` 1（不显示「第 N 次」）↔ 3（显示「· 第 3 次」）对照；主按钮「唤回处理」vs 次要「打开弹框」；
提醒行文案；DOM 顺序（待确认 → 已暂存 → 提醒）；全量态不显示空态；
**间距 0px ↔ 10px 两个值**（并走"打开弹框 → 关窗 → 重开"的真实回路）；
「唤回处理」收到**那一条** id；「打开弹框」收到那份草稿的 id + kindCode；
关窗是容器自己做的（没走「关闭」意图）；「知道了」收到那条 id 且那行消失；
footer「关闭」与 × 走同一条路径；只有一条提醒时 → 点掉它 → 标题归 0、空态提示出现而**弹窗不关**；
空态直开；全程无页面异常。

> ⚠️ **未覆盖**：① 组装后的真应用仍未启动 —— 驱动直接开关弹窗，没验"铃铛按钮点开它"那条真实入口
> （`pendingCount > 0` 才画铃铛，为真时点击 `setPendingOpen(true)`）。② 5 秒轮询把新的待确认草稿
> 推进界面这条链路（`refresh` → `setAllPendingDrafts` / `setDeferredDrafts` / `setReminders`）没断言，
> 驱动是用夹具直接给的状态。③ `fmtTime(draft.deferredAt ?? draft.updatedAt)` 的兜底分支**不可达**
> （服务端清单按 `deferred_at IS NOT NULL` 过滤，见 `src/db/repo/drafts.ts`），故不造合成装置去覆盖它。

## H4-9 收口 ✅ 完成（2026-10-03）

三件事：复核职责、钉上界、勾完成判据。

### 一、复核：`WorkbenchApp` 现在到底还剩什么

| 项 | 立项时 | 收口时 |
|---|---|---|
| `src/client/index.tsx` 总行数 | 5512 | **4794**（−718） |
| `WorkbenchApp` 本体 | 297–4338（约 **4040** 行） | 250–3618（**3369** 行） |
| 本体里自己画的 JSX | 约 **1408** 行 | **597** 行 |
| 容器内 `className=` | — | **26** 处（`wb-app` / `wb-h` / `wb-segmented` / `wb-panel-host` / ToastHost 这些外壳） |
| `useState` / `useMemo` / `useEffect` / `useRef` | 108 / — / 22 / 8（同为立项时口径） | **105 / 16 / 20 / 7** |
| 容器里残留的 `<svg>` / `<table>` / `<ul>` 一类"真视图"标签 | — | **0** |

`useState` 只降 3：§3 的规则是"只有可以随视图卸载一起丢的 state 才允许搬进视图"，
而容器的 state 几乎全被 5 秒轮询 / handler / 多视图共用 —— H4-1…H4-8 全程 **0 个 state 搬走**。
**这是设计结论，不是没做到**；plan §8 已按这个口径勾选（没有把"只降 3"说成"明确下降"）。

搬出去的 **16 个**组件（每步一个落点，全部 0 state）：
`CalendarView` / `TodayView` / `TaskDetailPane` / `KnowledgeView` / `KnowledgeDetailPane` / `MatterPane` /
`TasksView` / `QuickEntryModal` / `MatterDraftModal` / `NoticeDraftModal` / `ReminderModal` /
`DuplicatePromptModal` / `PromptModal` / `NewTaskModal` / `EditTaskModal` / `PendingModal`。

### 二、钉上界：`test/workbenchAppBudget.test.mjs`（新，5 条）

| 断言 | 上界 | 拦的是什么 |
|---|---|---|
| `index.tsx` 总行数 | ≤ 4900（另设 ≥ 4000 的下界） | 任何形式的回涨；下界防"把容器拆空 / 误删" |
| `WorkbenchApp` 自己画的 JSX | ≤ 650 | 视图画法又被搬回容器（拆前 1408） |
| `WorkbenchApp` 本体 | ≤ 3450 | 逻辑/状态段膨胀（新视图的 state/handler 搬进来） |
| 容器内 `useState` / `useMemo` / `useEffect` / `useRef` | ≤ 105 / 16 / 20 / 8 | state 又回到容器（§3 的反向保证） |
| 容器内 `className=` | ≤ 40 | 粗口径：容器里又长出视图画法 |
| 16 个视图 / 弹窗在容器里的挂载数 | **恰好 1** | 0 = 接线断了；2 = 同一视图两处挂载（本仓头号 bug 类别） |

口径与 plan §1 的命令**逐字一致**（本体 = `^function WorkbenchApp` 到第一个 `^}`；hook 数是**出现次数**），
否则两个数会各说各话。上界取"H4-8 完成时实测值 + 约 2% 余量"：小改动不必改测试，再塞一个视图必超。
**要放宽上界，先来这份文档写清为什么**（这里是唯一的账本）。

> 变异测试（验证"断言真的会红"，改完已用 `shasum` 比对还原）：
> ① 本体里插 120 行 → 总行数 + 本体两条红；
> ② 只往 JSX 段插 60 行（逻辑段不动）→ **只有「JSX ≤ 650」红**（657 行），其余 4 条绿；
> ③ 插一个 `useState` + 第二处 `<PendingModal` → hook 上界（106）与"恰好一处"那两条红。

### 三、`plan.md` §8 完成判据

四条全部勾选（含上面那条"`useState` 只降 3 是设计结论"的说明），数字引用本次收口的实测值。

### 证据

| 项 | 结果 |
|---|---|
| `node --test test/workbenchAppBudget.test.mjs` | **5 条全绿**（+ 三种变异下按预期变红） |
| `pnpm test` | 1044 用例 / 1042 通过 / **0 失败** / 2 跳过（新增 5 条） |
| `npx tsc --noEmit` + `tsc -p tsconfig.build.json` + harness tsc（11 入口） | 干净 |
| 11 个真浏览器驱动 | 全绿（本次未改产品代码，属回归确认） |

> ⚠️ 上界是**预算**不是**目标**：它保证"不回涨"，不保证"继续变小"。
> 若日后要真正缩小容器，得动 §3 那条规则本身（哪些 state 可以随视图丢）—— 那是新立项的事。
