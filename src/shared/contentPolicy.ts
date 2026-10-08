/**
 * **内容面**敏感信息闸门（T7 · 2026-10-07 灵枢调研落地）。
 *
 * ## 它补的是哪个洞
 *
 * 灵枢（dsh-memory）的调研缺口表里有一行：
 *
 * > | 敏感信息闸门 | 11 条禁则，写入闸门与发布闸门**同一口径** | `openableFile.ts`（**文件面**） | **内容面缺闸** |
 *
 * 本仓已有的 `scripts/check-pii.mjs` 是**发布闸门**：它在 `release-preflight` 里
 * 扫 `git ls-files` 与 `lib/**`，管的是"**这个仓库里**有没有不该有的东西"。
 * 它管不到**运行时的内容**：AI 把一份含明文令牌的配置片段写进任务草稿、
 * 写进知识正文，然后这些东西被人确认入库、被导出、被发布到自媒体平台 ——
 * 这条路上**今天一道检查都没有**。本模块就是那道闸。
 *
 * ## 为什么规则是这 7 条（而不是 `check-pii.mjs` 的全部 17 条）
 *
 * `check-pii.mjs` 的规则表是**两类东西混在一起**的：
 *
 * | 类别 | 例子 | 能不能进包 |
 * |---|---|---|
 * | **凭据模式**：任何人、任何机器上命中都是问题 | `BEGIN … PRIVATE KEY`、`ghp_…`、`sk-…` | ✅ 可以 |
 * | **开发者本人/本公司的标识**：公司名、内网仓库名、本机账号名、个人邮箱 | `scripts/check-pii.mjs` 顶部那几条**拼接常量**（原文在那里，**不抄到这里**） | ❌ **绝不能** |
 *
 * 第二类之所以能安全地待在 `scripts/` 里，**恰恰因为 `scripts/` 不进 npm 包**
 * （`package.json` 的 `files` 白名单）。把它们搬进 `src/` 会被 `tsc` 编进 `lib/`，
 * 随后 `pnpm publish` 把**它们本人**发给全世界 —— 那是自伤，不是加固。
 * 更隐蔽的是：`check-pii.mjs` 里这几条源码写的是拼接形式
 * （`['Admini','strator'].join('')`），片段之间从不形成相邻可匹配文本，
 * 所以 `check-pii.mjs` 的"面二（`lib/**`）"**扫不出**自己造成的这次泄漏。
 *
 * ⚠️ **本文件头这段警告本身踩过一次坑**（2026-10-08）：初版为了把这些规则"说清楚"，
 * 在**注释里**把它们的取值原样抄了一遍 —— 而 **`tsc` 会把注释带进 `.js` 与 `.d.ts`**，
 * 于是 warning 的同一段话把我警告的东西送进了包。教训：这里**只写类别、不写取值**，
 * 取值指向 `scripts/check-pii.mjs`。注释也是包内容。
 *
 * 实测（本文件落地前的基线）：`node scripts/check-pii.mjs dist` → 面二 320 个文件、
 * 17 条规则全部干净、命中 0 处。搬进来的那一刻这个 0 就会被打破。
 *
 * 所以口径是：**只搬凭据子集，逐字照抄，不新增、不改写**。
 *
 * ## 「两闸同口径」怎么保证（灵枢的教训）
 *
 * 灵枢 `policy.json` 里专门记着一条事故教训：**写入闸门与发布闸门曾分叉**，
 * 一条明文令牌因为"发布闸门有这个模式、写入闸门没有"而过了闸。
 * 本仓的对应风险是：`check-pii.mjs` 改了规则，`src/` 这份忘了跟 —— 于是发布闸门拦得住、
 * 运行时闸门拦不住。
 *
 * `scripts/check-policy-drift.mjs` 就是钉这一点：**两侧逐字对账**这 7 条规则。
 * 它是文本层面的提取（两侧的规则都写成 `['名字', /正则/标志]` 这个形状），
 * 所以 `check-pii.mjs` **一行都不用改**。
 *
 * ⚠️ 因此本文件里那 7 条的**名称与正则字面量必须与 `check-pii.mjs` 逐字一致**，
 * 改动任何一侧都要同时改另一侧，否则 `check-policy-drift.mjs` 会红。
 *
 * ## 口径边界（别把这道闸读大了）
 *
 * - **只管凭据**。业务判据（客户名称、案号、未公开技术特征、发明人真实姓名）
 *   **不在这里** —— 那些需要用户给出判据，猜不得（灵枢那 11 条里也没有）。
 * - **只扫 `payload` 里的字符串叶子**，扫的是"内容本身"。
 * - **命中的原文不写进任何日志/错误/事件**（见 `contentPolicyProblem`）。
 */

