/**
 * 出厂字典种子。INSERT OR IGNORE：首次安装写入，之后用户改名/停用不会被覆盖。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface DictionarySeed {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  sortOrder: number
}

export const DICTIONARY_SEEDS: DictionarySeed[] = [
  // 任务类型
  { kind: 'type', code: 'client_meeting', name: '客户交流', sortOrder: 10, config: { color: '#4F86F7', defaultAiPolicy: 'consult', defaultReminderMinutes: 30 } },
  { kind: 'type', code: 'code_impl', name: '代码实现', sortOrder: 20, config: { color: '#2E9B7B', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'feature_opt', name: '功能优化', sortOrder: 30, config: { color: '#6C5CE7', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'solution_design', name: '方案设计', sortOrder: 40, config: { color: '#F39C12', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'boss_request', name: '老板要求', sortOrder: 50, config: { color: '#E74C3C', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'team_mgmt', name: '团队管理', sortOrder: 60, config: { color: '#16A085', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'project_delivery', name: '项目交付', sortOrder: 70, config: { color: '#2980B9', defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'personal', name: '个人生活', sortOrder: 80, config: { color: '#95A5A6', defaultAiPolicy: 'none', excludeFromReport: true } },
  { kind: 'type', code: 'training', name: '培训学习', sortOrder: 90, config: { color: '#8E44AD', defaultAiPolicy: 'consult' } },

  // 状态
  { kind: 'status', code: 'backlog', name: '待规划', sortOrder: 10, config: { category: 'open', color: '#95A5A6' } },
  { kind: 'status', code: 'todo', name: '待办', sortOrder: 20, config: { category: 'open', color: '#3498DB' } },
  { kind: 'status', code: 'doing', name: '进行中', sortOrder: 30, config: { category: 'active', color: '#F39C12' } },
  { kind: 'status', code: 'blocked', name: '被阻塞', sortOrder: 40, config: { category: 'active', color: '#E74C3C', risk: true } },
  { kind: 'status', code: 'done', name: '已完成', sortOrder: 50, config: { category: 'terminal', color: '#2E9B7B' } },
  { kind: 'status', code: 'cancelled', name: '已取消', sortOrder: 60, config: { category: 'terminal', color: '#7F8C8D' } },

  // 优先级
  { kind: 'priority', code: 'p0', name: '紧急', sortOrder: 0, config: { weight: 0, color: '#E74C3C', defaultReminderMinutes: 15, meaning: '今天必须处理，不处理会阻塞主线或造成损失' } },
  { kind: 'priority', code: 'p1', name: '高', sortOrder: 1, config: { weight: 1, color: '#F39C12', defaultReminderMinutes: 60, meaning: '本周内必须完成，影响承诺/关键路径' } },
  { kind: 'priority', code: 'p2', name: '普通', sortOrder: 2, config: { weight: 2, color: '#3498DB', defaultReminderMinutes: 1440, meaning: '按计划推进，时间可协商' } },
  { kind: 'priority', code: 'p3', name: '低', sortOrder: 3, config: { weight: 3, color: '#95A5A6', defaultReminderMinutes: null, meaning: '有空再做，允许顺延或取消' } },

  // AI 策略
  { kind: 'ai_policy', code: 'none', name: '不允许', sortOrder: 10, config: { allowedV1: true } },
  { kind: 'ai_policy', code: 'consult', name: '可咨询', sortOrder: 20, config: { allowedV1: true, default: true } },
  { kind: 'ai_policy', code: 'execute', name: '可执行', sortOrder: 30, config: { allowedV1: false } },

  // 会话角色
  { kind: 'session_role', code: 'clarify', name: '需求澄清', sortOrder: 10, config: {} },
  { kind: 'session_role', code: 'consult', name: '咨询', sortOrder: 20, config: {} },
  { kind: 'session_role', code: 'breakdown', name: '拆解', sortOrder: 30, config: {} },
  { kind: 'session_role', code: 'review', name: '复盘', sortOrder: 40, config: {} },
  { kind: 'session_role', code: 'execute', name: '执行', sortOrder: 50, config: { allowedV1: false } },

  // 草稿类型 / 草稿状态 / 提醒方式
  { kind: 'draft_kind', code: 'task', name: '单个任务', sortOrder: 10, config: {} },
  { kind: 'draft_kind', code: 'subtask_plan', name: '子任务提案', sortOrder: 20, config: {} },
  { kind: 'draft_kind', code: 'completion', name: '执行完成验收', sortOrder: 30, config: {} },
  { kind: 'draft_kind', code: 'review', name: '复盘确认', sortOrder: 40, config: {} },
  { kind: 'draft_kind', code: 'daily_plan', name: '今日计划', sortOrder: 50, config: {} },
  { kind: 'draft_kind', code: 'knowledge', name: '知识条目', sortOrder: 70, config: {} },

  // 知识库分类
  // ⚠️ 颜色是**字典数据**（用户可在「设置 → 字典管理」里改），不是 UI 里的硬编码调色板。
  // 出厂值必须带 color：第一版留空 `{}`，于是知识库的 Tab 圆点 / 行前缀点 / 类型徽标
  // 全落到同一个灰色兜底 —— 用户看到的就是「设计稿有颜色、装盘后没有」。
  { kind: 'knowledge_kind', code: 'note', name: '笔记', sortOrder: 10, config: { color: '#4F86F7' } },
  { kind: 'knowledge_kind', code: 'lesson', name: '经验教训', sortOrder: 20, config: { color: '#E7634C' } },
  { kind: 'knowledge_kind', code: 'decision', name: '决策记录', sortOrder: 30, config: { color: '#8B7BE8' } },
  { kind: 'knowledge_kind', code: 'snippet', name: '片段/模板', sortOrder: 40, config: { color: '#2E9B7B' } },
  /**
   * 专利域分类（阶段 5 · 决策 5.2.2，2026-10-03）。**纯数据**，用户可在
   * 「设置 → 字典管理 → 知识库类型」里改名/改色/停用 —— 名字与颜色都不是产品逻辑。
   *
   * 为什么用 snake_case 而不是中文码：`dictionaries.code` 有校验 `/^[a-z][a-z0-9_]*$/`
   *（`repo/dictionaries.ts`），中文码进不去；而 code 是**稳定标识**（召回过滤、工具入参、
   * 日志都拿它），名字才是给人看的，所以名字用中文。
   */
  { kind: 'knowledge_kind', code: 'exam_standard', name: '审查尺度', sortOrder: 50, config: { color: '#C4553D' } },
  { kind: 'knowledge_kind', code: 'reply_strategy', name: '答复策略', sortOrder: 60, config: { color: '#3D7FB0' } },
  { kind: 'knowledge_kind', code: 'search_experience', name: '检索经验', sortOrder: 70, config: { color: '#6E9E3F' } },
  { kind: 'knowledge_kind', code: 'client_preference', name: '客户偏好', sortOrder: 80, config: { color: '#B07CC6' } },
  { kind: 'knowledge_kind', code: 'notice_template', name: '官文模板', sortOrder: 90, config: { color: '#C08A2E' } },
  { kind: 'knowledge_kind', code: 'rejection_lesson', name: '驳回教训', sortOrder: 100, config: { color: '#4C9E9E' } },

  /**
   * `recurrence` 出厂字典（不重复/每天/每周/每月）已随重复任务域删除
   * （阶段 4 · D/E 片）。老库里的那 4 行由迁移 22 置为 `active = 0`（停用而非删除），
   * 新库不再种 —— 两边都不留"永远选不到的选项"。
   */

  // V2 复用型 AI 会话范围
  { kind: 'ai_session_scope', code: 'daily_plan', name: '今日计划会话', sortOrder: 10, config: {} },
  { kind: 'draft_status', code: 'pending', name: '待确认', sortOrder: 10, config: {} },
  { kind: 'draft_status', code: 'confirmed', name: '已确认', sortOrder: 20, config: {} },
  { kind: 'draft_status', code: 'abandoned', name: '已放弃', sortOrder: 30, config: {} },
  { kind: 'reminder_method', code: 'browser', name: '浏览器通知', sortOrder: 10, config: {} },
  { kind: 'reminder_method', code: 'os', name: '系统通知', sortOrder: 20, config: { allowedV1: false } },
]

