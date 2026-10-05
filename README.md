# dsh-patent-workbench

[![license](https://img.shields.io/github/license/xujian519/dsh-patent-workbench)](./LICENSE)
[![repo](https://img.shields.io/badge/repo-xujian519%2Fdsh--patent--workbench-blue)](https://github.com/xujian519/dsh-patent-workbench)

**面向专利律师 / 代理人的 DSH（DeepSeek Harness）工作台插件**（fork 自
[Dely0/dsh-personal-workbench](https://github.com/Dely0/dsh-personal-workbench)）。

> 🚧 **改造进行中**：本仓库正从通用「日历 + 层级任务 + 知识库」工作台改造为**专利律师工作台**
> （管理/办公层：案卷 · 期限 · 官文登记 · 客户 · 办案沉淀库；专业判定检索/三性/撰写/答复/无效
> 留给专利内核 DSH Patent）。分阶段方案与决策见
> [`docs/design/2026-10-03-patent-workbench-redesign.md`](docs/design/2026-10-03-patent-workbench-redesign.md)。
>
> **现状**：阶段 0–4 已落地（改名、案卷四表 + REST、期限引擎接入与**期限看板**、
> 删除通用功能——日报周报 / 点子 / 容量 / 重复任务），阶段 5 的案卷视图 / 知识库加法已落地。
> 数据全部留在本机。

[English](#english) · 简体中文

![今日](screenshot/%E4%BB%8A%E6%97%A5%E4%BB%BB%E5%8A%A1.PNG)

| 日历 | 快速录入 | 知识库 |
|---|---|---|
| ![日历](screenshot/%E6%97%A5%E5%8E%86%E5%8A%9F%E8%83%BD.png) | ![快速录入](screenshot/%E5%BF%AB%E9%80%9F%E5%BD%95%E5%85%A5.png) | ![知识库](screenshot/%E7%9F%A5%E8%AF%86%E5%BA%93.png) |

## 亮点

- 🗂️ **案卷（一等实体）**：案号 / 申请号 / 公开号 / 申请日 / 优先权要求 / 技术领域…一屏管全；
  案卷详情带**时间线**（案件事件 ∪ 官文 ∪ 期限，三源合一）
- 📥 **扫描导入案卷**：扫一遍本机工作目录树 → 按线索分档列出候选（目录名带申请号或含
  `_matter-log.md` 的进高置信）→ 逐条补案号与发明名称 → 一次落库。**只读目录、不打开文件、
  不改动你的目录**；分档只是排序，三档都能展开勾选（机器猜的绝不替你做决定）
- 📄 **官文登记 → 期限**：登记官文（发文日 / 送达方式 / 指定期限）作为**起算输入**，
  期限由 DSH Patent 的 `patentDeadline` 引擎算出后落库（可复算、可申诉；引擎缺失时明确降级，不自行推算）
- ⏳ **期限看板**：今日视图看**跨案卷的近 7 天到期**（含已过期）；案卷详情里可重算、可标记完成/免除
- 📅 **日历（周/月）+ 树状任务列表**；「今日」「日历」「任务」三视图，筛选排序可组合、保留父子层级
- ✨ **自然语言快速录入** → AI 澄清后生成任务；支持贴图与 PDF/DOCX 附件，不收的文件逐条给原因
- 🧠 **每个任务关联多个 AI 会话**：澄清 / 咨询 / 拆解 / 执行 / 复盘
- 🎭 **专家人格（角色库）**：三级来源（用户库 > 外部目录 > 内置 15 篇）；会话前选定，正文按需加载、不进提示词
- ✅ **「AI 申请完成 → 用户验收」闭环**；进度是显式值，AI 不能靠进度把任务标完成（ADR 0003/0004）
- 🗓️ **每日计划**：AI 排序提案（按优先级/到期/预计耗时排候选）→ 确认才生效；「今日投入结束」≠ 任务完成（ADR 0007）
- 🎯 **会话前选 Skill / 模型 / 角色**，提示词自动注入「加载这些技能」
- ⏰ **到期提醒**：页内横幅 + 系统通知；可选微信通道（需 `@xmanrui/dsh-im`）
- 📚 **知识库（专利域分类）**：审查尺度 / 答复策略 / 检索经验 / 客户偏好 / 官文模板 / 驳回教训…；
  条目可**归入案卷**，该案卷目录下的会话召回时按「本任务 > 本案卷 > 全库」优先
- 🔒 **数据只在本机** `~/.dsh/workbench`，不上传任何服务器

## 安装

前置：**DSH ≥ `0.1.5-rc.1`**（Web 版）、Node `^22.19.0` 或 `>=24.0.0`、pnpm `>=11.7.0 <12`。

```sh
dsh plugin --profile web add git+https://github.com/xujian519/dsh-patent-workbench.git
```

> ⚠️ **装完必须重启 `dsh web`，只刷新浏览器不够**：客户端 bundle 由宿主在**启动时**读进内存，
> 刷新拿到的是旧代码。升级/回退同理。

其它装法：

```sh
# GitHub 源码
dsh plugin --profile web add git+https://github.com/xujian519/dsh-patent-workbench.git
# Release tarball
dsh plugin --profile web add file:/path/to/dsh-patent-workbench-<version>.tgz
```

## 快速上手

1. 侧栏点「工作台」打开面板；
2. 「快速录入」说一句话 → AI 澄清 → 确认建任务；
3. 任务详情点「AI 执行」→ 在会话里干活 → 完成后回面板**验收**；
4. 「今日」看待办，需要时点「AI 智能排序」排今天的顺序；「日历」按天回看与排期。

## 兼容性

| 项 | 要求 | 拿不到时 |
|---|---|---|
| **面板本体**（官方槽位 + `layout.selectPanel`） | **DSH `0.1.5-rc.1+`** | **面板整块不启动**并打一条可读日志（刻意不降级） |
| 服务端能力：任务/日历/知识库/案卷/期限、提醒、`workbench_*` 工具 | `0.1.0-rc.6+` | — |
| 会话绑定 `sessions.retain()` | `0.1.7-rc.2+` | 旧宿主自动回落 `sessions.binding()` |
| Skill 选择器 | 宿主 `skills` 注册表 | 选择器隐藏 |
| 微信提醒 | 可选插件 `@xmanrui/dsh-im` | 静默降级为页内提醒 + 系统通知 |

**最低支持版本是 `0.1.5-rc.1`，这是硬边界。** 为什么低于它选择"明确不启动"而不是降级、
以及 0.2.0 引入的插件兼容性预检（peer 区间为什么写成并列区间）：
见 [`docs/releases/v1.15.8.md`](docs/releases/v1.15.8.md) 与
[`docs/design/2026-09-13-client-architecture-official-only.md`](docs/design/2026-09-13-client-architecture-official-only.md)。

## 开发

```sh
git clone https://github.com/xujian519/dsh-patent-workbench.git
cd dsh-patent-workbench
pnpm install
pnpm check                 # 类型检查 + 构建
pnpm test                  # 全量回归（跑构建产物）
pnpm build && pnpm dev:install   # 装盘到本机 profile（装完重启 dsh web）
```

| 文档 | 用途 |
|---|---|
| [`.dsh/skills/dsh-plugin-change/`](.dsh/skills/dsh-plugin-change/SKILL.md) | **改代码前先读**：架构硬约束、本项目的编码规范与回归防线 |
| [`.dsh/skills/dsh-release/`](.dsh/skills/dsh-release/SKILL.md) | **发版前先读**：公开发布的硬门禁与命令序列（范围表、变异探针、PII 两面、tag/npm/Release、**发布成功判据**） |
| [`docs/release-checklist.md`](docs/release-checklist.md) | 发版前自检清单（可勾选版） |
| [`scripts/release-preflight.mjs`](scripts/release-preflight.mjs) | **发布门禁一键跑**：typecheck → 单测 → 全探针（每步 build）→ PII 两面 → 版本/文档；`--phase post` 做 tarball 与 sha1 对账、用户视角安装、Release 复核 |
| [`scripts/dev-verify.mjs`](scripts/dev-verify.mjs) | 研发版本验收链：构建 → 装盘 → 隔离实例重启 → 浏览器套件 → 证据包 |
| [`docs/issues/`](docs/issues/) | 滚动维护的已知问题与待办 |
| [`docs/adr/`](docs/adr/) | 已冻结的口径决策（进度、角色、验收链、每日投入） |

## 版本历史

| 版本 | 要点 |
|---|---|
| **1.17.0** | **案卷目录扫描导入**：指向一个工作根目录 → 扫描出候选案卷（高 / 中 / 其余三档，带证据），勾选后批量落库（同批重复与库内重复都不重复建）；扫描**只读盘不落库**，深度上限 5、超限显式 `truncated`。夹带**深度审计批次 1–6**：安全与路径闸门唯一处、DB 安全网（一致快照备份 + 坏库拒开 + 事务）、客户端轮询门控、客户端模块真执行、变异探针安全化、**验收链在 macOS / Linux 上跑得通**。⚠️ schema 无变化（仍 23）。详见 [`docs/releases/v1.17.0.md`](docs/releases/v1.17.0.md) |
| 1.16.4 | 知识草稿字段名有了**唯一口径**：`content_md` / `source_task_id` 这类工具参数名（snake_case）当作别名认下来 —— 修掉「建得出、确认不了」的死草稿（用户实测 `操作失败：knowledge requires content`，弹窗还看不到正文）；建草稿时缺 `title`/`contentMd` **当场 400**（中文原因 + 列出本次 payload 的键），不再静静躺在「待处理」里。详见 [`docs/releases/v1.16.4.md`](docs/releases/v1.16.4.md) |
| **1.16.3** | 侧栏入口文案由「打开工作台（任务 / 日历 / 知识库）」统一为「**专利工作台**」（与面板内标题一致）；会话标题栏入口按钮的 `title` 收敛到 `ENTRY_TITLE` 单一来源。详见 [`docs/releases/v1.16.3.md`](docs/releases/v1.16.3.md) |
| **1.16.2** | 日期面板补**「逾期」/「未排期」两个任务页签**（无截止、没排期、非进行中的任务终于有归宿，「未排期」= 补集：三页签并集恰好是全部未完成）+ 这两个页签的行内**「排入今日」**；统计卡「逾期」口径统一到**当日 00:00**（与页签同一把尺子）。详见 [`docs/releases/v1.16.2.md`](docs/releases/v1.16.2.md) |
| 1.16.1 | AI 会话工作区**双模式**（已有工作区下拉 + 文件夹弹框）；「今日」与「日历」收敛为**同一个日期面板**（计划/已完成/报告三页签，树口径＝当日到期 ∪ 当日计划项 ∪ 进行中，逐条标来源）；构建期类型源对齐 DSH `0.2.0-rc.2`。详见 [`docs/releases/v1.16.1.md`](docs/releases/v1.16.1.md) |
| 1.16.0 | 任务进度（显式值、AI 不能靠进度完成）+ 专家人格角色库（三级来源 / 15 篇内置）+ 研发版本验收链。⚠️ schema 18 → 19。详见 [`docs/releases/v1.16.0.md`](docs/releases/v1.16.0.md) |
| 1.15.8 | 适配 DSH `0.2.0-rc.1` 的插件兼容性预检（peer 改**并列区间**，下界不动） |
| 1.15.7 | 快速录入模型选择死锁 + rc.2 系统通知失败被吞（两处 P0） |
| 1.15.6 | 补齐 `0.1.7-rc.2` 上「当前会话」读取的三处静默 `undefined` |
| 1.15.5 | 适配 `0.1.7-rc.2`：会话绑定/打开、标题栏让位、侧栏量宽、工作区静默丢件 |
| 1.15.3 | 合入社区三项修复（提醒漏建 / 投递目标缓存 / 复用会话陈旧引用） |
| 1.15.2 | 模型浮层遮挡、默认工作区被任务污染、容量账本透明化、知识库 Tab 化、知识自动召回 |
| 1.15.1 | 任务资料夹改 `<任务ID>-<标题片段>`、快录附件（图片/PDF/DOCX）、模型选择器、`/workbench` 命令 |
| 1.14.57 | 架构重构：面板可见性唯一权威源、删除 DOM 降级腿、能力门槛「明确不启动」 |
| 更早 | 完整发行说明见 [`docs/releases/`](docs/releases/) |

## 路线图

- [x] 客户端 `WorkbenchApp` 拆分（H4-1…H4-9 已完成；拆分成果由
      [`test/workbenchAppBudget.test.mjs`](test/workbenchAppBudget.test.mjs) 的行数 / hook 数预算断言钉住，
      施工图与账本在 [`docs/tasks/h4-split-workbench-app/`](docs/tasks/h4-split-workbench-app/)）
      - ⚠️ **预算余量已见底**（2026-10-05 实测：`WorkbenchApp` 本体 **3445/3450** 行、
        整个 `index.tsx` **4877/4900** 行、`useState` 与 `useEffect` 都是 **0 余量**）。
        任务树已经收敛成"一次构建 + 派生视图"（v1.17.0），但**下一块该搬的 `startAISession`（431 行）
        还没搬** —— 下一个正常功能会先撞红测试，届时的正确动作是**先拆再抬上界**，
        不要直接放宽：见 [`docs/issues/2026-10-05-深度审计.md`](docs/issues/2026-10-05-深度审计.md) §4.4
- [x] 客户端模块**真执行**覆盖（2026-10-05）：此前 **38 个 src 模块从不被任何测试 import、
      其中 37 个在 `src/client/`**（11 个弹窗、6 个视图骨架、入口与 HTTP 出口全在内），
      那层的"保护"只是对 `index.tsx` 的**源码字符串扫描**。现在 `test/clientSmoke.test.mjs`（35 例）
      + `test/clientModules.test.mjs`（17 例）把每个组件**真渲染一次**、把入口契约**真跑一遍**，
      并按审计 §附录 A 的脚本重测到 **0 个从不被加载的模块**。
      ⚠️ 这条覆盖证明的是"代码被执行过 + 产出该有的东西"，**不证明** DOM 行为/交互正确
      （弹窗 portal 在测试里是就地渲染的）：见
      [`docs/issues/2026-10-05-深度审计.md`](docs/issues/2026-10-05-深度审计.md) §4.1
- [x] **发布门禁自己不再可能污染发布产物**（2026-10-05）：变异探针必须改写工作区才能证明断言有牙
      （4 个探针里 3 个改 `src/`、1 个**只改 `lib/`**），此前仅靠 `finally` 还原 —— `SIGKILL`/断电/
      构建失败分支都可能把变异体留在盘上，而残留的 `src/` 会被下一次构建**烘焙进 `lib/`**、
      残留的 `lib/` 更是**直接随包发出**。现在：写前备份到 `_local-build/mutation-backup/` +
      `SIGINT`/`SIGTERM`/异常/`exit` 六条路径还原 + **被强杀后下次启动自动恢复**，
      门禁在整批前后对 `src` + `lib` **逐字节核对指纹**，所有命令都有墙钟上限、
      探针调用不经 shell。证据（真信号 / 真仓库 / 门禁双向 red-green）见
      [`docs/releases/v1.17.0.md`](docs/releases/v1.17.0.md) §3.9 与
      [`docs/issues/2026-10-05-深度审计.md`](docs/issues/2026-10-05-深度审计.md) §4.3。
      ⚠️ `SIGKILL` 本身拦不住（只能"下次恢复"）；指纹只覆盖 `src` 与 `lib`
- [x] **研发验收链在 macOS / Linux 上跑得通了**（2026-10-06）：以前 `findPortOwner` 在非 Windows 上一律拒绝，
      而 restart 是必需阶段 —— 于是**在 macOS 开发机上整条链必然停在 restart**，
      后面的 health / token / 白名单套件（全部浏览器判据）一个都跑不到。现在：POSIX 端口归属走
      `lsof` + `ps`（进程名**只认 `node`**，桌面端 `DSH Patent` 会被拦下并实测确认没被杀）、
      停机走 `SIGTERM` 并**等它真的退出**（不静默 SIGKILL）、`--launcher` 走 `sh <launcher>`
      （启动器必须自己返回），dsh 入口发现覆盖三类真实装法；本机做不到时记 **`blocked`：
      下游照跑、退出码 2、绝不报绿**（"拒绝 kill / 停不掉旧进程"则是硬停，一个套件都不跑）。
      CI 加零依赖关卡 `node scripts/check-verify-scripts.mjs`。证据见
      [`docs/releases/v1.17.0.md`](docs/releases/v1.17.0.md) §3.10 与
      [`docs/issues/2026-10-05-深度审计.md`](docs/issues/2026-10-05-深度审计.md) §4.2。
      ⚠️ CI **仍然不跑浏览器套件**；macOS 上"整链端到端"仍缺一套隔离 profile + 独立 DB 的供给流程
- [ ] **数据导出**（*导入*已随 v1.17.0 落地：案卷目录扫描导入，见
      [`docs/releases/v1.17.0.md`](docs/releases/v1.17.0.md)；**导出仍无任何入口**
      —— 备份只在破坏性迁移前自动发生，用户没有自助导出 / 恢复的通道）
- [ ] 任务拖拽排序
- [ ] 定时自动化、多端同步（各自单独立项）

## 致谢

- **[@Guojing6](https://github.com/Guojing6)** —— v1.15.1 的多项能力源自其 fork
  [`Guojing6/dsh-workbench`](https://github.com/Guojing6/dsh-workbench)：任务资料夹改用任务 ID、
  快录附件、模型选择器、`/workbench` 斜杠命令、请求围栏加固；并定位了两个我们一直带着的真 bug。
- **[@SnowNight777](https://github.com/SnowNight777)** —— v1.15.3 的三项修复全部来自其报告
  （issue [#4](https://github.com/Dely0/dsh-personal-workbench/issues/4) /
  [#5](https://github.com/Dely0/dsh-personal-workbench/issues/5) /
  [#7](https://github.com/Dely0/dsh-personal-workbench/issues/7) 与 PR
  [#6](https://github.com/Dely0/dsh-personal-workbench/pull/6) /
  [#8](https://github.com/Dely0/dsh-personal-workbench/pull/8)）。
- [@tujunwenjie](https://github.com/tujunwenjie)、[@lhmhz](https://github.com/lhmhz) —— issue 诊断报告。
- **内置角色库**含两个 MIT 上游（`novotnyllc/dotnet-artisan`、`K-Dense-AI/scientific-agents`）的领域角色，
  完整署名与「我们改了什么」见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

逐项来源与许可证见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 免责声明

社区项目，与 DeepSeek 官方无关，不提供任何担保。安装即表示你信任该代码会以你的 DSH 用户权限在本机运行；执行类 AI 操作可能修改工作区文件、消耗 API 额度，请先阅读代码并谨慎使用。

## License

[MIT](./LICENSE)。部分 DOM 挂载模式与客户端构建包装参考了 `dsh-task-board`（BSD-3-Clause）与 `dsh-genui`（MIT），详见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

---

# English

**A personal workbench plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)** —
turn DSH into a calendar + hierarchical task list + AI assistant workbench. All data stays on your machine.

## Highlights

- 🗂️ **Matters as first-class entities**: case number / application no. / publication no. / filing date / priority claim / technical field — plus a **timeline** merging case events, office notices and deadlines
- 📄 **Notice registration → deadlines**: register office notices (dispatch date / delivery mode / designated months) as the *starting point*; deadlines are computed by the DSH Patent `patentDeadline` engine and stored (recomputable, contestable; explicit degradation when the engine is absent — never guessed locally)
- ⏳ **Deadline board**: cross-matter "due within 7 days" (overdue included) on the Today view; recompute and mark done/waived per matter
- 📅 Calendar (week/month) + tree task list; Today / Calendar / Tasks views with combinable filters that keep parent-child structure
- ✨ Natural-language quick capture → AI clarification → task created; images and PDF/DOCX attachments supported
- 🧠 Multiple AI sessions per task: clarify / consult / breakdown / execute / review
- 🎭 **Personas**: three-tier library (user > external dir > 15 built-ins), picked per session, loaded on demand (never inlined into the prompt)
- ✅ "AI requests completion → you accept" loop; progress is an explicit value the AI cannot use to complete a task
- 🗓️ Daily plan: AI proposes an order (candidates ranked by priority/due/estimate), only your confirmation applies it; "done for today" ≠ task completed
- 🎯 Pick Skill / model / persona before each AI session; prompt gets a "load these skills" instruction
- ⏰ Due reminders (in-panel banner + system notification), optional WeChat channel via `@xmanrui/dsh-im`
- 📚 **Knowledge base with patent-domain kinds**: examination standards / reply strategies / search experience / client preferences / notice templates / rejection lessons; entries can be **filed into a matter**, and recall in that matter's workspace ranks "this task > this matter > whole library"
- 🔒 Local-only storage at `~/.dsh/workbench`

## Install

Requires **DSH ≥ `0.1.5-rc.1`** (web), Node `^22.19.0` or `>=24.0.0`, pnpm `>=11.7.0 <12`.

```sh
dsh plugin --profile web add git+https://github.com/xujian519/dsh-patent-workbench.git
# or from a release tarball:
dsh plugin --profile web add file:/path/to/dsh-patent-workbench-<version>.tgz
```

> ⚠️ **You must restart `dsh web` after installing** — the client bundle is read into memory at host startup, so a browser refresh keeps serving the old code.

## Compatibility

| | Requirement | If missing |
|---|---|---|
| **Panel** (official slots + `layout.selectPanel`) | **DSH `0.1.5-rc.1+`** | Panel **refuses to start** and logs a readable reason (deliberately not degraded) |
| Server-side features (tasks, reminders, `workbench_*` tools) | `0.1.0-rc.6+` | — |
| Session binding via `sessions.retain()` | `0.1.7-rc.2+` | Falls back to `sessions.binding()` on older hosts |
| WeChat reminders | optional `@xmanrui/dsh-im` | Falls back to in-panel + system notifications |

## Development

```sh
pnpm install && pnpm check && pnpm test
```

Read [`.dsh/skills/dsh-plugin-change/`](.dsh/skills/dsh-plugin-change/SKILL.md) before changing code and
[`.dsh/skills/dsh-release/`](.dsh/skills/dsh-release/SKILL.md) before publishing; a tick-box version of the
release checklist lives in [`docs/release-checklist.md`](docs/release-checklist.md), and the automated
verification chain in [`scripts/dev-verify.mjs`](scripts/dev-verify.mjs).

## Credits & License

Community project, not affiliated with DeepSeek; provided as-is. External contributions and bundled
MIT-licensed persona sources are listed in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
Licensed under [MIT](./LICENSE).
