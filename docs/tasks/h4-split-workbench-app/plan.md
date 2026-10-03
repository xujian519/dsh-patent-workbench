# H4：按视图拆分 `WorkbenchApp`（立项）

> 状态：**进行中**（2026-10-03 立项并开工）。技术债来源：`docs/design/2026-09-15-fork-survey.md` 与本仓
> 2026-10-03 的债务清查（H4 条目：`src/client/index.tsx` 单函数 4000+ 行、114 个 `useState`）。

## 1. 为什么做（业务价值）

`WorkbenchApp` 是工作台**唯一**的容器组件，它的现状是：

| 指标 | 现状 |
|---|---|
| `src/client/index.tsx` 总行数 | 5512 |
| `WorkbenchApp` 本体 | 297–4338（**约 4040 行**） |
| 其中逻辑/状态段 | 297–2927（约 2630 行） |
| 其中 JSX | 2928–4335（约 1408 行） |
| `useState` / `useRef` / `useEffect` / `useCallback` | 108 / 8 / 22 / 13 |
| 进度（H4-1…H4-8 完成时） | `index.tsx` **4794** 行；`WorkbenchApp` **105** 个 `useState` / 16 `useMemo` / 20 `useEffect` |

> **度量口径（可复现，H4-9 的防回涨断言用同一条）**：
> `awk '/^function WorkbenchApp/,/^}/' src/client/index.tsx | grep -oE 'useState[<(]' | wc -l`（其余 hook 同理）。
> 本表第一版写的是清查时的估算口径（114 / 9 / 29 / 15），与这条命令对不上 —— **以命令为准**。
> 基线 = 立项前的工作树：`HEAD` 的 5565 行经 M 批改动后为 5512 行 / 108 个 `useState`。

后果不是"不好看"，而是三类真实成本：

1. **改一处要读全部**：任何一个视图的改动都要在 4000 行里定位，且 hook 顺序是隐式契约 ——
   加/删一个 `useState` 位置错了就是运行期崩（`Rendered fewer hooks than expected`）。
2. **测试只能扫源码**：这个文件里的行为无法被单测直接触达，仓库因此积累了 **17 个**
   `src/client/index.tsx` 源码扫描测试（`grep`/正则断言）。它们是有价值的护栏，但也说明
   "这个文件不可实例化测试"。
3. **状态没有边界**：114 个 state 平铺在同一作用域，"哪个视图读哪些 state"只能靠人肉追。

## 2. 现状结构图（拆分依据）

> 行号是**立项时**（`index.tsx` 5512 行）的快照，每完成一步会整体位移 —— 定位请按符号/类名，
> 别按行号（这也是本项目禁止脆行号断言的原因）。

```
WorkbenchApp (297–4338)
├─ 逻辑/状态 297–2927
└─ JSX 2928–4335
   ├─ 顶栏 .wb-h                                    2929–2950
   ├─ promptModal（AI 提示词确认）                   2952–3010
   ├─ LocalDocModal（知识：本地文档）                3011
   ├─ matterDraft 弹窗                              3032–3065
   ├─ noticeDraft 弹窗                              3072–3093
   ├─ reminderModal（提醒列表）                      3096–3116
   ├─ DraftBanner（待确认草稿）                      3118
   ├─ duplicatePrompt 弹窗（重复任务）               3162–3192
   ├─ .wb-body
   │  ├─ .wb-nav（左栏，按 view 切 5 个视图）        3211–3533
   │  │  ├─ view==='today'     （统计卡 + 期限看板 + DayPanel 实例）  3282–3328
   │  │  ├─ view==='calendar'  （周/月网格 + DayPanel 实例）          3329–3383
   │  │  ├─ view==='knowledge' （工具栏 + 列表 + 分页）               3384–3427
   │  │  ├─ view==='matters'   （案卷列表）                           3428–3461
   │  │  └─ view==='list'      （筛选 + TabBar + 任务树）             3462–3532
   │  ├─ SettingsModal（容器接线在 3212–3281）      3212–3281
   │  └─ .wb-detail（右栏详情：知识 / 案卷 / 任务）   3535–3934
   ├─ showQuick（快速录入弹窗）                       3936–4139
   ├─ showForm（新建任务）                            4141–4187
   ├─ editDraft（编辑任务）                           4189–4256
   ├─ pendingOpen（待处理）                           4257–4304
   ├─ LocalDocModal（第二处挂载点）                   4317
   └─ ToastHost                                       4333
```

`WorkbenchApp` 之外的 4338–5512 是槽位/入口装配（`apply` / `WorkbenchPanelContent` /
`ensureStyle` 等），**本项不动**。

## 3. 目标架构

原则：**容器持有状态，视图只画**。

- 每个视图一个组件（`src/client/components/views/*.tsx`），props 显式列出它读到的**一切**；
- 视图自己的派生（网格、计数、分页切片）走**纯函数模块**（可单测），或 `use*` hook（与既有
  `dayPanelModel.ts` 同法）；
- `WorkbenchApp` 退化为协调者：取数、共享状态、把 props 递给视图。