/**
 * 出厂字典。**每次开库都跑**（`index.ts#apply` 紧接着 `openWorkbenchDb`），
 * `INSERT OR IGNORE` 语义，三件事已实测（2026-10-03，`node scripts/repro` 一次性验证）：
 *
 * 1. **存量库会拿到新增的 code** —— 删掉一行再 seed 会回来；所以往这里加字典项
 *    不需要额外迁移。
 * 2. **不会重新激活用户停用过的行**（`active=0` 保持 0）—— 这正是"停用"该有的语义。
 * 3. **不覆盖用户改过的名字/颜色/排序**（行已存在 → IGNORE）。
 *
 * ⚠️ 迁移 20 的注释里写着"seedDictionaries 只对首次安装生效"——**那句话与代码不符**
 *（上面第 1 条就是反例）。它当时想说的应该是第 2、3 条：对**必须存在**的 code
 *（例如引擎要校验的值域），迁移里显式插入更稳妥，因为用户可能把那条停用过。
 */
export function seedDictionaries(db: DatabaseSync, now: string = new Date().toISOString()): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO dictionaries
      (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
  `)
  db.exec('BEGIN')
  try {
    for (const seed of DICTIONARY_SEEDS) {
      insert.run(seed.kind, seed.code, seed.name, JSON.stringify(seed.config), seed.sortOrder, now, now)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
