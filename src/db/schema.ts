/**
 * dsh-patent-workbench DB schema（对应 docs/DSH个人工作台/01_数据模型.md）
 * 迁移只前向；所有“枚举”都走 dictionaries 表。
 */
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 20

export interface Migration {
  version: number
  name: string
  up(db: DatabaseSync): void
}

const V1_DDL = `
CREATE TABLE dictionaries (
  kind       TEXT NOT NULL,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  builtin    INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, code)
) STRICT;

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  parent_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  type_code         TEXT NOT NULL,
  status_code       TEXT NOT NULL,
  priority_code     TEXT NOT NULL,
  ai_policy_code    TEXT NOT NULL DEFAULT 'consult',
  due_at            TEXT,
  all_day           INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  source            TEXT NOT NULL DEFAULT 'manual',
  archived          INTEGER NOT NULL DEFAULT 0,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  cancelled_at      TEXT
) STRICT;

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_due ON tasks(due_at);
CREATE INDEX idx_tasks_status ON tasks(status_code);
CREATE INDEX idx_tasks_type ON tasks(type_code);
CREATE INDEX idx_tasks_priority ON tasks(priority_code);

CREATE TABLE task_reminders (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  method_code    TEXT NOT NULL DEFAULT 'browser',
  enabled        INTEGER NOT NULL DEFAULT 1,
  fired_at       TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_reminders_task ON task_reminders(task_id);

CREATE TABLE task_drafts (
  id           TEXT PRIMARY KEY,
  kind_code    TEXT NOT NULL DEFAULT 'task',
  session_id   TEXT,
  payload_json TEXT NOT NULL,
  status_code  TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_drafts_session ON task_drafts(session_id);
CREATE INDEX idx_task_drafts_status ON task_drafts(status_code);

CREATE TABLE task_sessions (
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  role_code        TEXT NOT NULL,
  workspace        TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL,
  last_activity_at TEXT,
  PRIMARY KEY (task_id, session_id, role_code)
) STRICT;

CREATE INDEX idx_task_sessions_session ON task_sessions(session_id);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_code  TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL DEFAULT 'user',
  note        TEXT,
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_events_task ON task_events(task_id, at);

-- V2 预留表：复盘与产出物（先建表，UI 后续接）
CREATE TABLE task_reviews (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id   TEXT,
  summary_md   TEXT NOT NULL,
  lessons_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE task_artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    TEXT,
  kind_code     TEXT NOT NULL,
  title         TEXT NOT NULL,
  path          TEXT NOT NULL,
  category_code TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
) STRICT;
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(V1_DDL)
    },
  },
  {
    version: 2,
    name: 'task-workspace-path',
    up(db) {
      db.exec('ALTER TABLE tasks ADD COLUMN workspace_path TEXT')
    },
  },
  {
    version: 3,
    name: 'daily-plans',
    up(db) {
      db.exec(`
        CREATE TABLE daily_plans (
          id          TEXT PRIMARY KEY,
          plan_date   TEXT NOT NULL UNIQUE,
          summary     TEXT NOT NULL DEFAULT '',
          items_json  TEXT NOT NULL DEFAULT '[]',
          source_code TEXT NOT NULL DEFAULT 'ai',
          session_id  TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
  {
    version: 4,
    name: 'task-reports',
    up(db) {
      db.exec(`
        CREATE TABLE task_reports (
          id           TEXT PRIMARY KEY,
          period_code  TEXT NOT NULL,
          period_start TEXT NOT NULL,
          title        TEXT NOT NULL,
          summary_md   TEXT NOT NULL,
          stats_json   TEXT NOT NULL DEFAULT '{}',
          session_id   TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          UNIQUE (period_code, period_start)
        ) STRICT;
        CREATE INDEX idx_task_reports_period ON task_reports(period_code, period_start DESC);
      `)
    },
  },
  {
    version: 5,
    name: 'ai-session-registry',
    up(db) {
      db.exec(`
        CREATE TABLE ai_session_registry (
          scope_code       TEXT NOT NULL,
          anchor           TEXT NOT NULL,
          session_id       TEXT NOT NULL,
          workspace        TEXT,
          note             TEXT,
          created_at       TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          PRIMARY KEY (scope_code, anchor)
        ) STRICT;
        CREATE INDEX idx_ai_session_registry_session ON ai_session_registry(session_id);
      `)
    },
  },
  {
    version: 6,
    name: 'recurring-tasks',
    up(db) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN recurrence_code TEXT;
        ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE tasks ADD COLUMN recurrence_master_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        ALTER TABLE tasks ADD COLUMN recurrence_last_generated TEXT;
        CREATE INDEX idx_tasks_recurrence_master ON tasks(recurrence_master_id);
        CREATE INDEX idx_tasks_recurrence_code ON tasks(recurrence_code);
      `)
    },
  },
  {
    version: 7,
    name: 'knowledge-base',
    up(db) {
      db.exec(`
        CREATE TABLE knowledge_entries (
          id               TEXT PRIMARY KEY,
          kind_code        TEXT NOT NULL DEFAULT 'note',
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_knowledge_kind ON knowledge_entries(kind_code, updated_at DESC);
        CREATE INDEX idx_knowledge_source ON knowledge_entries(source_task_id);
      `)
    },
  },
  {
    version: 8,
    name: 'ideas-and-clusters',
    up(db) {
      db.exec(`
        CREATE TABLE ideas (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          kind_code        TEXT NOT NULL DEFAULT 'spark',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_ideas_kind ON ideas(kind_code, updated_at DESC);

        CREATE TABLE idea_clusters (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          summary_md TEXT NOT NULL DEFAULT '',
          tags_json  TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE idea_links (
          cluster_id TEXT NOT NULL REFERENCES idea_clusters(id) ON DELETE CASCADE,
          idea_id    TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          note       TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (cluster_id, idea_id)
        ) STRICT;
        CREATE INDEX idx_idea_links_idea ON idea_links(idea_id);
      `)
    },
  },
  {
    version: 9,
    name: 'knowledge-source-review',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_review_id TEXT')
    },
  },
  {
    version: 10,
    name: 'task-shared-memory',
    up(db) {
      db.exec(`
        CREATE TABLE task_memories (
          id               TEXT PRIMARY KEY,
          root_task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL DEFAULT 'note',
          content          TEXT NOT NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_task_memories_root ON task_memories(root_task_id, updated_at DESC);
        CREATE INDEX idx_task_memories_task ON task_memories(task_id, updated_at DESC);
      `)
    },
  },
  {
    version: 11,
    name: 'knowledge-file-link',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN file_link TEXT')
    },
  },
  {
    version: 12,
    name: 'reminder-queue',
    up(db) {
      // 微信提醒的待发队列：host 侧调度器把"暂时发不出去"的提醒落库，重启不丢。
      // 不存 botId/targetId —— 目标在发送时解析，用户换投递目标后旧队列自动跟新目标。
      db.exec(`
        CREATE TABLE reminder_queue (
          id              TEXT PRIMARY KEY,
          reminder_id     TEXT,
          root_task_id    TEXT NOT NULL,
          task_id         TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          due_at          TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_reminder_queue_next ON reminder_queue(next_attempt_at, created_at);
        CREATE INDEX idx_reminder_queue_root ON reminder_queue(root_task_id, created_at DESC);
      `)
    },
  },
  {
    version: 13,
    name: 'draft-defer-and-notify',
    up(db) {
      // 验收「暂存」：草稿仍是 pending（确认/驳回两条老路径不变），
      // 只用一个标记让"自动弹窗"那条查询跳过它 —— 用户可以先去跑回归测试，再手动唤回。
      db.exec('ALTER TABLE task_drafts ADD COLUMN deferred_at TEXT')
      db.exec('ALTER TABLE task_drafts ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0')
      // 草稿通知去重：非空表示该草稿已经进过通知队列，不再重复推送。
      db.exec('ALTER TABLE task_drafts ADD COLUMN notified_at TEXT')
    },
  },
  {
    version: 14,
    name: 'draft-notify-queue',
    up(db) {
      // 草稿通知的待发队列（静默时段/汇总/节流导致的延后投递）。
      // 与 reminder_queue 分开：那边是"任务到期提醒"，字段与幂等键都不同。
      db.exec(`
        CREATE TABLE draft_notify_queue (
          id              TEXT PRIMARY KEY,
          draft_id        TEXT NOT NULL UNIQUE,
          kind_code       TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_draft_notify_next ON draft_notify_queue(next_attempt_at, created_at);
      `)
    },
  },
  {
    version: 15,
    name: 'reminder-status-semantics',
    up(db) {
      // 拆开原先由 fired_at 一肩挑的三种语义（历史事故：一条提醒永久停在「待处理」）：
      //   fired_at        —— 已送达/已入队（调度器与队列的幂等键，语义不变）
      //   skipped_at      —— 已判定"太旧"而放弃：终态，不再参与 /reminders/due
      //   acknowledged_at —— 用户点了「知道了」：终态，但可重置
      db.exec('ALTER TABLE task_reminders ADD COLUMN skipped_at TEXT')
      db.exec('ALTER TABLE task_reminders ADD COLUMN acknowledged_at TEXT')
    },
  },
  {
    version: 16,
    name: 'kind-colors',
    up(db) {
      /**
       * 给「知识库分类」与「点子类型」回填出厂颜色。
       *
       * 背景：这两类字典的种子原先写的是空 `config: {}`（任务类型/状态/优先级一直有 color），
       * 而知识库的 Tab 圆点、行前缀点、类型徽标，以及点子卡片的左侧色条都取 `config.color`，
       * 取不到就统一落到灰色兜底 —— 用户看到的现象是「设计稿有颜色，装盘后全灰」。
       *
       * 为什么必须用迁移而不是只改种子：种子只在**首次安装**时 INSERT，已存在的库不会被更新，
       * 现存用户（本机就是）改完种子依然是灰的。
       *
       * 只补**没有 color 的**行：用户若已经自己在「字典管理」里配过色，一律保留。
       * 已重命名/停用的行也照补 —— 颜色与名字无关，缺了就补。
       */
      const DEFAULT_COLORS: Record<string, Record<string, string>> = {
        knowledge_kind: { note: '#4F86F7', lesson: '#E7634C', decision: '#8B7BE8', snippet: '#2E9B7B' },
        idea_kind: { project: '#4F86F7', skill: '#2E9B7B', plugin: '#8B7BE8', spark: '#E7634C', random: '#D98E32' },
      }
      const select = db.prepare('SELECT config FROM dictionaries WHERE kind = ? AND code = ?')
      const update = db.prepare('UPDATE dictionaries SET config = ?, updated_at = ? WHERE kind = ? AND code = ?')
      const at = new Date().toISOString()
      for (const [kind, byCode] of Object.entries(DEFAULT_COLORS)) {
        for (const [code, color] of Object.entries(byCode)) {
          const row = select.get(kind, code) as { config: string } | undefined
          if (row === undefined) continue
          let config: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(row.config) as unknown
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) config = parsed as Record<string, unknown>
          } catch {
            // config 不是合法 JSON（手工改过库）→ 当作空对象，只补颜色这一个字段
          }
          if (typeof config.color === 'string' && config.color.trim() !== '') continue
          update.run(JSON.stringify({ ...config, color }), at, kind, code)
        }
      }
    },
  },
  {
    version: 17,
    name: 'knowledge-recall-log',
    up(db) {
      /**
       * 知识库自动召回的**可观测事实源**。
       *
       * 为什么用表而不是只写日志文件：验收要求「会话/日志里能看到检索了哪些关键词、
       * 命中哪几条、是否被引用」，而这三件事要能**按会话、按时间**回看。
       * 文本日志只能人肉翻，界面/端点查不了的证据等于没有。
       *
       * - `trigger_code`：session_start（开工前）/ turn（回合预取）/ tool（模型主动查）
       * - `skipped_reason` 非空 = **没有检索**（与"检索了零命中"区分开，团队记忆的同一条教训）
       * - `cited_ids_json`：模型回报"用到了哪几条"，于是"是否被引用"可判定
       */
      db.exec(`
        CREATE TABLE knowledge_recall_log (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id        TEXT,
          task_id           TEXT,
          trigger_code      TEXT NOT NULL,
          query             TEXT NOT NULL DEFAULT '',
          terms_json        TEXT NOT NULL DEFAULT '[]',
          hits_json         TEXT NOT NULL DEFAULT '[]',
          matched           INTEGER NOT NULL DEFAULT 0,
          dropped_by_score  INTEGER NOT NULL DEFAULT 0,
          dropped_by_limit  INTEGER NOT NULL DEFAULT 0,
          dropped_as_seen   INTEGER NOT NULL DEFAULT 0,
          injected          INTEGER NOT NULL DEFAULT 0,
          skipped_reason    TEXT,
          cited_ids_json    TEXT NOT NULL DEFAULT '[]',
          created_at        TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_knowledge_recall_session ON knowledge_recall_log(session_id, id DESC);
        CREATE INDEX idx_knowledge_recall_created ON knowledge_recall_log(created_at DESC);
      `)
    },
  },
  {
    version: 18,
    name: 'knowledge-supersede',
    up(db) {
      /**
       * 知识条目的**过期 / 被取代**语义（P2）。
       *
       * 实证（用户 2026-09-17）：删掉一条写错的条目、新建一条修正条，两条并存了一段时间，
       * 而"哪条取代了哪条"**只能靠正文里手写一句"本条修正已入库的另一条"**——
       * 召回时两条都会被带出来，模型没有任何结构化的信号判断该信哪条。
       *
       * - `superseded_by_id`：本条已被哪条取代（非空即在召回时**压制**）。
       * - `valid_until`：有效期截止（ISO 时间；到点后同样压制）。
       *
       * 两条都**不改历史行**（只加列、默认 NULL）：老条目行为完全不变，
       * 直到有人显式标注取代关系。
       */
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN superseded_by_id TEXT')
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN valid_until TEXT')
      db.exec('CREATE INDEX idx_knowledge_superseded ON knowledge_entries(superseded_by_id)')
    },
  },
  {
    version: 19,
    name: 'task-progress-and-plan-effort',
    up(db) {
      /**
       * S1：把「任务显式进度」与「每日计划投入」一次性落进数据模型。
       *
       * ## 为什么进度**只允许 0–99**
       *
       * ADR 0003：`100` 不是可存储的进度，而是「提交完成验收申请」的触发值
       * （与 `workbench_request_completion` 同一条路径，弹框/可暂存/可驳回/留痕）。
       * 「已完成」只能由 `tasks.status_code = done` 表达，写入者只能是用户验收通过
       * 或用户在界面点完成。所以 DDL 的 CHECK 是**最后一道防线**，
       * 路由/工具在它之前就给中文错误（不夹取、不静默改成 99）。
       *
       * ## 为什么旧任务进度一律 0，而不从状态/子任务反推
       *
       * ADR 0004：进度是**显式值**，不由子任务比例派生。存量任务从来没有被任何人
       * 显式写过进度，反推出来的数字（比如"3 个子任务完成 2 个 → 67%"）是系统**编**的，
       * 用户既没说过也无法解释。一律置 0 = 「还没人写」，语义最诚实；
       * done 任务也一样（它已有 status 表达完成，不需要一个假进度）。
       *
       * ## 第二个动作：ai_session_scope/persona 字典
       *
       * S11 的角色绑定要复用现有 `ai_session_registry` 表（scope_code + anchor），
       * 需要一个 `persona` 这个 scope 的字典项。**只在这里加一次** ——
       * 后续子任务不得再开同号或第二个迁移（任务描述明确要求）。
       *
       * ## 第三个动作：旧计划 JSON 的兼容回填
       *
       * `daily_plans.items_json` 是老格式（`{taskId, order, title, note}`）。
       * 本迁移按 requirements §2.1 一次性补齐 `minutes`/`effortDone`，
       * **不改计划表结构**（不需要新列）。
       *
       * 三条硬约束（都来自真实教训：静默丢件与静默改写是禁区）：
       * 1. **合法旧项**：缺 `minutes` 就用"迁移当时该任务的合法预计耗时"，取不到用默认
       *    30 分钟快照填上；缺 `effortDone` 填 `false`。已有合法值**不覆盖**。
       * 2. **保留原字段与原顺序**：只做加法，`taskId`/`order`/`title`/`note` 逐字保留；
       *    未知 taskId 的项照样保留（只补 minutes，不定标题）。
       * 3. **坏数据不猜不删**：`items_json` 不是 JSON / 不是数组 / 项不是对象时，
       *    **原串一个字节都不动**，并输出一条带 `planDate` 的诊断（进度链路的
       *    `GET /plans` 与容量读取会据此报「计划数据无法解析」而不是假装 0）。
       */
      db.exec(`ALTER TABLE tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 99)`)

      const at = new Date().toISOString()
      db.prepare(
        `INSERT OR IGNORE INTO dictionaries (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
         VALUES ('ai_session_scope', 'persona', '角色会话', '{}', 1, 1, 60, ?, ?)`,
      ).run(at, at)

      // 计划回填的默认投入：读设置（meta），缺省 30。与 shared/dailyPlanPolicy 的缺省一致。
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'default_estimate_minutes'").get() as { value: string } | undefined
      const parsedDefault = metaRow === undefined ? Number.NaN : Number(metaRow.value)
      const defaultMinutes = Number.isInteger(parsedDefault) && parsedDefault >= 1 && parsedDefault <= 1440 ? parsedDefault : 30

      const estimateStmt = db.prepare('SELECT estimated_minutes FROM tasks WHERE id = ?')
      const plans = db.prepare('SELECT plan_date, items_json FROM daily_plans').all() as unknown as Array<{ plan_date: string; items_json: string }>
      const updatePlan = db.prepare('UPDATE daily_plans SET items_json = ? WHERE plan_date = ?')
      const diagnostics: string[] = []

      for (const plan of plans) {
        let parsed: unknown
        try {
          parsed = JSON.parse(plan.items_json)
        } catch {
          diagnostics.push(`计划 ${plan.plan_date} 的 items_json 不是合法 JSON，已原样保留（读取时会给「计划数据无法解析」诊断）`)
          continue
        }
        if (!Array.isArray(parsed)) {
          diagnostics.push(`计划 ${plan.plan_date} 的 items_json 不是数组，已原样保留（读取时会给「计划数据无法解析」诊断）`)
          continue
        }
        let changed = false
        const items: unknown[] = []
        for (const raw of parsed) {
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            // 坏项：不猜语义、不删除，原样留在数组里（顺序也不动）。
            items.push(raw)
            diagnostics.push(`计划 ${plan.plan_date} 有一项不是对象，已原样保留`)
            continue
          }
          const item = { ...(raw as Record<string, unknown>) }
          if (!Number.isInteger(item.minutes) || (item.minutes as number) < 1 || (item.minutes as number) > 1440) {
            item.minutes = resolveBackfillMinutes(item.taskId, estimateStmt, defaultMinutes)
            changed = true
          }
          if (typeof item.effortDone !== 'boolean') {
            // 已是 true 之外的任何非布尔值都属于"缺字段"：统一填 false（旧数据没有结束语义）。
            item.effortDone = false
            changed = true
          }
          items.push(item)
        }
        if (changed) updatePlan.run(JSON.stringify(items), plan.plan_date)
      }

      /**
       * 诊断**只写日志、不落库**：迁移时刻的观察结果属于运维信息，
       * 而"这份计划读不出来"是**每次读取都要重新判定**的事实（数据可能被人手工修好）。
       * 库里存一份快照会在修复后变成假的告警。
       */
      if (diagnostics.length > 0) {
        for (const line of diagnostics) console.warn(`[dsh-patent-workbench] migration 19: ${line}`)
      }
    },
  },
  {
    version: 20,
    name: 'patent-matters',
    up(db) {
      /**
       * 专利工作台阶段 2：把「案卷」从"顶层任务 + extra"升级为一等公民实体。
       *
       * 背景（决策 1，见 docs/design/2026-10-03-patent-workbench-redesign.md）：
       * 2026-09-03 的集成用"案件 = 根任务、L1–L5 = 子任务"表达案卷（bridge 工具
       * workbench_link_patent_case），但任务语义（今日/容量/优先级/重复）不适配案卷，
       * 且案卷有大量专属字段（申请号/公开号/申请日/优先权/技术领域/IPC/代理师…）。
       * 现改为 matters 一等实体，bridge 降级为 `_matter-log.md` → `matter_events` 的只读投影。
       *
       * 四条硬约束：
       * 1. **阶段枚举对齐 patent-matter 技能**（open/retrieving/analyzing/drafting/review/closed，
       *    对应 L1–L5）—— 不另造码，避免"同一语义两处实现"。
       * 2. **patent_kind 独立于案型**：无效/侵权案也可能针对发明专利；patent-deadline 的
       *    `patentType` 取它（`invention` / `utility-model` / `design`，逐字对齐不转译）。
       * 3. **notice_kind / delivery_mode 取值逐字对齐 @deepseek-ai/dsh-patent-deadline**，
       *    官文登记表就是它的 `notices` 输入源；阶段 3 由此起算期限。
       * 4. **只加列不改历史**：`knowledge_entries.matter_id` 为可空加法列，老条目行为不变。
       *
       * 字典项在**迁移里插入**而不是只改 seed.ts：seedDictionaries 只对首次安装生效，
       * 存量库（本机 workbench.db 已有 61 条知识）拿不到；迁移 16/19 同此做法。
       */
      db.exec(`
        CREATE TABLE matters (
          id                TEXT PRIMARY KEY,
          case_number       TEXT NOT NULL UNIQUE,
          title             TEXT NOT NULL,
          client_id         TEXT,
          matter_type       TEXT NOT NULL DEFAULT 'drafting',
          patent_kind       TEXT,
          stage_code        TEXT NOT NULL DEFAULT 'open',
          application_no    TEXT,
          publication_no    TEXT,
          patent_no         TEXT,
          filing_date       TEXT,
          priority_date     TEXT,
          claims_priority   INTEGER NOT NULL DEFAULT 0,
          is_pct_national   INTEGER NOT NULL DEFAULT 0,
          ipc               TEXT,
          tech_field        TEXT,
          inventors         TEXT,
          applicant         TEXT,
          attorney          TEXT,
          workspace_path    TEXT,
          closed_at         TEXT,
          extra             TEXT NOT NULL DEFAULT '{}',
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_matters_stage ON matters(stage_code, updated_at DESC);
        CREATE INDEX idx_matters_client ON matters(client_id);

        CREATE TABLE matter_notices (
          id                TEXT PRIMARY KEY,
          matter_id         TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
          notice_kind       TEXT NOT NULL,
          dispatch_date     TEXT NOT NULL,
          delivery_mode     TEXT NOT NULL DEFAULT 'electronic',
          delivery_date     TEXT,
          designated_months INTEGER,
          file_link         TEXT,
          note              TEXT,
          created_at        TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_matter_notices_matter ON matter_notices(matter_id, dispatch_date DESC);

        CREATE TABLE matter_deadlines (
          id            TEXT PRIMARY KEY,
          matter_id     TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
          deadline_key  TEXT NOT NULL,
          label         TEXT NOT NULL,
          due_date      TEXT NOT NULL,
          due_date_raw  TEXT NOT NULL,
          basis         TEXT,
          status        TEXT NOT NULL DEFAULT 'pending',
          computed_at   TEXT NOT NULL,
          computed_from TEXT NOT NULL DEFAULT '{}',
          UNIQUE (matter_id, deadline_key)
        ) STRICT;
        CREATE INDEX idx_matter_deadlines_due ON matter_deadlines(due_date);

        CREATE TABLE matter_events (
          id         TEXT PRIMARY KEY,
          matter_id  TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
          action     TEXT NOT NULL,
          artifact   TEXT,
          approver   TEXT,
          note       TEXT,
          at         TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_matter_events_matter ON matter_events(matter_id, at);
      `)

      // 知识条目关联案卷（只加列，老条目 NULL，行为不变）。
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN matter_id TEXT')
      db.exec('CREATE INDEX idx_knowledge_matter ON knowledge_entries(matter_id)')

      const at = new Date().toISOString()
      const insert = db.prepare(
        `INSERT OR IGNORE INTO dictionaries (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      )
      /** 案型（做什么案子）。 */
      const matterTypes: Array<[string, string, string]> = [
        ['drafting', '撰写案', '#4F86F7'],
        ['oa_response', '审查意见答复案', '#F39C12'],
        ['search', '检索案', '#2E9B7B'],
        ['patentability', '专利性分析案', '#6C5CE7'],
        ['invalidation', '无效宣告案', '#E74C3C'],
        ['reexamination', '复审案', '#E67E22'],
        ['infringement', '侵权比对案', '#8B7BE8'],
        ['annuity', '年费维持案', '#16A085'],
        ['other', '其他', '#95A5A6'],
      ]
      /** 阶段（对齐 patent-matter 六态 / L1–L5）。 */
      const matterStages: Array<[string, string, string]> = [
        ['open', '建案', '#4F86F7'],
        ['retrieving', '检索中', '#2E9B7B'],
        ['analyzing', '分析中', '#6C5CE7'],
        ['drafting', '撰写中', '#F39C12'],
        ['review', '门禁/审批中', '#E67E22'],
        ['closed', '归档', '#2E9B7B'],
      ]
      /** 专利类型：逐字对齐 patent-deadline 的 PatentKind。 */
      const patentKinds: Array<[string, string, string]> = [
        ['invention', '发明专利', '#E74C3C'],
        ['utility-model', '实用新型专利', '#2980B9'],
        ['design', '外观设计专利', '#8B7BE8'],
      ]
      /** 官文种类：逐字对齐 patent-deadline 的 NoticeKind。 */
      const noticeKinds: Array<[string, string, string]> = [
        ['office-action-first', '第一次审查意见通知书', '#F39C12'],
        ['office-action-subsequent', '后续审查意见通知书', '#E67E22'],
        ['substantive-exam-notice', '实质审查通知书', '#4F86F7'],
        ['rejection-decision', '驳回决定', '#E74C3C'],
        ['grant-notice', '授予专利权通知书', '#2E9B7B'],
        ['reexamination-notice', '复审通知书', '#6C5CE7'],
        ['invalidation-transfer', '无效宣告转送文件', '#8B7BE8'],
      ]
      const groups: Array<[string, Array<[string, string, string]>]> = [
        ['matter_type', matterTypes],
        ['matter_stage', matterStages],
        ['patent_kind', patentKinds],
        ['notice_kind', noticeKinds],
      ]
      for (const [kind, items] of groups) {
        items.forEach(([code, name, color], index) => {
          insert.run(kind, code, name, JSON.stringify({ color }), (index + 1) * 10, at, at)
        })
      }
    },
  },
]

/**
 * 迁移回填用的「这条计划项该记多少分钟」。
 *
 * 顺序：任务当前合法预计耗时 → 设置里的默认投入 → 30。
 * 未知 taskId（任务已删除）同样走这个顺序（拿不到估时 → 默认），**不定标题、不丢项**。
 */
function resolveBackfillMinutes(
  taskId: unknown,
  estimateStmt: { get(id: string): unknown },
  defaultMinutes: number,
): number {
  if (typeof taskId === 'string' && taskId !== '') {
    const row = estimateStmt.get(taskId) as { estimated_minutes: number | null } | undefined
    const estimated = row?.estimated_minutes ?? null
    if (typeof estimated === 'number' && Number.isInteger(estimated) && estimated >= 1 && estimated <= 1440) return estimated
  }
  return defaultMinutes
}
