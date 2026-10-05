# 变异探针维护 + 判据盲点（2026-10-01 发 v1.16.1 时补跑发现；2026-10-02 精确分类）

> **状态（2026-10-02 晚）**：`probe-capacity-mutations` 的欠账（**真盲点 5 条 + 失效 14 条**）已**全部销账** ——
> 重锚 12 条共享模块变异（S1–S12）+ 保留接线/面板 6 条（I1–I5 / P1–P3），并为原先"装回缺陷仍全绿"的
> 6 处**补了判据**（`capacityWiring.test.mjs` 4 条源码扫描 + `capacityPanel.test.mjs` 1 条勾选态判据，覆盖 I2–I5 / P2 / P3）。
> 判据：探针 **20/20 全红、exit 0**；`KNOWN_PROBE_DEBT` 里那条容量条目已删除（双向断言要求"还清必须销账"）。
> 现在名单只剩 `probe-model-picker-notify-mutations`（3 条失效，无真盲点）与 `probe-quick-workspace-mutations`（2 条失效）。
> 详细经过见文末 [§A2](#a2-2026-10-02-销账记录probe-capacity-mutations)。
>
> 背景：`dsh-release` skill §3 的硬门禁里有一条「有变异探针的项目：**必须全红**」。
> 发 v1.16.1 时**漏跑了这一条**（skill 里写的路径过时，照着敲找不到文件），事后补跑。
> **不影响 v1.16.1 的代码质量结论** —— 探针红/绿说的是"判据能不能拦住未来回归"，
> 不是"当前代码对不对"（v1.16.1 已通过用户实测 + 全量单测 + 三套浏览器判据 + 真实产物对账）。

## 0. 读这张单子必须先知道的一件事

探针输出的 `✖` **有两种完全不同的含义**，混在一起看会让欠账清单严重失真：

| 详情行 | 含义 | 义务 |
|---|---|---|
| `装回缺陷后**仍然全绿**` | **真盲点**：这个行为没有被任何断言守住 | **补判据** |
| `变异点没匹配上（源码结构变了…）` / `找不到替换片段（探针失效，需更新）` | **探针失效**：源码重构搬走了它锚的片段，变异根本没装上 | **重锚探针**（补判据没用 —— 缺陷压根没装回去） |

> 我们差点因为只看粗粒度输出，去补 9 条**根本不存在**的判据。2026-10-02 逐条核对后才有下表。

## A. 真盲点（6 条，**要补判据**）

| 探针 | 变异 | 现状 |
|---|---|---|
| `probe-capacity-mutations` | **M11** `saveEditDraft` 的 payload 删掉 `estimatedMinutes` | 装回后仍全绿 |
| `probe-capacity-mutations` | **M12** `editDraft` 初值改回常量（打开编辑框看不到库里真实值） | 同上 |
| `probe-capacity-mutations` | **M13** 客户端不再就地校验非法耗时 | 同上 |
| `probe-capacity-mutations` | **M14** 删掉乐观更新（改完要刷新才看到「已排」变） | 同上 |
| `probe-capacity-mutations` | **M19** 面板把逾期开关的勾选态写死 `false`（**开关变成假控件：点了不勾**） | 同上 |
| `probe-quick-workspace-mutations` | ~~**M10** 调用点把 `recent` 传成空数组（判定对、喂错了）~~ | ✅ **2026-10-02 已修**：在 `test/quickWorkspaceDefault.test.mjs` 补了一条**盯实参**的接线判据（`workspaceCandidates({...})` 里 `recent` 必须是 `settings.quickWorkspaceRecent`、不许写死 `[]`）；反向验证：装回缺陷该判据立刻变红，探针从 3/15 → **2/15**。教训：**"函数被调用了"不算数，要盯喂进去的实参** —— 判定函数与组件各自都有测试，唯独"调用点接线"没人守 |

**优先级**：M19（用户可见的静默失效）→ 再 capacity 的 M11–M14。

## B. 探针失效（19 条，**要重锚**）

| 探针 | 失效变异 | 根因 |
|---|---|---|
| `probe-capacity-mutations` | M1–M10、M15–M18（**14 条**） | 容量计算已从 `src/client/capacity.ts` **迁到共享模块**；该文件现在只剩 `clampEstimatedMinutes` 之类的工具，探针锚的全是旧实现的字符串 |
| `probe-quick-workspace-mutations` | M6、M14（2 条） | 接入 `WorkspacePicker` 后调用点变了：`setQuickWorkspace(e.target.value)` 已不存在，现在是 `setQuickWorkspace(path)` / `setQuickWorkspace(picked)`；「不再记住」按钮移进组件（渲染条件在组件里，不在 `index.tsx`） |
| `probe-model-picker-notify-mutations` | B7、B8、B10（3 条） | 同一次重构：`selectionApplication = selectionToApply(...)`、`unavailableReason: reason`、`clearExitReachable: ...` 的写法/位置都变了 |

> 这 19 条**必须重锚**才有意义：`M6` 这类"换个入口重新引入污染"的守卫，正是最该活着的那些。

## C. 探针自身的两类缺陷（**已修一部分**）

1. **`lib/` 污染 ⇒ 假红**（**已修**：`release-preflight.mjs` 在每个探针之间自动 `pnpm build`）：
   探针把 `src/` 还原了却不重建 `lib/`，盘上留下**最后一个变异体的构建产物**。
   **实测**：连跑后 `node --test test/modelPickerDegrade.test.mjs test/quickIntakeClient.test.mjs
   test/quickWorkspaceDefault.test.mjs test/listViews.test.mjs` → **0/4 通过**；
   `pnpm build` 之后同样的命令 → **83/83 通过**。
2. **两种汇总约定**（**已修**：`scripts/lib/releasePreflight.mjs` 两种都认，认不出按不通过）：
   约定 A `✅ N/N 条变异都被断言抓到`（knowledge-recall / draft-overwrite / model-picker / quick-workspace）；
   约定 B `变异探针：N/M 条变异都变红`（capacity / listview）。
3. **残留会进发布产物**（**已修，2026-10-05**）—— 这一条**不在本单范围内**，是审计
   [`2026-10-05-深度审计.md`](2026-10-05-深度审计.md) §4.3 补的**新后果**：
   上面第 1 条说的"假红"是**跑得下去**时的噪声；这一条说的是**跑不下去**时（SIGKILL / 断电 /
   被门禁超时杀掉 / 构建失败分支没走到还原）残留的变异体会**被下一次 `pnpm build` 烘焙进 `lib/`**，
   而**只改 `lib/` 的探针**（本仓有 1 个：`probe-knowledge-recall-mutations`）残留时**连再构建都不用**
   就已经是要发布的字节。
   **修法**：四个探针全部改走 [`scripts/lib/mutationGuard.mjs`](../../scripts/lib/mutationGuard.mjs)
   （写前备份 + `SIGINT`/`SIGTERM`/异常/`exit` 还原 + 崩溃后下次启动恢复），门禁在整批前后
   对 `src` + `lib` 拍指纹逐字节比对（[`workspaceFingerprint.mjs`](../../scripts/lib/workspaceFingerprint.mjs)），
   并且**所有命令都有墙钟上限**、探针调用**不经 shell**。
   **两份文档的分工**：本单管"探针自身准不准"（判据有没有牙、锚点有没有失效），
   §4.3 管"探针会不会污染发布产物"；两处的探针名单与债务清单**是同一份**
   （`KNOWN_PROBE_DEBT`），不许各写一套。

> ⚠️ **两者共同的前提**：探针**必须真的改写工作区**才能证明断言有牙（改 `src/` 或 `lib/`）。
> 所以"让探针不在工作区上改文件"（比如改到临时目录再复制回来）**不是**解法 ——
> 那会把探针变成另一件需要被验证的工具。解法是给它配**可恢复的账本 + 独立的指纹判据**。

## D. 复现与验收

```powershell
# 门禁一键跑（探针已在其中，且每个之间自动 pnpm build；整批前后核对 src+lib 指纹）
node scripts/release-preflight.mjs --only probes

# 单独跑某个探针时，**它前面要有一次 pnpm build**
pnpm build; node scripts\repro\probe-knowledge-recall-mutations.mjs

# ⚠️ 例子必须指向**现役**文件：`probe-capacity-mutations` / `probe-listview-mutations`
#    已随容量功能于 2026-10-03 删除。写一条跑不起来的命令，就是 v1.16.1 漏跑门禁的
#    那个形态（"路径过时，照着敲根本找不到文件"）—— 现役探针列表以
#    `scripts/repro/probe-*-mutations.mjs` 为准（门禁也是按这个 glob 发现的）。

# 探针被强杀后残留？先看有没有没走完的账本，再恢复（2026-10-05 起）
node scripts/repro/repro-mutation-residue.mjs            # dry-run：只报当前状态
node scripts/lib/workspaceFingerprint.mjs --verify _local-build/fp-before-probes.json   # 手工核对漂移
```

> 单独跑某个探针时若被 `Ctrl-C` / 强杀：账本留在 `_local-build/mutation-backup/<探针名>.json`
> （`state:open`），**下一次门禁开跑时会自动从备份还原并报出来**（`recoverCrashedSessions()`）。
> 备份是**逐字节原文**，不是"我记得改回去了"。

**修完这一单的判据**：`KNOWN_PROBE_DEBT`（`scripts/release-preflight.mjs`）清空后，
`--only probes` 仍然 exit 0。**清空名单是硬要求** —— 名单里已经不红的项会让 preflight 直接判失败，
这正是"欠账还清必须销账"的机制。

## E. 结论

- 门禁**有效**：一跑就分出了 6 条真盲点与 19 条失效探针（虽然要逐条核对才分得清）。
- 门禁**不能只写在 skill 里**：已接进 `scripts/release-preflight.mjs`，"漏跑"从此是可见的失败。
- **教训**：变异探针的"存活"必须再分一层（装不上 vs 装上了没守住），否则欠账清单会同时**虚高**（假盲点）
  与**虚低**（失效探针掩盖了真实覆盖率的下降）。

## A2. 2026-10-02 销账记录（probe-capacity-mutations）

**触发**：发 v1.16.2 时 `release-preflight` 报 `probe-capacity-mutations：探针失效 —— 这条门禁此刻不在工作，
必须先修探针`。门禁的立场是**刻意的**（`scripts/lib/releasePreflight.mjs#judgeProbes` 注释：
"探针失效"与"基线没过"**不算欠账**，直接失败）—— 名单里的失效说明只算**记录**，不能解锁。

**做法**（重锚 ≠ 把旧字符串贴到新位置）：

1. **按当前策略重新表述**：容量计算在 ADR0002（T2/D09）已迁进 `src/shared/dailyPlanPolicy.ts#computeCapacityLedger`，
   所以 12 条变异改锚到共享模块的真实口径：已排只累加计划项一次（S1）、重复项去重（S2）、
   缺合法 minutes 的默认展示（S3）、`doneMinutes`（S4）、`taskClosed`（S5）、`free = max(0,·)`（S6）、
   条形分母 `max(可投入, 已排, 1)`（S7）、`over`（S8）、`readable`（S9）、未排入是补集（S10）、
   优先级档位（S11）、建议投入合计（S12）。
2. **旧客户端口径直接作废**：那几个锚在 `src/client/capacity.ts` 的旧实现（按到期任务求和、
   `fallbackCount` / `dueTodayCount` / `overdueExcluded` / 全天 480）已随 ADR0002 消失，**不再保留同名变异**
   —— 保留一个装不上去的变异只会让门禁再次"看着有、其实没有"。
3. **补判据（这才是真盲点的义务）**：原先 6 处"装回缺陷仍全绿"的位置补了会失败的断言 ——
   `capacityWiring.test.mjs` 新增 4 条**源码扫描**（编辑耗时的保存 payload / 编辑框初值 / 就地校验 / 乐观更新，
   对 I2–I5）+ 1 条"面板不许 reduce 自己求和"（对 P1）；
   `capacityPanel.test.mjs` 新增 1 条**勾选态判据**（`includeOverdue` 来自 props，对 P2/P3）。
   为什么用源码扫描：这四处都在 `index.tsx` 的事件处理器里，`react-dom/server` 渲染不到交互 ——
   能搬进纯模块的就搬，搬不动的用扫描钉住，再用探针**反向验证"装回缺陷必须变红"**。

**结果**：

```text
变异探针：20/20 条变异都变红          # exit 0
```

**同时销账**：`KNOWN_PROBE_DEBT` 里的 `probe-capacity-mutations` 条目已**删除** ——
双向断言要求"名单里已经不红的必须删"，留着一跑就失败。
