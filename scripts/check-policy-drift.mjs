/**
 * 敏感信息**两闸同口径**校验（**只读**，不改任何文件）。
 *
 * ## 它解决什么问题（灵枢的教训）
 *
 * 灵枢（dsh-memory）的 `policy.json` 里专门记着一条事故：**写入闸门与发布闸门分叉过**
 * —— 一条明文令牌因为"发布闸门有这个模式、写入闸门没有"而过了闸。两个闸门各写一份
 * 正则，就一定会漂移，区别只是漂到哪天才被发现。
 *
 * 本仓的两个面是：
 *
 * | 闸门 | 位置 | 管什么 |
 * |---|---|---|
 * | 发布闸门 | `scripts/check-pii.mjs`（17 条规则，两个面） | **仓库里**有没有不该有的东西 |
 * | 运行时闸门 | `src/shared/contentPolicy.ts`（凭据子集 7 条） | **内容里**有没有不该有的东西 |
 *
 * 运行时闸门**只搬凭据子集**（理由见 `contentPolicy.ts` 文件头：另外那些规则是
 * 开发者本人的标识，搬进 `src/` 会被编进 `lib/` 随包发布）。所以两侧**不是全等关系**，
 * 本工具钉的是那个子集：**这 7 条必须两侧逐字一致**。
 *
 * ## 怎么比（为什么 `check-pii.mjs` 一行都不用改）
 *
 * 两侧的规则都写成同一个形状：`['名字', /正则/标志]`。本工具**按文本提取这个形状**
 * 再逐条对账 —— 于是不需要把 `check-pii.mjs` 改造成可 import 的模块、
 * 更不需要在它里面加"哪些是凭据子集"的标记（那会动一个与本次改动无关的文件）。
 *
 * ## 断言（三条，都是硬失败）
 *
 * 1. **只多不少**：`contentPolicy.ts` 里出现的每一条规则，都必须在 `check-pii.mjs` 里
 *    有同名同正则的对应物 —— 在运行时闸门里**私自新增**一条判据就是分叉。
 * 2. **一条不缺**：下面 `CREDENTIAL_SUBSET` 那 7 条**必须两侧都在** ——
 *    `check-pii.mjs` 里被人改名/删掉，也要在这里红，否则子集悄悄缩小没人知道。
 * 3. **逐字一致**：同名规则的正则**源码与标志位**必须完全相同。
 *
 * ## 已知限度（别把绿色读大了）
 *
 * 本工具**发现不了**这种漂移：`check-pii.mjs` 新增了一条**凭据类**规则，而
 * `contentPolicy.ts` 没跟。原因是两类规则在文本层面同形（都是 `['名字', /正则/]`），
 * 唯一能区分它们的正是"这条判据是不是指向某个具体的人或公司"——那是**语义判断**，
 * 不是文本比对能做的。所以这里改成**把它显式打出来**：所有"没纳入运行时闸门的
 * check-pii 普通字面量规则"会以 `·` 行的形式列在输出里，供人过一眼。
 *
 * （`check-pii.mjs` 里靠拼接构造的那几条 —— 公司名/内网名/本机账号/个人邮箱 ——
 * 天然提取不出来，它们也**本来就该**留在发布闸门那一侧。）
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-policy-drift.mjs          # 人读
 * node scripts/check-policy-drift.mjs --json   # 机读
 * ```
 *
 * 退出码：0 = 无漂移；1 = 有漂移（逐条打印修法）。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 发布闸门（`check-pii.mjs`）的相对路径。 */
export const PUBLISH_GATE_REL = 'scripts/check-pii.mjs'
/** 运行时闸门（`contentPolicy.ts`）的相对路径。 */
export const RUNTIME_GATE_REL = 'src/shared/contentPolicy.ts'

/**
 * 运行时闸门**必须**与发布闸门逐字一致的那 7 条。
 *
 * 这份名单是**契约**，不是实现细节：它变了就说明"进包的判据"变了，
 * 而那件事必须被人看见并当场改这里（与 `release-preflight.mjs` 的
 * `KNOWN_TEST_FAILURES`、`verify-installed.mjs` 的 `EXPECTED_TOOLS` 同一条纪律）。
 */
export const CREDENTIAL_SUBSET = [
  '私钥块',
  'npm token',
  'GitHub token',
  'OpenAI 风格 key',
  'Bearer token 字面量',
  'api_key / secret / password 赋值（合成夹具豁免）',
  '凭据文件名引用',
]

/**
 * 从源码文本里提取 `['名字', /正则/标志]` 形状的规则对。
 *
 * - 名字段：`'…'`，允许转义；
 * - 正字段：`/` 起、遇**未转义**的 `/` 止、后缀 `[gimsuy]*`。
 *   字符类 `[^/\\\n]` 把裸 `/` 排除在外，所以正则体里出现 `/` 必须先转义 ——
 *   这也是 JS 正则字面量本身的规则，两者一致。
 *
 * **只认字面量**：`new RegExp(拼接)` 那几条（开发者本人的标识）天然提取不到，
 * 而它们**本来就该**留在发布闸门一侧。
 */
