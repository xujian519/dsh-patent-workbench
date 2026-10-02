# 专利工作台改造方案（dsh-personal-workbench → dsh-patent-workbench）

> 状态：**阶段 2 已完成**（阶段 0 定案与阶段 1 改名、阶段 2 案卷均已落地；阶段 3 起待做）。
> 相关既有工作（另一仓库）：
>
> - `deepseek-harness/docs/dsh-workbench-integration-design.md`（2026-09-03 工作台↔专利案件集成，Phase 1–5）
> - `deepseek-harness/.agents/notes/implemented/architecture/2026-09-03-workbench-case-bridge.{md,zh.md}`
> - 本仓知识库设计权威源：`docs/design/2026-09-17-knowledge-recall.md`

## 0. 实施进度

| 阶段 | 状态 | 落地内容 / 提交 |
| --- | --- | --- |
| 0 建模定案 | ✅ | 本文件（提交 `4d60464`） |
| 1 改名 | ✅ | `dsh-patent-workbench`：包名 / cordis id / PANEL_NAME / 模块 id / 仓库 URL / README；**刻意保留** DOM 前缀 `data-dsh-personal-workbench-*` 与数据目录 `~/.dsh/workbench/`（提交 `662f335`） |
| 2 领域字典 + matters | ✅ | 迁移 20：`matters` / `matter_notices` / `matter_deadlines` / `matter_events` + `knowledge_entries.matter_id` + 四类领域字典；`db/repo/matters.ts`（CRUD + 校验）与 `api/routes/matters.ts`（REST）；`test/matters.test.mjs` 9 例 |
| 3 期限引擎接入 | ◐ | **DSH Patent 侧已完成**（`deepseek-harness` 分支 `feat/patent-deadline-service`）：`patent-deadline` 新增 `provideService` / `exposeTool` 两个 Config 开关，profile 根域多注册一行即发布 `patentDeadline` 服务（不是新建包）；工作台侧已完成软探测 + `shared/patentDeadline.ts`（案卷/官文 → 引擎入参、报告 → 期限行，唯一映射处）+ `POST /api/workbench/matters/:id/deadlines/recompute`，引擎缺失时 409 明确降级。**待做**：期限看板 UI（归到阶段 5）与实机装盘 |
| 4 删除通用功能 | ⬜ | 点子 / 容量 / 日报周报 / 重复任务 + `DROP TABLE`（D4） |
| 5 知识库加法 + UI | ⬜ | `matter_id` 关联、新 kind、本案卷优先；案件视图 / 期限看板 |
| 6 bridge 收口 | ⬜ | `workbench_link_patent_case` → `_matter-log.md` → `matter_events` 只读投影 |

已落地的额外事实（供阶段 3 核对）：`matter_notices.notice_kind` / `delivery_mode` 与 `matters.patent_kind` 的值域**逐字**取自 `@deepseek-ai/dsh-patent-deadline` 的 `NoticeKind` / `DeliveryMode` / `PatentKind`，起算时无需翻译层；`replaceMatterDeadlines` 重算时会保留用户已确认的期限状态（done / waived）。

阶段 3 的取数口已按 B′ 的低成本变体落地（2026-10-03 决定，替代原先的“独立新包”）：**不新建包**，`patent-deadline` 自已被 profile 根域多注册一行（`{ provideService: true, exposeTool: false }`）即发布 `patentDeadline` 服务。理由：`adding-a-package` 门禁（tsconfig aggregate、README Model Experience/limitations、locale 对 + 翻译记录、逐文件 100% 覆盖率、工具目录重生成）的成本远超这条缝，而包装包自身没有任何逻辑。只有重复的 loader entry **id** 是致命错误，同名插件注册两行是常态。

## 1. 目标与边界

把本插件（通用「日历 + 层级任务 + 知识库 + AI 会话」）改造为**专利律师/代理人工作台**：

- **只做管理/办公层**：案件、期限、官文登记、客户、办案沉淀库、提醒、AI 会话编排。
- **不做专业判定**：检索、三性、撰写、答复、无效的逻辑留在专利内核（DSH Patent / `packages/patent/*`），本工作台不重复实现、不回写。
- **知识库设计完整保留**（第 5 节为保留清单）。

