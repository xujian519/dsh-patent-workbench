# 宪法对齐记录（dsh-patent-workbench）

**依据**：[`dsh-PMS/CONSTITUTION.md`](../../dsh-PMS/CONSTITUTION.md) v0.3.0（2026-10-20 批准）
**评估日**：2026-10-20 ｜ **范围**：本仓库（DSH 插件：案卷 / 官文 / 期限 / 任务 / 知识库 / 提醒）
**性质**：工程自评。破例的正式登记册在 `dsh-PMS/docs/exceptions/`，本文件不替代它。

> 宪法附则 B 要求存量代码"首次触碰时逐步对齐；未对齐部分登记破例，不得装作已合规"。
> 本文件按条款列出三态：**已对齐 / 部分对齐 / 未对齐**，每项给出证据或缺口。

---

## 一、本次偿还：EX-2026-001（省略送达方式即按电子送达）

破例原文见 `dsh-PMS/docs/exceptions/EX-2026-001-delivery-mode-default.md`。本仓侧已按偿还计划第 3、4 条完成：

| 动作 | 落点 | 证据 |
|---|---|---|
| 数据库去掉 `DEFAULT 'electronic'`，列改可空 | 迁移 26 `delivery-mode-required` | `test/constitutionDeliveryMode.test.mjs` 第 1 例 |
| 补齐 `delivery_mode` 字典（电子 / 邮寄 / 直接送交 / 公告） | 迁移 26 | 同上 |
| 仓储层省略/空白送达方式 → 中文报错，不落库 | `src/db/repo/matters.ts#createMatterNotice` | 同上第 2 例 |
| 适配层不把缺送达方式的官文送进引擎，转 `pending.requiredInput = 'deliveryMode'` | `src/shared/patentDeadline.ts#buildDeadlineQuery` | `test/patentDeadline.test.mjs`、同上第 3 例 |
| 登记表单不预选送达方式，未选不发请求 | `src/client/noticeDraft.ts`、`NoticeDraftModal.tsx` | `test/noticeDraft.test.mjs` |
| 列表对历史空值显示"送达方式未登记" | `src/client/components/MattersView.tsx` | `test/matterView.test.mjs` / 冒烟用例 |

**同批修掉的相邻默认值**：期限重算原先省略 `today` 时取系统当天（宪法第 4 条、第 13 条之二明令禁止）。
现在 `POST /matters/:id/deadlines/recompute` **要求显式 `today`**，缺失返回 400；工作台界面始终传本地日。
期限适配层同时拒绝**预备案卷**（无申请号）进入计算（第 6 条之一第 3 点），并在响应里点名原因。

> 破例仍保持"待批准/未偿还"状态直到 `dsh-PMS` 侧批准人书面确认——本仓只提供偿还证据，不自行销账。

---

## 二、逐条状态

### 第一章 权威

| 条款 | 状态 | 证据 / 缺口 |
|---|---|---|
| 1 权威层级 | 部分 | 期限只由 `patentDeadline` 服务算出，本仓不写第二份规则；但派生行缺 `rule_version`，回溯链在"规则版本"这一环断开 |
| 2 唯一事实源 | 部分 | 事实库在 `~/.dsh/workbench`；`_matter-log.md` 是案件事件源。**缺口**：`POST /matters/:id/events` 是第二条案件事件写路径，会产生"库内有、日志无"的事件 |
| 2-1 载体登记 | 未 | 无"事实归属登记表"；哪些事实归库、哪些归日志只写在注释里 |
| 3 缺失即不确定 | 已（本仓范围） | 送达方式缺失 → 拒绝或 `pending`；不再有"默认电子送达""默认系统当天" |
| 4 可复算 | 部分 | `today` 显式且写入 `computed_from.today`；缺 `rule_version`，三元组不完整 |
| 5 双时点 | 部分 | 记录时间（`created_at` / `computed_at` / `at`）齐全；业务时间无独立字段，`dispatch_date` 等本身是业务日期 |
| 6 结论唯一 | 部分 | `matter_deadlines` 对 `(matter_id, deadline_key)` 唯一；无 `CONFLICT` 状态与冲突事件模型 |
| 6-1 案卷同一性 | 部分 | `matters.case_number` 唯一；**预备案卷已禁止进入期限计算**（`buildDeadlineQuery`）；**缺口**：`application_no` 不唯一、可被改写、无 13 位校验 |

### 第二章 规则

| 条款 | 状态 | 证据 / 缺口 |
|---|---|---|
| 7 规则即代码 | 部分 | 期限规则只在 sibling 引擎；**缺口**：本仓仍有日期运算（期限看板窗口、导入扫描、客户端格式化），未收敛到 `rules/` |
| 8 法域隔离 | 不适用 | 本仓不实现规则；法域在引擎侧 |
| 9 版本与生效期 | 未 | 无规则版本；包版本（`package.json`）与判定无关 |
| 10 法源证据链 | 不适用 | 规则包在 sibling 仓库；本仓只透传 `legalBasis` |
| 11 规则测试 | 部分 | 本仓测"映射与落库"；规则四项覆盖在 sibling 仓库 |
| 11-1 送达日 | 已（本仓侧） | 显式送达方式；缺参转 `pending`；不再把发文日当送达日 |
| 11-2 费减资格 | 未 | 无费用模块 |
| 11-3 期限双轨与提醒 | 未 | 只有任务提醒；案卷期限**没有**提醒队列、没有法定/内部双日期、没有逾期清单 |
| 12 禁止规则绕过 | 部分 | 引擎软探测 + 明确降级；**缺口**：`matter_deadlines` 无 `rule_version` 非空约束 |
| 12-1 覆盖缺口 | 已 | `calendarCaveat` 原样落 `computed_from` 并随重算响应返回 |
| 13 事实准入 | 未 | 官文直接写正式表，没有 `raw_ingest → confirmed` 两段 |
| 13-1 官文录入与二次核对 | 未 | 无发文序号、无二次核对状态；幂等只到 `(matter, notice_kind)` |
| 13-2 工具入参不补事实 | 部分 | 送达方式、`today` 已修；其余工具仍有可选参数默认（需逐工具删参测试） |
| 14 事件追加 | 部分 | 代码无 UPDATE/DELETE 事件；**缺口**：无数据库触发器兜底 |
| 14-1 案卷目录写入 | 已 | 本插件**只读**案卷目录；`_matter-log.md` 只由外部专用工具写，本仓只做投影 |
| 15 约束下沉 | 部分 | `PRAGMA foreign_keys = ON`、事务边界、单一写入模块；无触发器 |
| 16 迁移前滚 | 已 | 只追加迁移；破坏性迁移前 `VACUUM INTO` 备份并回读校验 |
| 17 派生重建 | 部分 | 期限可按案卷重算；无"删除全部派生层 → 重建 → 校验和"命令 |