/**
 * 凭据规则表。**名称与正则必须与 `scripts/check-pii.mjs` 的凭据子集逐字一致。**
 *
 * `scripts/check-policy-drift.mjs` 按 `['名字', /正则/标志]` 这个形状从两侧文本里提取、
 * 逐条对账；改这里而忘了改那边（或反过来），门禁会红。
 *
 * ⚠️ 这些正则**都不带 `g` 标志**：`RegExp.prototype.test` 在带 `g` 时会把
 * `lastIndex` 记在正则对象上，同一个正则连着测第二个字符串就会从上次的位置接着找，
 * 造成"同一条内容有时命中有时不命中"。本模块的正则是模块级常量、会被反复复用，
 * 加 `g` 的那一刻就等于埋了这个坑。
 */
const CREDENTIAL_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['私钥块', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['npm token', /npm_[A-Za-z0-9]{20,}/],
  ['GitHub token', /gh[pous]_[A-Za-z0-9]{20,}/],
  ['OpenAI 风格 key', /sk-[A-Za-z0-9]{20,}/],
  ['Bearer token 字面量', /Bearer\s+[A-Za-z0-9_-]{20,}/],
  ['api_key / secret / password 赋值（合成夹具豁免）',
    /(api[_-]?key|secret|password)\s*[:=]\s*['"](?![^'"]*(?:secret|token|placeholder|example|dummy)[^'"]*['"])[^'"]{8,}['"]/i],
  ['凭据文件名引用', /\.npm_token\.txt|\.gh_token\.txt|GithubToken=/],
]

/** 单个命中。**刻意不带命中原文** —— 见 `contentPolicyProblem` 的说明。 */
export interface ContentPolicyHit {
  /** 命中的规则名（与 `scripts/check-pii.mjs` 同名）。 */
  rule: string
  /** 命中所在的字段路径，如 `payload.subtasks[0].title`。 */
  path: string
}

/**
 * 递归扫描任意 JSON 形状的值，收集**字符串叶子**上的命中。
 *
 * 为什么递归而不是只看顶层：草稿 payload 的内容散在
 * `payload.subtasks[0].summary`、`payload.extra.*` 这类嵌套位置上，
 * 只看顶层等于没扫。
 *
 * 为什么要有深度上限：本函数的调用方（`createDraft` / `updateDraft`）在**写入路径**上，
 * 一个环状对象会让这里死循环、整个写入请求挂住。JSON 反序列化出来的对象不可能有环，
 * 但 `updateDraft(db, id, { ...draft.payload, ... })` 这种**手工拼的对象**没有这层保证。
 * 到顶就**停止下钻**（已扫到的部分照样计入，不因此放行）。
 */
export function scanContentPolicy(value: unknown, path = 'payload', depth = 0): ContentPolicyHit[] {
  if (typeof value === 'string') {
    return CREDENTIAL_RULES
      .filter(([, pattern]) => pattern.test(value))
      .map(([rule]) => ({ rule, path }))
  }
  if (depth >= 12) return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scanContentPolicy(item, `${path}[${index}]`, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => scanContentPolicy(item, `${path}.${key}`, depth + 1))
  }
  return []
}

/**
 * 把命中拼成给**人或 AI 看**的中文拒绝原因；无命中返回 `null`。
 *
 * ## 为什么只报"哪条规则、哪个字段"，绝不回显命中原文
 *
 * 这条拒绝原因会一路走下去：工具回执（进模型的上下文）、HTTP 响应体（进浏览器
 * 与日志）、任务事件（进 SQLite，长期留存）。**在里面回显那串令牌本身，
 * 等于亲手把它复制到三个新的地方** —— 闸门反而成了泄漏的搬运工。
 * 用户不需要我们告诉他"你写的密钥长什么样"，他自己知道；他要的是"哪条规则、
 * 在哪个字段"，好去改。
 *
 * ## 为什么要去重
 *
 * 同一份内容在 payload 里出现两次（如 `summary` 与 `subtasks[0].summary`）
 * 是常见形态，逐条列会给出两行一模一样的字。
 */
export function contentPolicyProblem(payload: unknown): string | null {
  const hits = scanContentPolicy(payload)
  if (hits.length === 0) return null
  const seen = new Set<string>()
  const lines: string[] = []
  for (const hit of hits) {
    const key = `${hit.rule}@${hit.path}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`  · 「${hit.rule}」→ 字段 ${hit.path}`)
  }
  return [
    `错误：内容里检出敏感凭据，已拒绝写入（命中 ${lines.length} 处）：`,
    ...lines,
    // ⚠️ 这里给的例子**必须自己过得了这道闸**，否则我们等于把 AI 从一次拒绝
    // 引向下一次拒绝。`'<placeholder-token>'` 里含自述词 `placeholder`/`token`，
    // 正落在"api_key/secret/password 赋值"那条规则的豁免分支上（已由单测钉住）；
    // 而「'<在此填入令牌>'」这种纯中文占位符**会二次命中** —— 别改回去。
    "请把凭据换成占位符（如 api_key: '<placeholder-token>'）后再提交。",
    '这道闸只看"内容里有没有凭据"这一类形态，判断依据是通用模式，与内容归属无关。',
  ].join('\n')
}