### 唯一权威源（写死，防止"同一语义两处实现"）

| 事实 | 权威源 | 本工作台角色 |
| --- | --- | --- |
| 法定期限计算（期限起算、送达、届满日顺延） | `@deepseek-ai/dsh-patent-deadline`（DSH Patent） | 只存事实与状态，调服务计算 |
| 案件审计链 | `patent-workspace/<案号>/_matter-log.md` | `matter_events` 是**只读投影** |
| 案件阶段状态机 | `patent-matter` 技能（`open/retrieving/analyzing/drafting/review/closed`，L1–L5） | 字典 `matter_stage` 对齐同一枚举 |
| 专利权威知识库（判例/法规/指南/图谱） | `knowledge.db`（只读） | 不并库；本库只放**办案沉淀** |
| 办案沉淀条目 | 本工作台 `knowledge_entries` | 保留其全部设计，仅做加法 |

## 2. 现状（已核实的既成事实）

### 2.1 工作台与专利案件之间已有集成（2026-09-03）

- bridge 工具 `workbench_link_patent_case`（`packages/patent/patent-tools/src/tool/`），经 **HTTP** 写 `/api/workbench/*`；约定 **案件 = 根任务，L1–L5 = 子任务**；投影**单向**：`_matter-log.md` → `case.db`。
- **冲突点**：本方案的 `matters` 表把"案件"升级为一等公民实体，与"案件=根任务"重叠 → 由 D1 定案：**原生 `matters` 取代 bridge 的实体映射**，bridge 降级为 `_matter-log.md` → `matter_events` 的投影器。

### 2.2 本机同一插件两套并存（版本/库都不同）

| Profile | 版本 | DB | schema | 数据 |
| --- | --- | --- | --- | --- |
| `web` | 1.9.0 (+ patch) | `~/.dsh/workbench/case.db` | 14 | 6 任务、0 知识 |
| `web-wb` | 1.9.0 | `case.db` | 14 | 集成测试用 |
| `desktop-runtime` | **1.15.8** | `~/.dsh/workbench/workbench.db` | **18** | 14 任务、**61 条知识**、65 草稿 |

- **真实知识资产在 `workbench.db`（v1.15.8 / desktop）**。改名 + 换库名若不迁移，表现为"知识库空了"。
- 待删的 4 张表（`ideas` / `idea_clusters` / `idea_links` / `task_reports`）在两库均为 **0 行** → 删除零数据损失。

### 2.3 期限能力（DSH Patent）核实结论

`@deepseek-ai/dsh-patent-deadline` v0.2.0-rc.2（`packages/patent/patent-deadline/`）：

- **纯函数库 API**：`periodEnd` / `resolveDeliveryDate` / `WorkCalendar.rollForward` / `evaluateDeadlines(query, options)` / `renderDeadlineReport`。
- **一个模型工具** `patent_deadlines`；**不提供 cordis 服务**；**不读写案件文件**（通知逐次传入）。
- 输入：`patentType` + `filingDate` + `claimsPriority`（必填，**优先权是声明非推断**）、`priorityDate` / `isPctNationalPhase` / `authorizationPublicationDate` / `restDayRule`、`notices[]`（发文日/送达方式/指定期限月数）。
- 产出：每条期限的**报告用届满日 + 期限自身届满日 + 剩余天数 + 状态 + 法条依据** + 「待补」清单 + 逾期恢复提示。
- 限制：节假日日历仅覆盖 2025–2026（超出年份返回未顺延 + `calendarCaveat`）；恢复/延长只作提示行。

**两条集成障碍（已核实）**：

1. `@deepseek-ai/dsh-patent-deadline` **不在 npm 上**（`npm view` 404）→ 不能作 npm 依赖安装。
2. patent preset 内的服务是 **entry-local realm**（`isolate: patentData/patentKnowledge/patentWorkflow/patentTeams/patentRuleGate`）→ preset 内 `provide` 的服务对 profile 根域的工作台**不可见**。

