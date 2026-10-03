/**
 * 知识草稿 `payload` 的**字段名归一化 + 准入判定**（唯一实现）。
 *
 * ## 为什么有这一层（2026-10-03 用户实测缺陷：`操作失败：knowledge requires content`）
 *
 * `POST /api/workbench/drafts` 是插件自己写进工具说明与界面提示的**官方绕行口**
 * （「一个会话只产出 1 条知识」时的多草稿通道），但那段说明只给了外层形状
 * `{"kindCode":"knowledge","payload":{...}}`，**没给 payload 的字段名**。
 *
 * 于是调用方（模型）照着 `workbench_submit_knowledge` 的**工具参数名**填：
 * `content_md` / `source_task_id` / `file_link`（snake_case），而入库侧
 * `confirmKnowledgeDraft` 只认 `contentMd`。三处症状同一个根因：
 *
 * 1. 路由返回 201「草稿已建」→ 草稿静静躺在「待处理」里，**从外表看不出它是坏的**；
 * 2. 弹窗按 `payload.contentMd` 渲染 → **正文显示为空**（用户看不到自己要确认的是什么）；
 * 3. 用户点「确认入库」→ 400 `knowledge requires content`（一句英文：不说缺哪个字段、
 *    不说合法键名、也不说 payload 里其实有 1668 字正文）。
 *
 * ## 修法（三件事都在本模块里算一次，三个调用方共用）
 *
 * 1. `normalizeKnowledgeDraftPayload`（读侧：确认入库 + 弹窗渲染）：把工具参数名当
 *    **别名**认下来归到规范键名 —— 于是**已经躺在库里的**坏草稿照样能显示、能入库，
 *    不需要改数据、不需要迁移。
 * 2. `canonicalizeKnowledgeDraftPayload`（写侧：建草稿的 HTTP 入口）：落库前把别名换成
 *    规范键名，并**回报用了哪些别名** —— 静默改写字段是本仓禁止的，所以调用方必须回显。
 * 3. `knowledgeDraftRejection`（建草稿与确认入库**共用同一份措辞**）：缺标题/缺正文时当场
 *    给出中文原因，并把「本次 payload 实际有哪些键」列出来。建草稿当场拒绝，比让用户
 *    点一次「确认入库」再看一句英文报错强得多。
 *
 * 与既有的 task 草稿口径一致：`confirmTaskDraft` 也认 `reminder_offset_minutes`
 * 这个 snake_case 别名（v1.14.x）。区别只是知识草稿有**三个**读取方（路由 / 入库 / 界面），
 * 所以别名表收进本模块，不允许任何一方再手写一遍。
 *
 * 客户端可用（不 import 任何 `node:` 模块，不碰 DOM/React）。
 */
import { KNOWLEDGE_DRAFT_REPLACED_TITLES_KEY, KNOWLEDGE_DRAFT_REVISION_KEY } from './knowledgeDraftOverwrite.js'

/** 规范化后的知识草稿字段（缺的字段取安全默认，**不**在这里判必填）。 */
export interface NormalizedKnowledgeDraft {
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceTaskId: string | null
  sourceReviewId: string | null
  matterId: string | null
  fileLink: string | null
}

/**
 * 工具参数名（snake_case）→ 规范键名（camelCase）。
 *
 * 左列是**调用方真会写出来的**键：它们逐一对应 `workbench_submit_knowledge` 的参数名。
 * 载入时不再新增随机拼写（例如不接受 `content` / `body`）：那些拼错的情况由
 * `knowledgeDraftRejection` 把 payload 的**实际键名**列出来，调用方一眼能看出写错在哪。
 */
export const KNOWLEDGE_DRAFT_FIELD_ALIASES: Readonly<Record<string, keyof NormalizedKnowledgeDraft>> = {
  content_md: 'contentMd',
  kind_code: 'kindCode',
  source_task_id: 'sourceTaskId',
  source_review_id: 'sourceReviewId',
  matter_id: 'matterId',
  file_link: 'fileLink',
}

/**
 * payload 里**合法但不参与归一化**的键：草稿历史（覆盖计数 / 被替换标题）与取代、有效期。
 * 归一化读的是上面那几个字段；这些键原样保留（写侧不丢、读侧不管）。
 */
const PASSTHROUGH_KEYS: readonly string[] = [
  KNOWLEDGE_DRAFT_REVISION_KEY,
  KNOWLEDGE_DRAFT_REPLACED_TITLES_KEY,
  'supersededById',
  'validUntil',
]

/** 知识草稿 payload 的规范键名（camelCase）——落库与读取都以它为准。 */
export const KNOWLEDGE_DRAFT_CANONICAL_KEYS: readonly string[] = [
  'title',
  'contentMd',
  'kindCode',
  'tags',
  'sourceTaskId',
  'sourceReviewId',
  'matterId',
  'fileLink',
]

/** 别名转换结果 + 本次用到的别名（调用方必须回显，不许静默改写字段）。 */
export interface KnowledgeDraftNormalization {
  payload: NormalizedKnowledgeDraft
  /** 本次在 payload 里**带值**的别名原始键（按字段顺序，无重复）。 */
  usedAliases: string[]
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** `tags` 只留字符串（数组以外的写法一律当没写）。 */
function normalizeTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []
}

/**
 * 取一个字段：规范键优先，规范键**取不到可用值**时回落到别名。
 *
 * 「可用」= 字符串非空 / 数组 / 数字等非 `undefined`、非 `null` 的值。
 * 两者都给且规范键可用时，规范键胜出 —— 但别名照样记进 `usedAliases`（见下），
 * 因为调用方需要知道这份 payload 里混着两套写法。
 */