export function extractRulePairs(source) {
  const out = []
  const pattern = /\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)\s*[,\]]/g
  for (const match of source.matchAll(pattern)) {
    out.push({ name: match[1], literal: match[2] })
  }
  return out
}

/** 把 `/正则/标志` 拆成可分别比较的两半。 */
export function splitLiteral(literal) {
  const end = literal.lastIndexOf('/')
  return { source: literal.slice(1, end), flags: literal.slice(end + 1) }
}

/**
 * 跑一次校验。`deps` 可注入（测试用临时文件）。
 * 返回 `{ exitCode, problems, lines }`。
 */
export function runCheck(options = {}) {
  const root = resolve(options.root ?? join(HERE, '..'))
  const read = options.deps?.readFileSync ?? readFileSync
  const problems = []
  const lines = []

  const side = (rel) => {
    try {
      return extractRulePairs(read(join(root, rel), 'utf8'))
    } catch {
      problems.push(`${rel} 读不到 —— 两侧对账缺了一半，先确认文件还在、路径没改`)
      return null
    }
  }
  const publish = side(PUBLISH_GATE_REL)
  const runtime = side(RUNTIME_GATE_REL)
  if (publish === null || runtime === null) return { exitCode: 1, problems, lines }

  const publishByName = new Map(publish.map((rule) => [rule.name, rule.literal]))
  const runtimeByName = new Map(runtime.map((rule) => [rule.name, rule.literal]))

  // ── 断言 1：运行时闸门里的每一条，发布闸门里都得有 ──────────────────────────
  for (const [name, literal] of runtimeByName) {
    if (!publishByName.has(name)) {
      problems.push(`${RUNTIME_GATE_REL} 有「${name}」，${PUBLISH_GATE_REL} 里没有 —— 运行时闸门私自新增判据就是两闸分叉（灵枢踩过这个坑）`)
      continue
    }
    const a = splitLiteral(publishByName.get(name))
    const b = splitLiteral(literal)
    if (a.source !== b.source || a.flags !== b.flags) {
      problems.push(`「${name}」两侧不等：${PUBLISH_GATE_REL} ${publishByName.get(name)} ≠ ${RUNTIME_GATE_REL} ${literal}`)
    }
  }

  // ── 断言 2：契约名单一条不缺（防"子集悄悄缩小"） ───────────────────────────
  for (const name of CREDENTIAL_SUBSET) {
    if (!publishByName.has(name)) problems.push(`${PUBLISH_GATE_REL} 里找不到契约规则「${name}」—— 发布闸门改名/删规则时必须同步本文件与 ${RUNTIME_GATE_REL}`)
    if (!runtimeByName.has(name)) problems.push(`${RUNTIME_GATE_REL} 里找不到契约规则「${name}」—— 运行时闸门的凭据子集缺了一条`)
  }

  // ── 报告：发布闸门里那些**没**纳入运行时闸门的普通字面量规则（见顶部"已知限度"）──
  const outside = publish.filter((rule) => !CREDENTIAL_SUBSET.includes(rule.name))
  lines.push(`对账：${PUBLISH_GATE_REL} 提取到 ${publish.length} 条字面量规则，${RUNTIME_GATE_REL} 提取到 ${runtime.length} 条，契约名单 ${CREDENTIAL_SUBSET.length} 条`)
  if (outside.length > 0) {
    lines.push(`  · 只在发布闸门里的 ${outside.length} 条（靠拼接构造的私人标识提取不出，本来也不该进包）：`)
    for (const rule of outside) lines.push(`      - ${rule.name}`)
  }
  return { exitCode: problems.length === 0 ? 0 : 1, problems, lines }
}

function parseArgs(argv) {
  const options = { json: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
  }
  return options
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const result = runCheck(options)
  if (options.json) {
    console.log(JSON.stringify({ exitCode: result.exitCode, problems: result.problems }, null, 2))
  } else {
    console.log('=== 敏感信息两闸同口径（发布闸门 = scripts/check-pii.mjs · 运行时闸门 = src/shared/contentPolicy.ts）===')
    for (const line of result.lines) console.log(line)
    if (result.problems.length === 0) {
      console.log('\n✅ 凭据子集两侧逐字一致，运行时闸门没有私自多出来的判据')
    } else {
      for (const problem of result.problems) console.log(`  ✖ ${problem}`)
      console.log('\n✖ 有漂移，先按上面每条 ✖ 的修法处理')
    }
  }
  process.exit(result.exitCode)
}