→ 结论：**服务必须由核心树里、注册在 profile 根域的插件提供**（见第 4 节 B′）。

## 3. 决策记录（用户 2026-10-03 拍板）

| # | 决策 | 结论 |
| --- | --- | --- |
| 决策 1 | 案件实体 | **新建 `matters` 表**（不用"顶层任务 + extra"） |
| 决策 2 | 期限能力 | **调用 DSH Patent 的期限能力**；机制定为 **B′**（见第 4 节） |
| 决策 3 | 插件边界 | **只做管理/办公层**；专业判定留专利内核 |
| 决策 4 | 通用功能 | **删除**点子 / 容量 / 日报周报（+ 重复任务） |
| 决策 5 | 知识库扩展 | 加 `knowledge_kind` 字典 + `knowledge_entries.matter_id`（按建议） |
| 决策 6 | 改名 | **`dsh-patent-workbench`** |
| D1 | 原生 matters vs bridge | **原生 `matters` 取代 bridge 实体映射**；bridge 降级为投影器 |
| D2 | 期限集成机制 | **服务（软探测）**，非直接 import |
| B′ | 服务落点 | **`patent-deadline` 自已被 profile 根域再注册一行**（`{ provideService: true, exposeTool: false }`），由两个 Config 开关控制；**不新建包**（2026-10-03 修订，见第 4 节） |
| D3 | 工具前缀 | **保留 `workbench_*`**（不动 bridge / persona / 421 条测试） |
| D4 | 删除的表 | **B：追加迁移 `DROP TABLE` + 彻底清理痕迹**；迁移前自动备份 |

## 4. B′：期限服务的落地形态

**实际落地（2026-10-03 修订：改用低成本变体，不新建包）**：

```text
@deepseek-ai/dsh-patent-deadline          ← 同一个包，两种挂载角色
  preset 行（原样）                        config 缺省：provideService=false / exposeTool=true → 只有工具
  profile 根域第二行                        config: { provideService: true, exposeTool: false } → 只发布服务
```

- **单一权威源不变**：两行加载同一份 `evaluateDeadlines` / `WorkCalendar` / 随包日历资产，服务只是纯函数的直通。
- **可见性成立**：profile 根域服务与 `webServer` / `tools` 同级，工作台（`inject: ['webServer','systemPrompt','tools']`）可见。
- **工具作用域不变**：`patent_deadlines` 仍只在专利模式会话出现（preset 行）；根域那行不注册工具。
- **为何不必新包**：原先记的「必须是独立新包：同一插件 id 不能两处注册」不成立——实证是**只有重复的 loader entry `id` 才致命**（本机 2026-09-19 因两处 `mcp-cnlaw` 重复 entry id 而 Electron 启动失败），同名插件名重复出现在 presets 里是常态（`dsh-persona` / `dsh-agent-preset` 等 10+ 个）。而新包要过 `adding-a-package` 全套门禁（tsconfig aggregate、README Model Experience/limitations、locale 对 + 翻译记录、逐文件 100% 覆盖率、工具目录重生成），远超这条缝的收益；包装包自身无任何逻辑。
- **配置开关而非新包**：`provideService` / `exposeTool` 两个可选字段，默认值使存量部署行为**逐位不变**。
- **工作台侧**：`ctx.get('patentDeadline')` 软探测（本仓规范第 8 节"可选增强"）；**拿不到时降级**——重算端点返回 `409` 并说明“期限引擎不可用，请手工录入”，不静默、也绝不自己实现第二份期限口径。
- **代价（如实记）**：仍需动 `deepseek-harness` 仓库（一个包的两处小改 + profile 加一行 + 重打包桌面 App）。
- **数据外发**：期限计算是**本地纯函数**，零外送（符合"不新增数据出口"约束）。

服务对外接口（实际落地）：

```ts
interface PatentDeadlineService {
  evaluate(query: DeadlineQuery, options?: { reminderLeadDays?: number }): DeadlineReport
  periodEnd(start: CalendarDate, period: Period): CalendarDate
  resolveDeliveryDate(request: DeliveryRequest): DeliveryDate
  describePatentKind(kind: PatentKind): string
  calendarCoverage(): { years: number[] }   // 供界面标注"该年份日历未覆盖"
}
```