function pick(source: Record<string, unknown>, canonical: string, alias: string | undefined): unknown {
  const direct = source[canonical]
  if (direct !== undefined && direct !== null && !(typeof direct === 'string' && direct === '')) return direct
  if (alias !== undefined) {
    const fallback = source[alias]
    if (fallback !== undefined && fallback !== null) return fallback
  }
  return undefined
}

/**
 * 把任意 payload 归一成规范字段。
 *
 * 非法类型一律取安全默认（`title`/`contentMd` 空串、`tags` 空数组、其余 `null`）——
 * **这里不判必填**：判必填由 `knowledgeDraftRejection` 负责，否则"缺字段"这件事
 * 会在读侧静默变成一条空知识。
 */
export function normalizeKnowledgeDraftPayload(payload: unknown): KnowledgeDraftNormalization {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const usedAliases: string[] = []
  const valueOf = (canonical: keyof NormalizedKnowledgeDraft): unknown => {
    const alias = Object.keys(KNOWLEDGE_DRAFT_FIELD_ALIASES).find((key) => KNOWLEDGE_DRAFT_FIELD_ALIASES[key] === canonical)
    const aliasValue = alias === undefined ? undefined : source[alias]
    if (alias !== undefined && aliasValue !== undefined && aliasValue !== null && !(typeof aliasValue === 'string' && aliasValue === '')) {
      usedAliases.push(alias)
    }
    return pick(source, canonical, alias)
  }
  /**
   * 字段**按规范键顺序**逐个求值（`usedAliases` 的顺序因此是确定的、可断言的）。
   * 求值顺序即书写顺序：别把某个字段提到 return 之前去算，否则回报顺序会跟着变。
   */
  const fields: NormalizedKnowledgeDraft = {
    title: textOrNull(valueOf('title')) ?? '',
    contentMd: textOrNull(valueOf('contentMd')) ?? '',
    kindCode: textOrNull(valueOf('kindCode')) ?? '',
    tags: normalizeTags(valueOf('tags')),
    sourceTaskId: textOrNull(valueOf('sourceTaskId')),
    sourceReviewId: textOrNull(valueOf('sourceReviewId')),
    matterId: textOrNull(valueOf('matterId')),
    fileLink: textOrNull(valueOf('fileLink')),
  }
  // 与 `confirmKnowledgeDraft` 原口径一致：没给 kindCode 按 note 处理。
  if (fields.kindCode === '') fields.kindCode = 'note'
  return { payload: fields, usedAliases }
}

/**
 * 写侧：别名换成规范键名后的 payload（**别名键被移除**，其余键原样保留）。
 *
 * `usedAliases` 非空时调用方必须把它回显给调用方/用户 —— 这是"改写字段"与"静默改写字段"
 * 的分界线。历史键与未知键一律不动（宁可留着让读侧忽略，也不静默丢件）。
 */
export function canonicalizeKnowledgeDraftPayload(payload: unknown): { payload: Record<string, unknown>; usedAliases: string[] } {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const { payload: fields, usedAliases } = normalizeKnowledgeDraftPayload(source)
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (KNOWLEDGE_DRAFT_FIELD_ALIASES[key] !== undefined) continue
    next[key] = value
  }
  next.title = fields.title
  next.contentMd = fields.contentMd
  next.kindCode = fields.kindCode
  next.tags = fields.tags
  next.sourceTaskId = fields.sourceTaskId
  next.sourceReviewId = fields.sourceReviewId
  next.fileLink = fields.fileLink
  // matterId 只在调用方真的写了（任一写法）时才写进 payload：凭空加一个 null 会让
  // "未归入"与"没提过这件事"混成一种状态（本仓对 `''` 与 `null` 的区分同样较真）。
  if (source.matterId !== undefined || source.matter_id !== undefined) next.matterId = fields.matterId
  return { payload: next, usedAliases }
}

/**
 * 知识草稿能不能用（缺标题 / 缺正文就给出中文原因，否则 `null`）。
 *
 * 缺正文这条消息**必须点出合法键名并列出本次 payload 的实际键**：
 * 用户看到的原始报错是 `knowledge requires content`，既不说缺什么、也不说该写什么，
 * 调用方只能猜（这正是本次缺陷拖了一整轮才发现的原因）。
 */
export function knowledgeDraftRejection(payload: unknown): string | null {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const { payload: fields } = normalizeKnowledgeDraftPayload(source)
  const keyList = Object.keys(source)
  const keysText = keyList.length === 0 ? '（空）' : keyList.join('、')
  if (fields.title.trim() === '') {
    return `知识草稿缺少标题：payload 需要 title（非空）。本次 payload 的键：${keysText}`
  }
  if (fields.contentMd.trim() === '') {
    return `知识草稿缺少正文：payload 需要 contentMd（Markdown 正文，snake_case 写法 content_md 也认）。` +
      `本次 payload 的键：${keysText}`
  }
  return null
}

/**
 * payload 里是否出现"知识草稿不认识、也不是历史字段"的键。
 *
 * 只用于提示（不拒收）：例如调用方同时写了 `contentMd` 与 `content_md`，
 * 或者手写了一个 `matter` —— 这些多余的键会被读侧忽略，说出来比闷着强。
 */
export function knowledgeDraftUnknownKeys(payload: unknown): string[] {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const known = new Set<string>([...KNOWLEDGE_DRAFT_CANONICAL_KEYS, ...Object.keys(KNOWLEDGE_DRAFT_FIELD_ALIASES), ...PASSTHROUGH_KEYS])
  return Object.keys(source).filter((key) => !known.has(key))
}