### ⚠️ 一条必须写下来的规则（本项最容易犯的错）
**只有"视图卸载即可丢"的 state 才能搬进视图组件。**

五个视图都长这样：`{view === 'calendar' && (<.../>)}`。今天 `cursor` / `calMode` / 知识库的
筛选与翻页 / 任务树展开集都住在 `WorkbenchApp` 里，所以"切到别的页签再切回来"**不会丢**。
一旦把它们搬进视图组件，组件会随分支卸载、state 被重置 —— 那是一次**没人要求的行为回归**。

因此本项的搬法是：

- **要跨页签保持的 state** → 留在容器（或挂在容器的 `use*` hook 上，state 仍在容器实例内）；
- **视图私有的、丢了无所谓的 state** → 搬进视图；
- 判断不出属于哪类时，**默认留在容器**（保守方向 = 不变行为）。

**补充（H4-3 实测踩到的推论）**：这条规则不止管"页签"，也管**右栏**。
右栏（`wb-detail`）今天**常驻挂载**，所以它用到的十几个 UI 状态（详情页签、会话选择器、
变更历史是否展开、子任务表单的父任务）现在都活得比任何视图久。等 H4-4 把知识详情
也拆成独立视图、右栏开始按 `view` 分支挂载，这些状态就会面临"切一次页签被重置"。
所以 H4-3 的做法是：**任务详情整体搬出去，但这些状态一个都不搬**，逐个作为 props 进来
（`TaskDetailPaneProps` 因此有 29 个字段）。这不是偷懒，是这条规则的直接后果。

## 4. 步骤与顺序

每步都是一次可独立回退的改动。排序依据：**测试耦合少的先做**（先跑通流程），
**状态最独立的先做**（收益最大），高风险大件靠后。

| 步 | 内容 | 影响到的源码扫描测试 | 状态 |
|---|---|---|---|
| H4-1 | **日历视图**：`calendarView.ts#useCalendarView` + `components/CalendarView.tsx` | 无 | ✅ 完成 |
| H4-2 | **今日视图**：统计卡 + 期限看板 + `DayPanel` 实例 → `components/views/TodayView.tsx` | 无（已复核：`matter-deadlines/upcoming` 与 `deadlineEngineAvailable` 两条断言都落在**不动**的逻辑段与案卷视图） | ✅ 完成 |
| H4-3 | **任务详情**（右栏里"选中一个任务"的那一半）→ `components/views/TaskDetailPane.tsx` | `progressWiring`（`<TaskProgress`）、`planCandidatesWiring`（编辑框初值）**都已迁移** | ✅ 完成 |
| H4-4 | **知识视图**：左栏 → `components/views/KnowledgeView.tsx`、右栏 → `KnowledgeDetailPane.tsx`、筛选/派生/落盘 → `knowledgeView.ts#useKnowledgeView`、载荷拼装 → `buildKnowledgePayload`（纯函数） | `listViewWiring`（6 处落点，**已迁移**） | ✅ 完成 |
| H4-5 | **案卷视图**：案卷条 + 列表 + 详情 → `components/views/MatterPane.tsx`（plan 原写 `MattersView.tsx`，改名理由见 subtasks） | `matterView`（4 条装配扫描**已迁移** + 术语扫描扩容；其余 20 余条落在未搬走的容器代码上，0 条失效） | ✅ 完成 |
| H4-6 | **任务视图**：左栏任务块（筛选 + 类型 Tab + 排序 + 任务树 + 三处空态）→ `components/views/TasksView.tsx`（右栏任务详情 H4-3 已搬完，故本步只剩左栏） | `progressWiring`（`pending={pendingMap}` **已迁移**为"容器 → TasksView → TaskTreeRows 整条链 + 只有一处列表树"）、`listViewWiring` 两条（共用 TabBar / 类型升 Tab **已迁移**） | ✅ 完成 |
| H4-7 | **快速录入弹窗**（原估"状态最独立"，实测相反）→ `components/dialogs/QuickEntryModal.tsx`。**只搬 JSX 与文件输入 ref，0 个 state 搬走**（理由见 subtasks：预填由有行为级测试的 `openQuickEntry` 判定、附件刻意跨开关保留、模型选择与提示词弹窗共用同一份 state）；底部"记工作区 + 起澄清会话"提成容器里的 `submitQuickEntry` | `workspacePickerWiring`（`<WorkspacePicker` 计数**已迁移**为两文件求和）、`personaWiring`（`<PersonaPicker` 计数**已迁移** + 改成"两处都指向同一组件"）、`quickIntakeClient`（三个选择器计数**已迁移**为两文件求和）。`quickWorkspaceDefault` / `quickIntakeDefaultWiring` / `modelPickerDegrade` / `intakeWorkspace` **0 条需迁移**（判定与提交路径留在容器） | ✅ 完成 |
| H4-8 | **对话框组**逐个抽（prompt / matterDraft / noticeDraft / reminderModal / duplicatePrompt / newTask / editTask / pendingOpen）。**每个都是独立小步、0 个 state 搬走**（这些弹窗的状态都被别处共用或由容器判定） | `matterView`（「案卷目录」标签**已迁移**到 `MatterDraftModal.tsx` + 术语扫描范围扩容到新落点，第 4 批又加进 `PendingModal.tsx`）；`personaWiring` 两条 + `quickIntakeClient` 一条（**已迁移**到 `PromptModal.tsx`，改成三文件求和 + 反向断言）；`workspacePickerWiring`（`<WorkspacePicker` 四文件求和 + `name="workspacePath"` 落点迁移，**H4-8 第 3 批**）；`reminderWiring` / `duplicateTask` / `panelCss` 的命中都在**注释**或 styles.ts 里，0 条需迁移；pendingOpen 那一步 `test/` 下 **0 条**引用被搬画法（只命中 `routes.test.mjs` 的 API 级 `deferredDrafts`） | ✅ **8/8 完成**：建档/编辑案卷、登记官文、到期提醒、同名任务选择、共享提示词弹窗、新建任务 + 编辑任务、「待你处理（N）」待处理弹窗 |
| H4-9 | **收口**：复核行数/hook 数，加一条防回涨的源码断言 | — | 待做 |