日期以 `{ year, month, day }` 对象跨边界（引擎的 `CalendarDate`），消费者不必再解析一次日历；`evaluate` 的 `today` 由调用方给定，保证落库报告可复现（引擎从不读宿主时钟）。工作台侧的结构镜像在 `src/shared/patentDeadline.ts`（含 `buildDeadlineQuery` / `reportToDeadlineRows`），是全仓唯一一处案卷→引擎、引擎→期限行的映射。

## 5. 知识库：零改动 + 只做加法（决策 5）

### 5.1 绝对不动（保留清单）

`src/shared/knowledgeRecall.ts`（打分/阈值/闸门）、`src/knowledge-recall.ts`（接线/时机/去重）、`src/knowledge-recall-log.ts`、`src/knowledge-tools.ts`、`src/api/knowledgeRecallRoute.ts`、`src/db/repo/knowledge.ts`、`docs/design/2026-09-17-knowledge-recall.md`；以及取代/过期语义、`file_link` 溯源、知识库 UI 的分类 Tab / 关键词搜索 / 标签筛选 / 排序 / 分页 / 时间分组。

**命中公式、阈值刻度（`minScore=0.33`、`hintScore=0.20`）、两档闸门、日志口径一律不改。**

### 5.2 只做加法

1. 迁移新增 `knowledge_entries.matter_id TEXT`（与 `source_task_id` **并存**，老条目 `NULL`，行为不变）。
2. `knowledge_kind` 字典扩充：`审查尺度` / `答复策略` / `检索经验` / `客户偏好` / `官文模板` / `驳回教训`（纯数据，设置页可改）。
3. 召回候选集：把"本任务/本任务树优先"扩成"**本案卷优先**"（**只动候选集排序**，不动打分/阈值/闸门/日志）。

## 6. 领域模型（决策 1）

迁移追加（`SCHEMA_VERSION` 只前向）：

```sql
CREATE TABLE matters (
  id               TEXT PRIMARY KEY,
  case_number      TEXT NOT NULL UNIQUE,   -- 内部案号，如 2026-UM-002
  title            TEXT NOT NULL,          -- 发明名称
  client_id        TEXT,                   -- 客户
  matter_type      TEXT NOT NULL,          -- 字典 matter_type
  stage_code       TEXT NOT NULL,          -- 字典 matter_stage（对齐 patent-matter 六态）
  application_no   TEXT,
  publication_no   TEXT,
  patent_no        TEXT,
  filing_date      TEXT,
  priority_date    TEXT,
  claims_priority  INTEGER NOT NULL DEFAULT 0,  -- patent-deadline 必填且不推断
  is_pct_national  INTEGER NOT NULL DEFAULT 0,
  ipc              TEXT,
  tech_field       TEXT,
  inventors        TEXT,
  applicant        TEXT,
  attorney         TEXT,
  workspace_path   TEXT,                   -- patent-workspace/<案号>/
  closed_at        TEXT,
  extra            TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE matter_notices (              -- 官文登记 = patent-deadline 的 notices 输入源
  id                TEXT PRIMARY KEY,
  matter_id         TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  notice_kind       TEXT NOT NULL,         -- office-action-first / -subsequent / authorization / rejection / reexamination-notice / invalidation
  dispatch_date     TEXT NOT NULL,         -- 发文日
  delivery_mode     TEXT NOT NULL DEFAULT 'electronic',
  delivery_date     TEXT,                  -- 实际送达日（可空）
  designated_months INTEGER,               -- 指定期限月数
  file_link         TEXT,                  -- 官文 PDF（复用现有 file_link 机制）
  created_at        TEXT NOT NULL
) STRICT;

CREATE TABLE matter_deadlines (            -- patent-deadline 计算结果落库（可重算）
  id            TEXT PRIMARY KEY,
  matter_id     TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  deadline_key  TEXT NOT NULL,
  label         TEXT NOT NULL,
  due_date      TEXT NOT NULL,             -- 报告用届满日（法定顺延口径）
  due_date_raw  TEXT NOT NULL,             -- 期限自身届满日（不顺延口径）
  basis         TEXT,                      -- 法条依据
  status        TEXT,                      -- pending / done / overdue / waived / calendar-uncovered
  computed_at   TEXT NOT NULL,
  computed_from TEXT NOT NULL DEFAULT '{}',-- 计算输入快照（可复算/可申诉）
  UNIQUE (matter_id, deadline_key)
) STRICT;

CREATE TABLE matter_events (               -- _matter-log.md 的只读投影
  id         TEXT PRIMARY KEY,
  matter_id  TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,                -- 建案/检索/分析/撰写/门禁/交付/归档
  artifact   TEXT, approver TEXT, note TEXT, at TEXT NOT NULL
) STRICT;

-- 加法：知识条目关联案卷
ALTER TABLE knowledge_entries ADD COLUMN matter_id TEXT;
```

