# 灵枢 dsh-memory 调研落地 · 第一步 + 第二步

> 来源：`docs/research/2026-10-07-灵枢dsh-memory调研.md` §7 第一步 / 第二步
> 第三步（任务 8/9/10）已另记为 [issue #1](https://github.com/xujian519/dsh-patent-workbench/issues/1)
> 基线：v1.17.0 · SCHEMA_VERSION 23

## 先做什么

1. 读 ADR0003 / ADR0004（草稿确认纪律），`git status --short` 确认工作区
2. 核对 schema 与基线：`SCHEMA_VERSION`、`task_drafts` 现状列、`withDraftConfirm` 骨架
3. 每个任务：先写失败测试 → 再实现 → 跑定向测试 → 最后 `pnpm typecheck && pnpm test`

## 依赖与并行边界

```
任务1 (committed) ──┐
                    ├─→ 任务5 (actor 检查，改同一处 withDraftConfirm 调用面)
任务2 (负记忆) ─────┘
                    └─→ 迁移 v24（任务2 列 + 任务3 表，同一次迁移）
任务3 (前像表) ─────────┘
任务4 (persona 真源)      独立
任务6 (装后冒烟)          独立
任务7 (敏感信息闸门)      独立，但规则口径待用户提供
```

编辑冲突提示：任务 1 与任务 5 都碰 `src/db/repo/shared.ts` 与 `src/api/routes/drafts.ts` → **串行**。
任务 2 与任务 3 都碰 `src/db/schema.ts` 迁移数组 → **合并为一次迁移 v24**。

## 可执行片段

### 片段 T1 · `committed` 诚实字段 —— ✅ 已完成（2026-10-07）

- **输出**：确认接口的响应体区分「已受理」与「已落盘」
- **预计文件**：`src/api/routes/drafts.ts`（主）、`src/db/repo.ts`（补一条再导出）、`src/client/components/DraftBanner.tsx`、`test/draftCommitOutcome.test.mjs`（新）
- **验收**：见下「验收判据」
- **验证命令**：`node --test test/draftCommitOutcome.test.mjs && pnpm typecheck`
- **依赖**：无 · **大小**：中

**实际改动**

| 文件 | 改动 |
|---|---|
| `src/db/repo.ts:8` | 再导出 `getDraftConfirmResult`（对外符号由 repo.ts 汇总的项目约定） |
| `src/api/routes/drafts.ts` | 新增 `ConfirmSnapshot` + `committedNow()`；确认分支 15 个响应点全部带 `committed` |
| `src/client/components/DraftBanner.tsx` | 响应类型加 `committed?`；`committed === false` 且非 replayed/reused 时 `onNotice` 警告 |
| `test/draftCommitOutcome.test.mjs` | 新增，6 个用例 |

**决策（1-A 落地版）**：**只加 `committed: boolean`，不加 `commitReason`**（Karpathy 原则 2：不添加未要求的代码）。
三种成因（rolled_back / no_op / replayed）在客户端已由 `replayed`/`reused` 区分；再单开一个原因字段是重复表面。

**口径**：`committed === true` 当且仅当「调用前是 `pending`」+「调用前 payload 无 `confirmResult`」+「调用后是 `confirmed`」。
放在**路由层**而非 repo 层：`withDraftConfirm` 只在"真跑了 build"时才返回，区分不出回放与新建。

**踩到的坑（已修，值得记住）**：
`{ ok: true, committed: committedNow(db, before), knowledge: confirmKnowledgeDraft(db, id) }`
—— JS 按书写顺序求值 `committedNow` 先跑，那时确认还没发生，**永远回 false**。
已改成先把结果算进变量再组响应，并在两处加注释说明（`daily_plan` / `knowledge`）。
**教训：任何"回读状态"的字段都不能写在"触发状态变化"的表达式前面。**

**验证结果**：定向 6/6 绿 · 全量 1276 用例 0 失败（2 skipped）· `tsc --noEmit` 退出码 0 · `pnpm build` 退出码 0
**未完成**：CP1 的「界面手验」尚未做（需真机点一次确认弹窗）。

### 片段 T2 · 负记忆（被拒草稿留痕）—— ✅ 已完成（2026-10-07）

- **输出**：`task_drafts` 增 `rejection_reason` / `rejected_at` / `rejection_count`，被拒即在库内可查
- **预计文件**：`src/db/schema.ts`（迁移 v24）、`src/db/repo/knowledge.ts`、`src/api/routes/drafts.ts`、`src/db/repo/drafts.ts`、`src/db/repo/shared.ts`（行类型）、`test/draftRejection.test.mjs`（新）
- **验证命令**：`node --test test/draftRejection.test.mjs && pnpm typecheck`
- **依赖**：无 · **大小**：中

**实际改动**

| 文件 | 改动 |
|---|---|
| `src/db/schema.ts` | 迁移 v24 加三列（幂等写法，见下「共同」） |
| `src/db/repo/shared.ts` | `DraftRow` / `RawDraftRow` 加三字段；`recordDraftRejection` 落库实现 |
| `src/db/repo/drafts.ts` | `createDraft` 字面量补三字段；新增 `listRejectedDrafts`（`rejected_at IS NOT NULL AND status_code <> 'confirmed'`，倒序，上限 50） |
| `src/api/routes/drafts.ts` | import 加 `listRejectedDrafts` / `recordDraftRejection`；`abandon` 分支落痕；`GET /drafts` 返回 `rejectedDrafts` |
| `src/db/repo/knowledge.ts` | `confirmKnowledgeDraft` 校验失败处落痕（`knowledgeDraftRejection(...)` 之后、`throw` 之前） |
| `src/shared/contracts.ts` | `DraftView` 加三可选字段；`DraftResponse` 加 `rejectedDrafts?` |
| `test/draftRejection.test.mjs` | 新增，6 个用例 |

**口径：留痕**不看草稿有没有 `taskId`。两类落点覆盖范围**不一样**，缺一不可：

- `recordDraftRejection`（草稿行三列）—— **所有**被拒草稿都记。这是 T2 的核心回归点：
  知识草稿 `payload` 里根本没有任务，此前理由**当场丢弃**。
- `recordDraftFeedback`（任务事件 + 共享记忆）—— 只对**带 `taskId` 且任务还在**的草稿写。
  这是给 AI 会话看的那一份，原有行为一个字没动。

**口径：留痕**不改 `status_code` 语义。确认时校验失败的知识草稿**仍是 `pending`**
（用户改好字段要能原地重试，`withDraftConfirm` 的守卫依赖 `pending`），
所以 `rejectedDrafts` 的判据是 `rejected_at IS NOT NULL`，**不是** `status_code`。
「被拒过」是附加信息，不是终态。

**修正（2026-10-08，独立审查后）**：上句说的「不是 `status_code`」指的是**不许拿
`status_code = 'rejected'` 当判据**（那个终态根本不存在）—— 这条不变。但它漏了一种情况：
被拒的知识草稿**事后被确认**（用户改好字段再点「确认入库」）时，`rejection_reason` /
`rejected_at` / `rejection_count` 三列**按设计不清除**（这正是"负记忆"的意义），
于是「已确认」的草稿仍带着 `rejected_at` —— 只按 `rejected_at IS NOT NULL` 捞，
会把一条**用户已经批准的**草稿列进「被驳回」清单。所以判据补上
`AND status_code <> 'confirmed'`（`src/db/repo/drafts.ts` 的 `listRejectedDrafts`）。
边界说明：只排除 `confirmed`，**不排除** `abandoned` —— 被拒后又被放弃的草稿仍算负记忆。

**决策（2-A / 2-B 落地版）**：`GET /drafts` 用**独立字段** `rejectedDrafts` 返回，不混进
`draft`（自动弹窗用的「最新未暂存草稿」）也不混进 `deferredDrafts`。
**决策：本片段不做客户端 UI** —— plan 的 T2 预计文件清单里没有 client 文件（Karpathy 原则 2），
但 `listRejectedDrafts` 必须挂在 `GET /drafts` 上，否则就是死代码。

### 片段 T3 · 知识条目前像表 —— ✅ 已完成（2026-10-07）

- **输出**：`knowledge_entry_revisions` 表；`updateKnowledge` / `deleteKnowledgeWithRefs` 同事务写前像；可查可恢复
- **预计文件**：`src/db/schema.ts`（与 T2 同一次迁移 v24）、`src/db/repo/knowledge.ts`、`src/db/repo.ts`（再导出）、`test/knowledgeRevisions.test.mjs`（新）
- **验证命令**：`node --test test/knowledgeRevisions.test.mjs && pnpm typecheck`
- **依赖**：与 T2 共用迁移（先 T2 后 T3）· **大小**：中

**实际改动**

| 文件 | 改动 |
|---|---|
| `src/db/schema.ts` | 迁移 v24 建 `knowledge_entry_revisions` + `idx_knowledge_rev_entry`（幂等写法，见下「共同」） |
| `src/db/repo/knowledge.ts` | 新增 `KnowledgeRevisionRow` / `RawKnowledgeRevisionRow` / `parseKnowledgeRevision` / `getKnowledgeRevision` / `archiveKnowledgeRevision` / `listKnowledgeRevisions` / `restoreKnowledgeRevision`；`updateKnowledge` 包进事务并在覆写前留像；`deleteKnowledgeWithRefs` 删除前留像 |
| `src/db/repo.ts` | 再导出 `listKnowledgeRevisions` / `restoreKnowledgeRevision` / `KnowledgeRevisionRow` |
| `test/knowledgeRevisions.test.mjs` | 新增，8 个用例（纯 DB 层，T3 文件清单里没有 route） |

**口径：前像是「被覆盖掉的那一版」，不是当前版** —— 存错了整张表就毫无意义（测试①钉的正是这条）。

**口径：还原本身也是可还原的**。`restoreKnowledgeRevision` 走 `updateKnowledge`，
于是「退回去」这个动作会把「退之前」那一版也存成前像 —— 退错了还能再退回来，不是单向门。
代价是版本号会增长，换来的是「历史里没有不可逆的一步」。

**已知取舍：前像表不设保留上限（2026-10-08 用户拍板，登记不修）**。
`knowledge_entry_revisions` 每行是 `title` + `content_md` 的**全量副本**，
随每次修改 / 还原持续增长，**没有**「每条目只留最近 N 版」这类上限，也没有清理任务。
- **为什么不加上限**：加一条上限就要**删掉最旧的前像**，等于在这条链上重新引入一个
  「不可逆的一步」，与上面刚选定的价值取向直接冲突。今天的量级不足以换取这个代价。
- **判据（实地清点 `updateKnowledge` 的调用方，不是推测）**：写入者共四处 ——
  ① `PATCH /knowledge/:id`（用户手动改）；② `restoreKnowledgeRevision`（用户手动触发还原）；
  ③ **`workbench_link_knowledge_matter`（AI 工具，只改 `matterId`）**；
  ④ `scripts/knowledge-supersede.mjs`（人工跑的运维脚本）。
  每一处都是**单条、由一次明确动作驱动**，没有循环批量的入口，所以膨胀仍由人的操作频率决定。
- **⚠️ 诚实记一笔**：③ 是**AI 侧**入口 —— 上面"写作"部分那句「写入者只有两个、全在用户侧」
  是错的（初稿如此，已改）。它**确实**会在 AI 每次归入/移出案卷时留下一条前像
  （`sameKnowledgeFields` 把 `matterId` 算作差异字段）。今天它无害，因为它一次只动一条；
  但它就是"AI 能触发前像写入"的现成通道。
- **重新评估的触发条件**：出现**批量 / 自动**改知识条目的入口
  （例如某个 AI 工具能循环 `updateKnowledge`、或按案卷批量重挂），
  增长就不再由人控制，届时应改为「每条目保留最近 N 版」并补清理逻辑与测试。

**口径：删除也留像，且能用原 id 复活**。`entry_id` **刻意不设外键**：
- `ON DELETE CASCADE` 会让前像跟着条目一起消失（等于白留）；
- `SET NULL` 则丢掉了「这是谁的前像」。

复活必须沿用**原 id**，否则指向它的 `superseded_by_id` 会全断。
同理 `source_task_id` 也去掉外键：前像是历史快照，任务后来被删了，
不该把「这条经验当时来自哪个任务」从历史里抹掉。

**口径：被牵连的邻居不留像**。删一条被取代的条目时，邻居（`superseded_by_id` 被置空的那些）
**只动了一个引用列，正文一个字没变** —— 为它造一份与当前内容完全相同的前像，
只会在「历史」里塞一堆没有信息量的重复版本。

**决策（3-A / 3-B 落地版）**：还原路径**不额外校验** `supersededById` / `matterId` 是否悬空 ——
与 `PATCH /knowledge/:id` 保持同一口径，不发明「只在还原时才生效」的规则（写进了 doc 注释）。

**共同：迁移 v24 必须是幂等的（本次踩到的坑）**

第一版 v24 写的是裸 `ALTER TABLE ... ADD COLUMN`，全量测试**当场挂了两个**：

```
not ok 188 - §3.1 破坏性迁移的备份是一致快照（WAL 未截断时仍含最新事务）
not ok 910 - 破坏性迁移前自动整库备份
  error: 'duplicate column name: rejection_reason'
```

根因：`dbSafety` / `progressDb` 会**先把库迁到最新、再把 `meta.schema_version` 改回 `'21'`、然后重开库**
（模拟「用户的库停在 21、插件已升到最新版」）。这时物理 schema 已是 v24、三列已存在，
migrate 重放 22/23/**24** 就撞上了。**版本 22 起，迁移必须可重跑**（迁移 22 的原话：
「`IF EXISTS` 是为了幂等（测试里会用旧库快照反复跑）」）。

修法：照抄迁移 22 的范本 —— `PRAGMA table_info` 先收列名，逐列判存在性再 `ADD COLUMN`；
建表改 `CREATE TABLE IF NOT EXISTS`、建索引改 `CREATE INDEX IF NOT EXISTS`。
**没有**去改版本 ≤21 的裸 `ADD COLUMN`：那些版本不会被重放（Karpathy 原则 3）。

**共同：连带修掉 8 处硬编码的「最新版 = 23」断言**

加了 v24 之后，5 个测试因 `'24' !== '23'` 挂掉。断言的本意是「加了迁移别忘了抬版本号」，
所以**不是删掉断言，而是改成动态口径**：

| 文件:行 | 改成 |
|---|---|
| `test/progressDb.test.mjs` ×2（迁移 21 两条） | `String(SCHEMA_VERSION)` |
| `test/progressDb.test.mjs` ×2（迁移 22） | `String(SCHEMA_VERSION)` |
| `test/progressDb.test.mjs`（备份后重开） | `String(SCHEMA_VERSION)` |
| `test/progressDb.test.mjs`（备份文件名正则） | 见下 |
| `test/progressDb.test.mjs`（测试名 + `Number(version.value)`） | 测试名去掉写死的数字；断言 `SCHEMA_VERSION` |
| `test/matters.test.mjs` | 加 `SCHEMA_VERSION` 导入；`String(SCHEMA_VERSION)` |
| `test/dbSafety.test.mjs` | `String(SCHEMA_VERSION)` |

⚠️ **备份文件名那一处不能直接换 `SCHEMA_VERSION`**：它编码的是
「**最上面那个待跑的破坏性迁移**」，而 v24 是纯新增（不标 `destructive`）——
硬把它抬到 24 会让用户白白多一份整库备份。改成从迁移表算：

```js
const topDestructive = Math.max(...MIGRATIONS.filter((m) => m.destructive === true).map((m) => m.version))
assert.match(backups[0], new RegExp(`^workbench-\\d{8}-\\d{6}-pre-schema21-to-${topDestructive}\\.db$`), ...)
```

**验证结果**：T2 定向 6/6 绿 · T3 定向 8/8 绿 · 全量 **1290 用例 0 失败**（2 skipped）·
`pnpm typecheck` 退出码 0 · `pnpm build` 退出码 0 · 迁移 v24 重放路径由 dbSafety 188 / progressDb 910 两条实测覆盖。

### 片段 T4 · 注入文本真源 + 防漂移校验 —— ✅ 已完成（2026-10-08）

- **输出**：真源 → 各挂点取值 → 防漂移校验，挂进 `scripts/release-preflight.mjs`
- **预计文件**：`src/personas/`、`scripts/render-personas.mjs`（新）、`scripts/verify-personas.mjs`（新）、`scripts/dev-verify.mjs`
- **验证命令**：`node scripts/check-guidance-drift.mjs && pnpm test`
- **依赖**：先盘点（4.1）· **大小**：大

**先盘点（4.1）—— 纠正调研文档的一个前提**

调研文档说「persona 文本分散在多处」。**不成立**：`assets/personas/{generic,domain}/**/*.md`
已经是单源文件，`grep "workbench_\|工作台" assets/personas/` **零命中**，源码里没有 TS 副本。
另有一半闭环已经在 `src/personas/library.ts`（`sourceKeyForRoot` 路径指纹 / `revisionOfText`
内容指纹），域是 persona **文件**。

真正散落的是**注入文本**。机械扫描（16 字滑窗找跨文件逐字重复）的结论：

| 文本 | 位置 | 服务端份数 |
|---|---|---|
| `WORKBENCH_GUIDANCE` 整体 | `src/index.ts` | 1 |
| `/workbench` 澄清指令 | `src/index.ts` + `src/client/quickAttachments.ts` | 1（另一份在**客户端**） |
| 知识召回时机纪律 | `src/knowledge-recall.ts`（`KNOWLEDGE_GUIDE`） | 1 |
| **「AI 不能把任务标记为完成/取消」** | `src/index.ts` ×2 + `src/tools.ts` ×2 | **4** ✅ |
| 「不要在工作区根目录散放文件」 | `src/index.ts` + `src/client/quickAttachments.ts` | 1（另一份在**客户端**） |

**唯一纯服务端重复的规则族就是完成权限那一条** —— 其余带重复的都有一半在客户端提示词里，
而客户端那份走工作台面板、服务端拿不到（`index.ts` 的 intake 注释已写明），不属本次范围。

**决策（4-A 落地版）：范围收在「服务端注入文本」**（用户选定）。
persona `.md` 不动、客户端提示词不收。

**实际改动**

| 文件 | 改动 |
|---|---|
| `src/shared/guidance.ts` | 新增。真源：`COMPLETION_AUTHORITY_MARK`（特征短语）/ `COMPLETION_AUTHORITY_RULE`（可嵌入的规范句，由 `MARK` 拼出）/ `COMPLETION_AUTHORITY_REJECTION`（拒绝错误消息） |
| `src/index.ts` | 两处手写规则 → `${COMPLETION_AUTHORITY_RULE}` |
| `src/tools.ts` | 工具描述 → `COMPLETION_AUTHORITY_RULE + '。'`；拒绝分支 → `return COMPLETION_AUTHORITY_REJECTION` |
| `scripts/check-guidance-drift.mjs` | 新增。扫 `src/**` 去掉 `src/client/**`；规范短语**只允许**出现在真源里 |
| `scripts/release-preflight.mjs` | 新增 `gateGuidance()`（3/6 位，探针之前——纯静态、秒级），其余 gate 编号 1/5…5/5 → 1/6…6/6（**T6 之后为 1/7…7/7**） |
| `test/guidanceDrift.test.mjs` | 新增，7 个用例 |

**为什么真源不是「一个字符串导出」而是「规则 + 各语域取值」**

那 4 处**语域不同**（常驻引导 / 工具描述 / 错误消息），16 字滑窗扫描证明了它们**不是逐字复制**
（`index.ts` 写「完成/取消」，`tools.ts` 写「已完成/已取消」——同一条规定的两种说法）。
所以 import 同一个字符串会让三种语域互相迁就。真源给的是**规范表述**，
各挂点按语域渲染；防漂移校验负责断言「规范短语只在这里出现」。

**口径：防漂移校验扫 `src/` 但排除 `src/client/`**
`client/index.tsx`「标记为已完成？」与 `client/components/TaskProgress.tsx`「通过后才会标记为已完成」
是**给人看的 UI 文案**，不是注入给模型的引导。按 `check-lint-directives.mjs` 的同一条口径：
**扫得少但不误报，比扫得全但没人看更可用**（这条口径本身也被测试钉住）。

**踩到的坑**：校验脚本第一版若把规范短语**写在脚本里**，脚本自己就成了第 5 处副本。
现在由 `readMark()` **从真源里读**（正则抽 `COMPLETION_AUTHORITY_MARK` 的值），读不到就判失败。

**验证结果**：`node scripts/check-guidance-drift.mjs` 退出码 0 · 定向 `test/guidanceDrift.test.mjs`
**7/7 绿**（含「棘轮真的会响」的 3 条反例 + 1 条客户端口径反例）· 全量 **1297 用例 0 失败**（2 skipped）·
`pnpm typecheck` 退出码 0 · `node scripts/release-preflight.mjs --only guidance` 退出码 0。

**红→绿实证**：先写校验脚本（真源尚不存在）→ 红；造出真源但**不接挂点** → 红，且精确点出
`src/index.ts`（老变体）与 `src/tools.ts`（手打规范短语）两处；接上挂点 → 绿。

### 片段 T4（原设计）· persona 真源 + 渲染 + 校验 —— 已被上面的落地版取代

原设计想动 `src/personas/` 与 `scripts/render-personas.mjs` / `verify-personas.mjs`。
盘点后发现 persona 已是单源文件（见上），**没有可渲染的东西**；
用户把范围收在「服务端注入文本」，故按上面的方案落地。

### 片段 T5 · 「写入者不得自裁」——草稿确认只能是用户 —— ✅ **2026-10-08 完成**

- **输出**：`task_drafts.created_by` 列 + `withDraftConfirm` 单点守卫
- **依赖**：T1（同一调用面，串行）· **大小**：中

**实际改动**

| 文件 | 改动 |
|---|---|
| `src/db/schema.ts` | `SCHEMA_VERSION` 24 → **25**；新增迁移 `draft-created-by`：`PRAGMA table_info` 先查列再 `ALTER TABLE … ADD COLUMN created_by TEXT`（可重跑，纯新增、不标 `destructive`） |
| `src/db/repo/shared.ts` | `DraftRow`/`RawDraftRow` 加 `createdBy`；`parseDraft` 映射（`row.created_by ?? null`）；**新增 `draftConfirmActorProblem()`**；`withDraftConfirm` 三个重载 + 实现加 `options.actor`，守卫插在 **kind 检查之后、回放分支与事务之前** |
| `src/db/repo/drafts.ts` | `createDraft` 写入 `created_by`（`input.createdBy ?? 'ai'`）；`confirmTaskDraft`/`confirmSubtaskPlanDraft` 把 `actor` 穿进 options |
| `src/db/repo/knowledge.ts` | `confirmKnowledgeDraft` 同上 |
| `src/db/repo/plans.ts` | `confirmDailyPlanDraft` 原先**没有** `actor` 参数，补上并穿进 options |
| `test/draftActorGuard.test.mjs` | 新增，7 个用例 |
| `src/api/routes/drafts.ts` | **未改**（plan 原估到了这个文件；实际守卫收在 `withDraftConfirm` 单点，路由层不需要各自加检查） |

**口径决策：严格规则，不是原文的窄规则**

调研文档写的是窄规则「**AI 建的**草稿 AI 不能确认」。落地的判据更直白：
**任何非 `'user'` 的 actor 都不许确认**（`draftConfirmActorProblem` 首行 `if (actor === 'user') return null`）。

理由写进了代码注释：窄规则会让「AI 确认**用户建的**草稿」合法 —— 那不是防自裁，
是给"AI 替代理人拍板"这条执业红线开后门。拦不拦**只看 `actor`**；
`created_by` 只决定**措辞**（"这条草稿是 AI/人提交的 / 未记录来源"）。

**`NULL` 的两种含义（刻意不同，别混）**

- **列本身不给 `DEFAULT`**：v25 上线前建的行 `created_by = NULL` = **未记录**，守卫读到 `NULL` 就**放行**
  （拿一个它出生时还不存在的规矩去卡老草稿，只会把用户挡在自己的数据外面）；
- **`createDraft` 运行时默认 `'ai'`**（fail-closed）：今天 7 个建草稿调用点**全在 AI 侧**，
  所以"漏标记"最可能发生在**将来新加的 AI 路径**上 —— 那种情况下默认 `'user'` 会让它静默获得"能自己确认"的资格。

**不做什么**：守卫**不改草稿状态、不记 `rejection_count`**。actor 不对是**调用方的 bug**，
不是"用户驳回了这条草稿"，混进负记忆（T2 的字段）会让统计失真。

**⚠️ 今天的可达性：这是前向守卫（tripwire），不是生产拦阻点**

盘点结论（三条都实测过）：`createDraft()` 的 7 个调用点**全是 AI 侧**
（`src/tools.ts` ×5 + `src/db/repo/progress.ts` 的验收提交 + `POST /api/workbench/drafts` 那条 AI 自建知识草稿的绕行口）；
客户端的建草稿路径**根本不存在**（`DraftBanner` 只 POST confirm/defer/abandon/resume）；
4 个 `confirm*Draft()` 的生产调用点**全部**传 `'user'` 或缺省。

→ 所以这道守卫在生产路径上**打不着**。它的价值在于：谁哪天补上「让 AI 确认」的入口
（一个 `workbench_confirm_draft` 工具、或让 `POST /drafts/:id/confirm` 认调用方身份），谁就**当场撞上**它。
测试面可达（`confirm*Draft(db, id, 'ai')`）正是这句话的实证 —— 这两点都写进了
`test/draftActorGuard.test.mjs` 的文件头注释，免得被测试的绿色骗了。

**7 个 AI 调用点为什么不逐个改**：默认值 `'ai'` 已覆盖，逐个改是冗余（原则 3）。
改由 `DraftInput.createdBy` 的 doc 注释点名这 7 处。

**验证结果**：`test/draftActorGuard.test.mjs` **7/7 绿** · 全量 `pnpm test` **1304 用例 / 1302 pass / 2 skipped / 0 fail** ·
`pnpm typecheck` 退出码 0 · `pnpm build` 退出码 0。

**红→绿实证**：先写测试 → 红（7 用例 6 失败，`no such column: created_by`）→ 实现 → 绿。

**变异验证（证明守卫真在承重）**：把 `draftConfirmActorProblem` 的函数体替换成注释再 rebuild →
**3 pass / 4 fail**（4 条"非 user 被拒"的用例全红）→ 从备份恢复 → `grep -c MUTATION` = 0 → rebuild → 7/7 绿。

**迁移 v25 的老库路径**：`dbSafety.test.mjs` / `progressDb.test.mjs` 用 `SCHEMA_VERSION` 符号而非写死数字
（`progressDb.test.mjs` 断言 `SCHEMA_VERSION === max(MIGRATIONS.version)`），新迁移自动被
「新库建表」+「老库停在 21 重放 22…25」两条路径覆盖，全绿。

### 片段 T6 · 装后真启动冒烟腿 —— ✅ **2026-10-08 完成**

- **输出**：`scripts/verify-installed.mjs`，打包 → 空沙箱安装 → 真启动 → 断言工具面
- **预计文件**：`scripts/verify-installed.mjs`（新）、`scripts/dev-verify.mjs`
- **依赖**：先盘点打包命令 · **大小**：中

#### 实际改动

| 文件 | 改动 |
|---|---|
| `scripts/verify-installed.mjs` | **新增**（约 270 行）。7 步流水线：`pnpm pack` → `gunzipSync` + `listTarEntries` 解到**空沙箱** `<tmp>/node_modules/dsh-patent-workbench/**`（顺带断言无 `..`／无绝对路径）→ 软链 `@deepseek-ai` → 校验**包内 `buildId` == 当前源码** → 从**沙箱产物** `import` → 最小 ctx 桩真调 `apply(ctx, { dbPath })` → 断言。退出码 **0 通过 / 1 冒烟失败 / 2 压根没跑起来**。 |
| `scripts/release-preflight.mjs` | 新增 `gateInstalledSmoke()`（插在 `tests` 之后、`guidance` 之前）+ `SMOKE_TIMEOUT_MS`（5 min）+ `PLAN` 数组加 `['installed', …]`；横幅 **`1/6…6/6` → `1/7…7/7`**。 |

#### ⚠️ 与 plan 原文的偏差：落 `release-preflight`，**不是** `dev-verify`

plan 原文把这条腿写在 `scripts/dev-verify.mjs`。落地时挂进**门禁** —— 沿用 T4 的先例，理由是两者射程根本不同：

- `dev-verify.mjs` 是**重链**：要 `--url` / `--profile-dir` / `--db-path` / 真宿主 + 浏览器，验的是"真环境里端到端能不能用"；
- `release-preflight.mjs` 是**一条命令跑完的机械判据**（发版前那道闸）。

本腿要问的问题 ——「把包真的 `import` 进来、入口真的跑一遍，工具面还在不在」—— 是**机械的**、不需要真宿主，属后者。

#### 它补的是哪个洞（三道既有装盘检查都是"文件层面"的）

| 脚本 | 判据 |
|---|---|
| `check-tgz.mjs` | 包里**有**哪些文件（静态读 tar 头） |
| `check-installed-fingerprint.mjs` | 装盘产物与开发树**逐字节相同** |
| `check-installed-version.mjs` | 装盘版本号对得上 |

三道合起来仍答不出："产物 **import 得动**吗、入口**一执行会不会抛错**、工具面还是不是那 15 个、有没有**掉进降级空转**"。`test/pluginEntry.test.mjs` 也不覆盖 —— 它导的是**开发树** `../lib/index.js`，且**从不调 `apply()`**。

#### 断言清单（全部实测咬得住，见下方变异验证）

- **工具面 15 个「集合相等」**（不是"至少包含"）：加减工具都必须当场改 `EXPECTED_TOOLS`。与 `KNOWN_TEST_FAILURES`（名单外必红、名单里不红也必红）同一条纪律。
- 4 条核心路由在场（`bootstrap` / `health` / `settings` / `workspaces/ensure`）—— 只钉"工作台起不起来"，新增不拦、删掉必红。
- `systemPrompt` 有 `plugin:workbench` 节**且正文不是降级文案**。
- `/workbench` 命令恰好注册；DB 文件**真被建出来**；入口 `name` 与 `inject` 四个服务齐。
- 日志里**没有** `降级为空转`。

#### 🔍 落地时发现的一个细节（顺手把断言收紧了）

`applyDegraded` 用的是**同一个节名** `name: 'plugin:workbench'`（`src/index.ts` 的 `degraded-prompt` 分支）—— 所以「有这一节」**分辨不出**正常与降级。断言因此改成连**正文一起判**（含 `降级空转` 即失败）。这条是变异 B 跑出来的：降级模式下原断言不响。

#### 口径与限制（**别把绿色读成"等价于真机"**）

- ⚠️ **不启动真 DSH 宿主**。`ctx` 是照宿主接口手搭的最小桩，真接线（cordis fiber 的依赖注入顺序、真的 commands 服务、timer 调度）**不在射程内** —— 那是 `dev-verify` 的事。本腿射程是**产物本身**：`files` 白名单漏文件、`exports` 指错路径、入口 top-level import 解析不到、入口一执行就抛错、工具面漂移。
- ⚠️ **peer 依赖软链的是仓库自己的** `node_modules/@deepseek-ai`。`lib/index.js` 有一个裸 import（`createUserMessage` from `@deepseek-ai/dsh-llm`），真机由宿主提供；沙箱没有它连 `import` 都进不去。用的是**开发树同一份 peer**，**不是"干净环境"**。
- **桩的 `inject` 刻意不调回调**：复刻"宿主没装 timer 时 cordis 不调 cb"的语义 → 这里跑的就是真实的"没装 timer 插件"降级分支。
- **`verify-installed.mjs` 不进包**：它不在 `package.json` 的 `files` 白名单，也不在 `scripts/verify/`（故不受 `check-verify-scripts.mjs` 的套件白名单治理）。
- 脚本内**没有硬编码绝对路径**（用 `fileURLToPath(new URL('..', import.meta.url))`）—— 也因此没触发 PII 检查。

#### 验证结果（2026-10-08 实测）

```
① 打包：dsh-patent-workbench-1.17.0.tgz
② 沙箱解包：350 个文件 → node_modules/dsh-patent-workbench/
③ peer 依赖：软链 @deepseek-ai → 仓库 node_modules
④ 构建标识：包内 wb-c671b88ddcdc966a / 当前源码 wb-c671b88ddcdc966a   ← 相等
⑤ 真启动：import(沙箱产物) + apply(ctx, { dbPath })
   工具面 15 个 · 路由 28 条 · name=patent-workbench · inject=[webServer, systemPrompt, tools, commands]
✅ 装后真启动冒烟通过
```

- `node scripts/verify-installed.mjs` 退出码 **0**
- `node scripts/release-preflight.mjs --only installed` 退出码 **0**（横幅正确显示 `3/7`）
- `pnpm typecheck` 退出码 **0**；`node scripts/check-guidance-drift.mjs` 退出码 **0**；PII 腿带基线判「通过」（2 条既有欠账，与本次无关）

#### 变异验证（证明断言真有牙）

| 变异 | 结果 |
|---|---|
| **A**：`EXPECTED_TOOLS` 里 `workbench_submit_task` 改错一个字母 | ❌ 工具面少了 1 / **多了 1** → 退出码 **1** |
| **B**：`dbPath` 指向一个**目录**（SQLite 打不开 → 走降级） | ❌ **6 条**：降级空转 + 工具面少 15 + 核心路由缺 4 + 路由 0 条 + systemPrompt 是降级文案 + 命令没注册 → 退出码 **1** |
| 复原后复跑 | ✅ 退出码 0 |

### 片段 T7 · 敏感信息内容闸门

- **输出**：内容面规则源 + 两个挂点 + fail-closed
- **预计文件**：`src/shared/contentPolicy.ts`（新）、写入/发布挂点、`test/contentPolicy.test.mjs`（新）
- **⚠️ 前置**：规则口径需用户提供（客户名清单 / 案号形态 / 未公开技术特征判据）· **大小**：中
- **状态**：✅ **2026-10-08 达成**（用户三问已定：① 只搬凭据子集进 `src/`；② 单点挂 + fail-closed；③ 测试含误报率反例）

**实际交付**

| 文件 | 变更 |
|---|---|
| `src/shared/contentPolicy.ts` | **新**。凭据子集 7 条（与 `check-pii.mjs` 逐字一致）+ `scanContentPolicy` + `contentPolicyProblem` |
| `scripts/check-policy-drift.mjs` | **新**。**只读**对账：两侧凭据子集逐字一致；三条硬断言 + 三种变异 |
| `src/db/repo/drafts.ts` | 新增 `assertContentClean()`，挂 `createDraft` **与** `updateDraft` |
| `test/contentPolicy.test.mjs` | **新**。32 用例（规则真命中 / 误报反例 / 落库 fail-closed / 两闸同口径含三变异） |
| `scripts/release-preflight.mjs` | `gatePii` 追加「两闸同口径」子检查（见「偏差 2」） |

**规则口径（用户已定：只搬凭据子集，不新增、不改写）**

- 进包 7 条：私钥块 / npm token / GitHub token / OpenAI 风格 key / Bearer token 字面量 / api_key·secret·password 赋值 / 凭据文件名引用
- **留在 `scripts/`** 的私人标识（公司名、内网仓库名、本机账号名、个人邮箱）：**绝不进包** —— `scripts/` 不进 npm（`package.json` 的 `files` 白名单），`src/` 会被 `tsc` 编进 `lib/` 随包发布

**与 plan 原文的偏差（逐条如实报告）**

1. **⚠️ 挂点从「单点 `createDraft`」扩到「`createDraft` + `updateDraft`」**
   实测 grep：每个 AI 建草稿位置都是 `updateDraft ? … : createDraft` 的**孪生分支**，共 **12 个写点**。只守建不守改 = "先用干净内容过闸，下一次调用把凭据写进同一条草稿"即可绕过。两个写原语同在一个文件里，仍是"单一规则源 + 单文件双原语"，不回到逐点挂。
2. **挂点选择**：drift 检查挂在 **`gatePii` 腿内**（主题同为"敏感信息闸门"），未新增第 8 条腿、未重排 `PLAN` 编号。
3. **命中即 `throw` 而非返回**：`assertContentClean` 抛错（三条理由见源码注释）—— 这是**存储边界**，"返回值请你记得检查"会让漏检那一处变成静默写入；抛出的异常经 dsh-tools 包成 `ToolCallError`，message 仍是模型可读的中文。

**实测数据（2026-10-08）**

| 项目 | 结果 |
|---|---|
| `node --test test/contentPolicy.test.mjs` | **32/32 pass**，exit 0 |
| `node scripts/check-policy-drift.mjs` | exit 0（`check-pii` 提取 13 条字面量规则 / `contentPolicy` 7 条 / 契约 7 条） |
| 变异 A（src 侧 `npm token` 规则 `{20,}`→`{8,}`） | **门禁** `--only pii` 退出码 **1**，报「PII 两闸同口径」阻塞 ✅ |
| 变异 B（src 侧私自新增 `AWS key`）/ C（`check-pii` 侧改名） | drift 退出码 **1** ✅ |
| `release-preflight --only pii` | exit 0（含新子检查；三条欠账均为良性命中） |
| `pnpm typecheck` / `pnpm build` | 干净 / 成功 |

**四条如实记录的发现**

1. **误报率**（CP4 要求）：13 条业务形态语料 **0/13** 误报。但闸门**非零误报**：仅"**提到凭据文件名、并非泄漏**"的说明文字（如「`.npm_token.txt` 不要提交」）会被第 7 条拦下 —— 单独钉在「已知误报」用例里。**处置：接受并如实记录**，不改规则（改任何一个字都会让 drift 检查红，那是设计如此）。
2. **建议占位符曾二次命中**（自查）：错误消息初版推荐 `<在此填入令牌>` —— 第 6 条规则的豁免分支要求值里含 `secret|token|placeholder|example|dummy` 这类**自述词**，纯中文占位符不含 → **二次命中**。已改为 `'<placeholder-token>'`，并由用例双向钉住（推荐值必须自己过闸 + 纯中文占位符确实会被拦）。
3. **⚠️ 文件头注释里抄了私人标识原文 → 被自己的面二扫成真命中**（自查，本次最大教训）
   初版为"把两类规则说清楚"，在 `contentPolicy.ts` 注释里把私人标识**原样抄了一遍**。**`tsc` 会把注释带进 `lib/shared/contentPolicy.js` 与 `.d.ts`** → `check-pii` 面二**真命中 14 处**（公司/内网路径名、个人邮箱）。即"**我警告别搬进 `src/` 的同一段话，把它们搬进了包**"。**已修**：注释只写类别、取值指向 `scripts/check-pii.mjs`；教训已写进源码注释。
   残留：面二 `lib/shared/contentPolicy.js` 命中「凭据文件名引用」**1 处**（**规则源码自指**，与 `check-pii.mjs:73` 同一行；该规则名**本就在 `PII_BASELINE` 白名单**内，门禁不受影响，且原文只是通用凭据文件名、不含私人标识）。
4. **面一「凭据文件名引用」7 处命中为既有**：`.dsh/skills/dsh-release/SKILL.md`(3) / `scripts/new-github-release.ps1`(3) / `test/releasePreflight.test.mjs`(1)，**在 HEAD 里就已存在**且本批未改动 → **非本次引入**，且同样落在 `PII_BASELINE` 白名单内。（此前记录的"命中 0 处"指的是 `check-pii.mjs dist` 只扫面二。）

## 检查点

- **CP1**（T1 完成）：定向测试绿 + `pnpm typecheck` 干净 + 界面手验 ← **界面手验未做（待真机）**
- **CP2**（T2+T3 完成）：迁移 v24 跑通 + 老库降级正确 + 迁移前备份产生 + 全量 `pnpm test` 绿 —— ✅ **2026-10-07 达成**
  - 迁移 v24 跑通：全量 1290 用例 0 失败
  - 老库降级正确：`dbSafety:188` / `progressDb:910` 实测「库停在 21 → 重放 22/23/24」路径（v24 幂等性正是这两条测出来的）
  - 迁移前备份产生：`progressDb` 备份用例断言 `backups/` 恰一个文件、且**能被独立打开**读到 `schema_version = 21`（不是只数文件）
  - 全量 `pnpm test` 绿：1290 tests / 1288 pass / 2 skipped / 0 fail
- **CP3**（T4+T5+T6 完成）：门禁链含新腿且全绿
  - T4 腿已达成：`release-preflight --only guidance` 退出码 0
  - T5 **不新增门禁腿**（它加的是单测，由既有「2/7 全量单测」腿覆盖），✅ 2026-10-08
  - T6 腿已达成：`release-preflight --only installed` 退出码 0（横幅 `3/7`），✅ 2026-10-08
  - 注：plan 原文写的是挂进 `dev-verify`，实际挂进 `release-preflight`（理由见 T6 段的「与 plan 原文的偏差」）
  - **「门禁链含新腿」已达成**（`PLAN` = 7 条：typecheck / tests / **installed** / guidance / probes / pii / version）
  - ✅ **「全绿」已达成**（2026-10-08）：整条链退出码 **0**。原先唯一的阻塞项是「2/7 全量单测」腿的既有缺陷，见下（已修）。

### ⚠️ 既有缺陷（**非本次改动引入**）：全链门禁的「单测」腿恒失败 —— ✅ 已修 2026-10-08

`node scripts/release-preflight.mjs`（无 `--only`）曾退出码 1，唯一阻塞项：

```
❌ [单测] 没解析到任何用例（输出格式变了？）—— 门禁不能把"读不到"当成"通过"
```

**根因（已实测证死）**：`scripts/lib/releasePreflight.mjs#parseTestSummary` 用
`^\s*ℹ ${label} (\d+)\s*$` 匹配 **spec reporter** 格式，而 `gateTests` 用 `spawnSync`（管道 stdio），
Node 在**非 TTY** 下改用 **TAP reporter**，输出是 `# tests N` / `# pass N` / `# fail N`。

证据链：
1. `parseTestSummary('# tests 7\n# pass 6\n# fail 1\n')` → `{tests:0,pass:0,fail:0}`；同一串改成 `ℹ` 则正确解析；
2. `node --test test/draftActorGuard.test.mjs 2>&1 | grep -E '^# tests|^ℹ tests' | cat -A` → `#·tests·7␊`（管道下确认是 TAP）；
3. `git diff --stat scripts/release-preflight.mjs` = 本次改动全在横幅重编号 + 新增 `gateGuidance` + PLAN 数组，
   **未碰 `gateTests` / `run()` / `parseTestSummary`** → 非本次引入。

**修法（用户 2026-10-08 拍板选 ①）**：让 `parseTestSummary` 同时认 `#` 与 `ℹ` 两种前缀。
（② 给 `node --test` 加 `--test-reporter=spec` 未采。）

**修复范围比"改个前缀"大** —— 光改计数的前缀不够，还有第二处：

| # | 位置 | 症状 | 处置 |
|---|---|---|---|
| 1 | 计数行 `ℹ` / `#` | `tests/pass/fail` 恒为 0 → 判「没解析到任何用例」 | 正则改 `[ℹ#]` |
| 2 | 失败用例名 | spec 走 `✖ failing tests:` 块，TAP 走**行首无缩进**的 `not ok N - <name>`；只认前者 ⇒ `failing` 恒空 ⇒ `KNOWN_TEST_FAILURES` 白名单**反向断言恒红**（"登记为已知失败的用例这次是绿的"） | 新增私有 `parseFailingNames()`，两种形态都认，**只取顶层**（TAP 子测试是缩进的，跳过，与 spec 只列顶层同口径） |

**端到端验证（不是只跑单测）**：
- 修后门禁腿从 `没解析到任何用例` 变为真实计数（本轮新增单测后实测 `ℹ️ tests 1344 / pass 1342 / fail 0`）；
- **正向**：临时塞入 `test/__tmp_gate_probe.test.mjs`（一条 `assert.equal(1,2)`），门禁报出
  `❌ 单测失败：__gate-probe__ 故意失败（临时文件）` —— 修复前此处只会含糊地说"读不到"。临时文件已删、`git status` 无残留。

### 顺带修掉的第二处（修复过程中由门禁自己揪出）：Windows-only 陈账顶红 macOS

修好解析器后，门禁腿转为红，但理由换成了**正确且可操作**的一条：

```
❌ 登记为"已知失败"的用例这次是绿的：db migrations, dictionaries and task tree —— 还清了就要把名单删掉，别让名单腐烂
```

实测事实：
| 事实 | 证据 |
|---|---|
| 该用例在 macOS 上**全绿** | `node --test test/db.test.mjs` → 9/9；门禁 `fail 0` |
| 条目理由写的是 **Windows-only** | `reason: 'Windows 清理期 rmSync EPERM'` |
| 条目引入于 **2026-10-02**（`cb1d71d`） | `git log -S "KNOWN_TEST_FAILURES"` |
| 治它的重试助手 `removeTempDir` 引入于 **2026-10-03**（`a15dc51`）—— **晚一天** | `git log -S "removeTempDir" -- test/db.test.mjs`；其注释自述"重试则在句柄释放后自然成功" |

即：**条目立的时候 flake 是真的；隔天加了重试助手后它很可能已还清，但没销账。**
`judgeTests` 对名单是**双向**的（名单内的绿也报错），所以这条陈账让「2/7」在 macOS 上恒红。

**用户 2026-10-08 拍板：加平台限定**（不是直接删）。落地：
- 新增 `filterAllowedForPlatform(allowed, platform = process.platform)`（`scripts/lib/releasePreflight.mjs`，纯函数、可单测）；
- 条目加 `platforms: ['win32']`；`gateTests` 调用点先过这道筛。
- 语义：带 `platforms` 的条目**只在该平台参与双向判定**，其余平台整条剔除；**不带 `platforms` 的条目语义一字未变**（既有名单不松动）。
- 不赌"Windows 也已还清"这个本机验不了的结论 —— 在 win32 上该条目仍被双向盯着，那边真转绿门禁照红。

### ⚠️ 一个**未做**的取舍（如实记录）

`filterAllowedForPlatform` 是**收窄断言**的操作。它没有消除"名单腐烂"这个风险，只是把它
**移到了正确的平台上**。若将来 Windows 上也转绿，门禁会在 Windows 上红 —— 那是预期行为，不是新 bug。
- **CP4**（T7 完成，待口径）：闸门单测含误报率反例 —— ✅ **2026-10-08 达成**
  - 误报反例：`test/contentPolicy.test.mjs` 含 **13 条业务形态语料**，实测 **0/13** 误报；另有「已知误报」用例单独钉住"提到凭据文件名"的必然误伤。
  - 闸门单测：**32/32 pass**；落库 fail-closed（`createDraft`/`updateDraft` 命中即抛且一条不落库 / 旧 payload 一字未改）；两闸同口径含三种变异。
  - 独立可跑：`node --test test/contentPolicy.test.mjs`（无需 `--only`）。
  - 口径说明：规则口径按用户决定**只搬 `check-pii.mjs` 已有凭据子集**，业务判据（客户名/案号/未公开技术特征）**未纳入**——那些需用户给判据，猜不得。