### 第三章 数据 / 第四章 组合

| 条款 | 状态 | 证据 / 缺口 |
|---|---|---|
| 18 权限即条款 | 部分 | 库在会话工作区之外（`$DSH_HOME` 同级）；**缺口**：无审计缺口自检 |
| 19 依赖方向 | 部分 | 无独立 domain 层；`src/shared/patentDeadline.ts` 依赖 `src/db/repo/matters.ts`（shared → db），方向偏了 |
| 20 插件契约 | 已 | 通过 `ctx.get` 软探测 `patentDeadline`；不 import sibling 内部实现 |
| 20-1 作用域与软探测 | 已 | 引擎缺失 → 409 明确降级，不自行推算；未进 `inject` |
| 21 可卸载 | 已 | 卸载专利内核后工作台照常启动（默认无期限引擎、登记官文不报错） |
| 22 故障隔离 | 部分 | 事务包裹关键写入；无"插件必抛异常"的固定故障注入测试 |
| 23 无隐式状态 | 未核 | 需要 fork Context 的双实例测试才能下结论 |

### 第五章 效率工具

| 条款 | 状态 | 证据 / 缺口 |
|---|---|---|
| 24 非权威 | 部分 | 草稿有 `created_by`；正式表未统一 `origin = 'llm'` |
| 25 提案—提交 | 已 | `task_drafts` 分表；确认只能由 `actor = 'user'` 执行（`draftConfirmActorProblem`）；确认后有回执 |
| 26 最小上下文 | 部分 | 知识召回按"本任务 > 本案卷 > 全库"；**缺口**：没有客户维度 scope，全库召回可跨客户 |
| 27 全程留痕 | 部分 | 会话 / 召回有日志；期限判定链缺 `rule_version` |
| 28 禁止代决与可降级 | 已 | 期限计算不依赖 LLM；引擎缺失时核心流程仍可用 |

### 第六至八章

| 条款 | 状态 | 证据 / 缺口 |
|---|---|---|
| 29–31 修正与破例 | 不适用 | 批准与破例登记册在 `dsh-PMS` |
| 32 违宪门禁 | 部分 | 本仓测试已覆盖第 3、4、13-2 条（送达方式、判定时点）；沙箱写库、派生重建、无 LLM 端到端、服务降级尚未全部进 CI |
| 33–37 对客账单 | 未 | 本仓无计费/账单模块 |
| 38 完整性自检 | 未 | 无"日志 ↔ 库"重放校验；`POST /events` 的存在使这类缺口可被制造 |

---

## 三、建议的下一批（按风险排序）

1. **P0 · 关掉案件事件的第二条写路径**（第 2 条 / D-8）。删除或封存 `POST /matters/:id/events`，事件只经 `_matter-log.md` 投影；同时补一条"库内事件无对应日志"的只读自检。
2. **P0 · 派生行补 `rule_version`**（第 12 条 / 32-8）。需要引擎在报告里声明规则版本；引擎不声明时，宁可让重算明确失败，也不写空版本。
3. **P1 · 官文事实准入**（第 13 条 / 13-1）。补 `dispatch_serial`（发文序号）+ `confirmed` 二次核对；用 `(申请号, 发文序号)` 做幂等键。
4. **P1 · 案卷身份**（第 6-1 条）。`application_no` 唯一索引 + 一经绑定不可改写；预备案卷禁止重算期限。
5. **P1 · 期限双轨与提醒**（第 11-3 条）。法定届满日 / 内部期限日两条日期；提醒队列只收 `ACTIVE` 且无冲突的义务。
6. **P2 · 结构收敛**（第 7、17、19 条）。把本仓剩余日期运算收进纯模块；提供派生层重建命令；把 `shared → db` 的依赖方向翻正。

---

## 四、验证方式

本次改动后执行：

```sh
pnpm typecheck
pnpm test
```

全量 `node --test`（1362 例）通过；新增用例：

- `test/constitutionDeliveryMode.test.mjs` —— 数据库无默认值、字典齐全、仓储拒绝、适配层 `pending`
- `test/noticeDraft.test.mjs` —— 表单不预选、缺参拒绝、载荷收敛
- `test/patentDeadline.test.mjs` —— 缺送达方式不进引擎；其余官文照常计算
- `test/matters.test.mjs` —— 路由层缺送达方式 400、缺 `today` 400

**未验证**：浏览器端到端（需要在测试实例里重启 DSH 宿主并装载本插件）。本次 UI 改动由组件真渲染冒烟测试
（`test/clientSmoke.test.mjs`）覆盖到"渲染出内容"，未覆盖真实点击与表单原生校验行为。