**阶段字典必须对齐 `patent-matter`**：`open / retrieving / analyzing / drafting / review / closed`（对应 L1–L5），不另造码。

**关键设计点**：

- `claims_priority` 独立列 —— patent-deadline 明确不推断优先权，半填案卷必须报错而非静默改变起算日。
- `matter_deadlines.computed_from` 存计算输入快照 —— 期限可复算、可申诉。
- 期限**不用 `tasks` 表达**（期限是 `all_day` 日期，不是任务）；看板直接读 `matter_deadlines`。

## 7. 删除清单（决策 4 + D4）

按本仓纪律：**删前列调用点清单、阶段独立、迁移只前向**。

| 域 | 删除面 |
| --- | --- |
| 点子 | `db/repo/ideas.ts`、`api/routes/ideas.ts`、`idea-clusters.ts`、`client/components/IdeaCardGrid.tsx`、tab；工具 `workbench_propose_idea_clusters` / `workbench_submit_idea_tasks` |
| 容量 | `client/capacity.ts`、`CapacityRulePanel.tsx`、`test/capacity*.test.mjs` |
| 日报周报 | `api/routes/reports.ts`、`db/repo/reports.ts`、report 视图；工具 `workbench_submit_report` |
| 重复任务 | `recurrence` 相关分支与字典（年费由期限引擎承担） |

**表**（D4=B，`DROP TABLE`）：`ideas` / `idea_clusters` / `idea_links` / `task_reports`（两库实测 0 行）。
**字典**：`idea_kind`、`draft_kind:idea_cluster/idea_tasks/report`、`ai_session_scope:idea_*/day_report/week_report`、`recurrence` —— 除删种子外，追加迁移显式停用已有行（`active=0`），否则 UI 仍可选到。
**安全网**：迁移前整库备份（复用 `~/.dsh/workbench/backups/`）。

## 8. 改名与数据迁移（决策 6）

1. 改名：`package.json.name` → `dsh-patent-workbench`；`dsh` 前端 id、cordis id `personal-workbench` → `patent-workbench`；README 与文档同步。**工具前缀保留 `workbench_*`（D3）**。
2. **数据目录不跟着改名**（`~/.dsh/workbench/`）—— 改名即等于知识库"消失"。若必须改，提供一次性迁移脚本（备份 → `wal_checkpoint(TRUNCATE)` → 移动 → 复验 61 条）。
3. **两套安装收敛**：以 `desktop-runtime` 的 **v1.15.8 / `workbench.db`（schema 18，61 条知识）** 为数据正本；`web@1.9.0 / case.db` 是集成测试遗留。
4. 迁移只前向：库比插件新时仍走既有 `applyDegraded()` 降级路径。

## 9. 分阶段路线图（每阶段独立提交/验收）

