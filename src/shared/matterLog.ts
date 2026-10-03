/**
 * `_matter-log.md` → 案卷事件 的**解析层**（阶段 6 · bridge 收口）。
 *
 * ## 格式的权威源不在本仓
 *
 * 格式由 DSH Patent 的 `patent-matter` 技能定义（`packages/bundle/web-app/skills/patent/patent-matter/SKILL.md`
 * §「事件日志（_matter-log.md，只追加）」）：每条记录五个字段，
 * **管道分隔**、只追加、禁止覆写或删除历史行：
 *
 * ```
 * 2026-08-19T21:00:00+08:00 | 建案 | patent-workspace/CN2026-0001/ 目录骨架 | 用户 | 交底书已入 00-交底书/
 * 2026-08-19T21:15:00+08:00 | 检索 | 01-检索/2026-08-19_硅基负极.md | 用户(检索式确认) | 命中 D1/D2
 * ```
 *
 * 字段：时间（ISO）/ 动作（建案·检索·分析·撰写·门禁·交付·归档）/ 产物 / 审批人 / 备注（可选）。
 * 本模块**只读不写** —— 案卷目录里的 `_matter-log.md` 是唯一事实源，
 * `matter_events` 只是它的投影（决策 D1）。所以这里没有"写回"的入口，一行都没有。
 *
 * ## 两条纪律（决定了这个模块长什么样）
 *
 * 1. **宁可少解析，也不猜**：字段少于两个（时间+动作）的行**不进事件**，
 *    而是进 `skipped` 并带上原因与行号 —— 静默丢弃会让用户以为"我明明记过这条"。
 * 2. **脚手架不算异常**：空行、Markdown 标题、围栏、引用块、水平线是**文档结构**，
 *    静默忽略但计数（`ignored`），否则每个带表头的文件都会报一堆"未解析"。
 *
 * 时间戳**原样保留**（不重写成统一格式）：日志里带 `+08:00` 偏移是**信息**
 * （它记录了当事人当时所在时区），抹掉它等于篡改事实源。
 */

/** 一条解析出来的事件（字段与 `matter_events` 一一对应，`id` 由仓储层生成）。 */
export interface MatterLogEvent {
  /** 原始时间串（ISO，可能带偏移）——**原样保留**，见文件头。 */
  at: string
  action: string
  artifact: string | null
  approver: string | null
  note: string | null
}

/** 一行"看起来是记录、但用不了"的原始文本。 */
export interface MatterLogSkipped {
  /** 1 起的行号（人对着文件找得到）。 */
  line: number
  text: string
  reason: string
}

export interface MatterLogParse {
  events: MatterLogEvent[]
  skipped: MatterLogSkipped[]
  /** 被当作文档脚手架忽略的行数（空行/标题/围栏/引用/水平线）。 */
  ignored: number
}

/** 围栏行（``` / ~~~）：进/出代码块。 */
function isFence(line: string): boolean {
  return line.startsWith('```') || line.startsWith('~~~')
}

/** 脚手架行：Markdown 结构，不是记录。 */
function isScaffold(line: string): boolean {
  return line === ''
    || line.startsWith('#')
    || line.startsWith('>')
    || isFence(line)
    || /^[-*_]{3,}$/.test(line)
    || /^\|?\s*-{2,}\s*\|/.test(line)          // Markdown 表格分隔行
    || line.startsWith('| 时间') || line.startsWith('时间 |') // 表头（有人会加）
}

function field(parts: readonly string[], index: number): string | null {
  const value = (parts[index] ?? '').trim()
  return value === '' ? null : value
}

/**
 * 解析一份 `_matter-log.md`。
 *
 * 容错范围（逐条都能自证）：
 * - 管道数 2–5 都收（产物/审批人/备注可缺），**多出的管道归进备注**（备注里写 `|` 是常见事，
 *   截断反而丢信息）；
 * - **围栏内的内容整块忽略**：`patent-matter` 技能文档里就是用 ``` 包着示例行的 ——
 *   若有人把那段示例粘进真实日志，逐行解析会把"示例"当成"真发生过的事"写进库。
 *   宁可少导入（围栏里本来就不该放真记录），也不制造假事件；
 * - CRLF 与 BOM 都处理（Windows 上写出来的日志）；
 * - 时间串必须能被 `Date.parse` 解析 —— 不能的行**直接跳过并报原因**（不猜一个"今天"）；
 * - 动作必填。
 */
export function parseMatterLog(content: string): MatterLogParse {
  const events: MatterLogEvent[] = []
  const skipped: MatterLogSkipped[] = []
  let ignored = 0
  const body = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : ''
  const lines = body.split(/\r?\n/)
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const lineNo = index + 1
    if (isFence(line)) { inFence = !inFence; ignored += 1; continue }
    if (inFence) { ignored += 1; continue }
    if (isScaffold(line)) { ignored += 1; continue }
    if (!line.includes('|')) {
      skipped.push({ line: lineNo, text: line, reason: '不是记录行：缺少字段分隔符 `|`（时间 | 动作 | 产物 | 审批人 | 备注）' })
      continue
    }
    const parts = line.split('|')
    const at = (parts[0] ?? '').trim()
    const action = (parts[1] ?? '').trim()
    if (at === '') {
      skipped.push({ line: lineNo, text: line, reason: '缺少时间（第一段为空）' })
      continue
    }
    if (!Number.isFinite(Date.parse(at))) {
      skipped.push({ line: lineNo, text: line, reason: `时间无法解析：${at}` })
      continue
    }
    if (action === '') {
      skipped.push({ line: lineNo, text: line, reason: '缺少动作（第二段为空）' })
      continue
    }
    // 多余的分段并回备注：备注里写 `|` 是常事，截断会丢信息
    const note = parts.length > 5 ? parts.slice(4).map((part) => part.trim()).filter((part) => part !== '').join(' | ') : field(parts, 4)
    events.push({ at, action, artifact: field(parts, 2), approver: field(parts, 3), note: note === '' ? null : note })
  }
  return { events, skipped, ignored }
}

/**
 * 幂等键：`at + 动作 + 产物`。
 *
 * 为什么不用整行：**审批人/备注后补**是常见操作（日志只追加，所以"补充说明"往往写在
 * 稍后的一行里），把它们算进键会让"同一条记录被重新导入"看起来像新事件。
 * 时间+动作+产物这三者的组合在真实日志里已经足够唯一（同一时刻同一动作同一产物 = 同一条）。
 */
export function matterLogEventKey(event: { at: string; action: string; artifact: string | null }): string {
  return `${event.at}\u0000${event.action}\u0000${event.artifact ?? ''}`
}