## 5. 每步的验证协议（不许跳）

1. `npx tsc --noEmit` + `npx tsc -p tsconfig.build.json`（后者产 `.d.ts`，客户端也在 include 里）；
   ⚠️ 真浏览器脚手架（`scripts/verify/harness/*.tsx`）**不在** `tsconfig.json` 的 `include`（只有 `src`）里，
   所以上面两条**扫不到它**。视图类改动额外跑一次：
   `npx tsc --noEmit --jsx react-jsx --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --lib es2022,dom scripts/verify/harness/*.tsx`；
2. `pnpm test`（当前 1026 条；`pnpm test` 内部先 `pnpm build`，所以构建一并验过）；
3. **视图类改动必须真浏览器验证**：用 `scripts/verify/browser.mjs` 发现浏览器 + CDP 驱动，
   把该视图用真实 props 渲染进页面，**做交互断言**（点击/翻页/选中后 DOM 真的变了），
   并把截图落盘作为证据。单张渲染截图不算验证；
4. 受影响的源码扫描测试**迁移而不是删除**：把扫描范围从"只看 `index.tsx`"扩到
   "客户端全部源码"，断言意图逐条保持（仓库已有先例：抽 `ModelPicker` 时
   `clientInvariants.test.mjs` 的"当前会话"扫描就是这么改的，并在注释里写明了为什么不是放宽）。

## 6. 非目标（明确不做）

- 不改任何行为与样式（纯搬家；样式表 `styles.ts` 一行不动）；
- 不改后端接口、不改契约（`shared/contracts.ts` 不动）；
- 不引入状态库（Redux/Zustand/Jotai）—— 用 props + 少量 `use*` hook；
- 不合并/重命名既有 `components/*.tsx`（它们是上一轮的成果，不动）；
- 不做 H4 之外的债务（M7 CSS 重复规则、M8 职责过载等各自独立）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 把"跨页签保持"的 state 搬进视图 → 静默行为回归 | §3 那条规则；每步在浏览器里**做"切页签再切回"的交互断言** |
| props 里的闭包捕获旧值 | React 每次渲染重建 props，闭包引用最新值；但**不许把 props 存进 ref/state**（那才是捕获） |
| 源码扫描测试红 | 同步迁移扫描范围（§5.4），不许删断言 |
| 大文件改名/移动导致 `git blame` 断代 | 一次一步、只搬不改；搬动处保留原注释（含"为什么"） |
| 视图抽出去后 hook 顺序变化 | 只在容器里增删 hook 调用；视图内部 hook 与容器顺序无关 |

## 8. 完成判据（H4-9 收口时逐条复核，2026-10-03）

- [x] `WorkbenchApp` 只剩协调职责，逻辑/状态段显著变短，**单函数不再承载 5 个视图的 JSX**
      —— 本体 3369 行（JSX 段 **597** 行，拆前约 1408）；容器里 `className=` 只剩 **26** 处（外壳 / 顶栏 / 标签页 / ToastHost）。
- [x] `index.tsx` 总行数有明确下降：**5512 → 4794**（−718）。`WorkbenchApp` 内 `useState` 108 → **105**：
      只降 3，因为 §3 的规则是"只有可以随视图卸载一起丢的 state 才允许搬进视图"，而容器的 state
      几乎全被 5 秒轮询 / handler / 多视图共用（H4-1…H4-8 全程 **0 个 state 搬走**，这是**设计结论**，不是没做到）。
- [x] 上界已用源码断言钉住：`test/workbenchAppBudget.test.mjs`（行数 / 本体 / JSX 段 / 四个 hook / `className=` / 16 个视图各挂载一处），
      并做过变异测试确认每条断言都能真的红（见 `subtasks.md` 的 H4-9 一节）。
- [x] 全部测试绿（含迁移后的扫描测试）+ 每个视图的真浏览器交互证据齐备
      —— `pnpm test` 1044 用例 / **0 失败**；11 个真浏览器驱动（calendar / today / task-detail / knowledge /
      matters / tasks / quick-entry / dialogs / prompt / task-forms / pending）全绿，截图落在 `_local-build/h4/`。