| 阶段 | 内容 | 依赖 | 主要风险 |
| --- | --- | --- | --- |
| **0 建模定案** | 本文件评审 + 决策拍板（不改代码） | — | 0 |
| **1 改名 + 迁移** | 改名 `dsh-patent-workbench`；两库收敛到 `workbench.db`；现有测试全绿 | 0 | 数据迁移 |
| **2 领域字典 + matters** | 迁移（`matters`/`matter_notices`/`matter_deadlines`/`matter_events` + `knowledge_entries.matter_id`）；matter repo/routes；案件 CRUD | 1 | 迁移 |
| **3 期限引擎接入** | B′ 服务；官文登记 → 起算 → `matter_deadlines`；期限看板 + 提醒接通 | 2, B′, DSH Patent 侧 | **最高** |
| **4 删除通用功能** | 点子/容量/日报周报/重复任务 的代码 + 表 + 字典 + 测试清理 | 2, D4 | 中 |
| **5 知识库加法 + UI** | `matter_id` 关联、新 kind、本案卷优先；案件视图/时间线；域名词替换 | 2,3 | 中 |
| **6 bridge 收口** | `workbench_link_patent_case` 降级为 `_matter-log.md` → `matter_events` 投影器 | 5, D1 | 中 |

**跨仓库任务（`deepseek-harness`）**：已完成——`patent-deadline` 新增 `provideService` / `exposeTool` 两个 Config 开关 + `src/service.ts`；在 `web` / `desktop-runtime` profile 根域再注册一行（**不是新建包**）已过 `tsc -b tsconfig.host.json`、包内 76 例、翻译配对 / Agent Note / 配置与 cordis 目录门禁。

## 10. 风险与已知限制

| 风险 | 应对 |
| --- | --- |
| 双账本（原生 matters 与 bridge） | D1：bridge 降级为只读投影；`matters` 唯一实体 |
| 期限结果与真实到期不符 | 计算权威在 patent-deadline；`computed_from` 留快照可申诉；界面标注日历未覆盖年份 |
| 服务缺失（纯 `dsh web`） | 软探测 + 明确降级（手工录入 + 说明原因），不静默 |
| 数据迁移丢知识资产 | 迁移前备份；以 `workbench.db` 为正本；复验 61 条 |
| `DROP TABLE` 不可逆 | 迁移前自动备份（D4） |
| 跨仓库版本漂移 | service 包与 deadline 包同仓同版本；profile 行显式 |
| 知识库召回退化 | 召回内核零改动；加法仅候选集排序与字典（回归测试须保持 421+ 通过） |

## 11. 明确不做

- 不复制期限/费用规则到本工作台（唯一权威源在 DSH Patent）。
- 不把 `knowledge.db` 并入本库；本库不承载案卷原文（原文在 `patent-workspace/<案号>/`）。
- 不改知识库召回打分公式/阈值/闸门/日志口径。
- 不实现"工作台 → 案件文件"的反向写入。
- 不新增数据出口（期限计算本地；云端模型仅用于公开材料）。

## 12. 待办 / 未决

- [x] 阶段 1 前置：已 `git clone upstream`（v1.16.2 + 完整历史）→ `upstream` 仅 fetch、`origin` = `xujian519/dsh-patent-workbench`；`pnpm install` / 构建 / 回归均可跑。
- [x] DSH Patent 侧 B′ 的接口定稿：`evaluate` / `periodEnd` / `resolveDeliveryDate` / `describePatentKind` / `calendarCoverage`；日期以 `CalendarDate` 对象跨边界。
- [ ] 部署：把 `deepseek-harness` 分支 `feat/patent-deadline-service` 合入并重打包桌面 App，然后在 `~/.dsh/profiles/{web,desktop-runtime}/cordis.patch.yml` 根域加 `{ id: patent-deadline-service, name: '@deepseek-ai/dsh-patent-deadline', config: { provideService: true, exposeTool: false } }`。
- [ ] 案号 vs 工作目录：`patent-workspace/<案号>/` 与用户既有 `/Users/xujian/工作/` 目录的关系（`workspace_path` 可配置，不硬编码）。
- [ ] 官文 PDF 字段抽取（发文日/官文类型）是走 AI 草稿门禁还是人工录入（阶段 3 决定）。
- [ ] 服务缺失时的降级粒度：整块期限看板隐藏，还是保留手工录入（倾向后者）。
