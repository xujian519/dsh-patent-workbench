/**
 * `eslint-disable` 指令台账（审计 §4.5 / v1.17.0）。
 *
 * ## 它解决什么问题
 *
 * 本仓**没有任何 lint**：`package.json`、`node_modules`、配置文件里都没有
 * eslint / prettier / biome，CI 也没有 lint 关卡。但 `src/` 里有 5 处
 * `// eslint-disable-next-line react-hooks/exhaustive-deps` ——
 * 这些指令**写的时候是装饰**：写了没人校验，而它真正想防的"依赖数组不全"
 * 没有任何工具在管；更微妙的是它给了读者"这里有 lint 纪律"的错觉。
 *
 * ## 本工具**不是** lint（先把话说清楚）
 *
 * 它**不检查依赖数组对不对** —— 那需要真的把 react-hooks 规则跑起来
 * （引入 eslint + CI 关卡是一个要立项的决定，见审计 §4.5 的两条建议方向）。
 * 它做的是**台账棘轮**：把"有几处、分别是什么规则、为什么能关掉"冻结成一个数，
 *
 * - 新增一处 → 退出码 1，必须来这个文件写明理由；
 * - 修掉一处 → 也退出码 1（这个数要跟着现状走，不许变成"历史值"）；
 * - 缺规则名 / 缺 `--` 理由 → 退出码 1（不许出现"关掉一切"或"关掉但不说为什么"）。
 *
 * 于是"写了句 disable 就没人再管"变成"写 disable 必须过一道人工确认"。
 *
 * ## 口径
 *
 * 只扫 `src/`（与审计 §4.5 的证据同一口径）。`scripts/` 与 `test/` 里的
 * `eslint-disable` 形态有几处出现在**探针的代码字符串里**（例如
 * `scripts/repro/probe-knowledge-recall-mutations.mjs` 的变异体片段），
 * 按文本扫会误判 —— 口径收窄比"扫得更全但会误报"更可用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * 冻结台账：**每一处都必须有名有姓有理由**。
 *
 * 加/减任何一条都要同时改这里 —— 这不是麻烦，这就是本工具的全部作用。
 * `key` = `<相对路径>::<规则名>`，`count` = 该文件里这条规则出现的次数。
 */
export const EXPECTED_DIRECTIVES = [
  { key: 'src/client/index.tsx::react-hooks/exhaustive-deps', count: 3 },
  { key: 'src/client/dayPanelModel.ts::react-hooks/exhaustive-deps', count: 2 },
]

/** 理由至少要像个理由（防止 `-- x` 这种敷衍）。 */
const MIN_REASON_LENGTH = 6

const DIRECTIVE = /eslint-disable(?:-next-line|-line)?\b([^\n]*)/

/** 递归列出 `*.ts` / `*.tsx`（不跟随符号链接，跳过 `node_modules` / `lib`）。 */
export function listSourceFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'lib' || name.startsWith('.')) continue
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) { walk(full); continue }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * 扫出所有 `eslint-disable*` 指令。
 *
 * 只看**行注释**（`//` 之后到行尾）与块注释里的同类形态：本仓这几处都是行注释，
 * 而"代码字符串里的 disable"（探针）正是要靠口径排除的对象。
 */
export function collectDirectives(files, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  const directives = []
  for (const file of files) {
    const text = read(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      const match = DIRECTIVE.exec(line)
      if (match === null) return
      const rest = match[1] ?? ''
      const [head, ...reasonParts] = rest.split('--')
      const rule = head.trim().split(/\s+/)[0] ?? ''
      const reason = reasonParts.join('--').trim()
      directives.push({ file, line: index + 1, rule, reason, text: line.trim() })
    })
  }
  return directives
}

/** 按 `<相对路径>::<规则>` 聚合。 */
export function tallyDirectives(directives, root) {
  const tally = new Map()
  for (const item of directives) {
    const rel = relative(root, item.file).split(sep).join('/')
    const key = `${rel}::${item.rule === '' ? '(未指定规则)' : item.rule}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  return tally
}

/**
 * 跑一次校验。`deps` 可注入（测试用临时目录）。
 *
 * 返回 `{ exitCode, tally, problems, directives, lines }`。**计数一律现算**，
 * 不引用任何写死的历史值（除基线本身）。
 */
export function runCheck(options = {}) {
  const root = resolve(options.root ?? join(HERE, '..'))
  const srcRoot = join(root, 'src')
  const files = options.files ?? listSourceFiles(srcRoot)
  const directives = collectDirectives(files, options.deps ?? {})
  const tally = tallyDirectives(directives, root)
  const expected = options.expected ?? EXPECTED_DIRECTIVES
  const problems = []
  const lines = []

  for (const item of directives) {
    const rel = relative(root, item.file).split(sep).join('/')
    if (item.rule === '') {
      problems.push(`${rel}:${item.line} 指令没点名规则（关掉一切）—— 必须写成 eslint-disable-next-line <规则>`)
    } else if (item.reason.length < MIN_REASON_LENGTH) {
      problems.push(`${rel}:${item.line} 缺 \`-- 理由\`（至少 ${MIN_REASON_LENGTH} 字）—— 没写为什么就等于没人知道它能不能删`)
    }
  }

  for (const entry of expected) {
    const actual = tally.get(entry.key) ?? 0
    if (actual === entry.count) continue
    if (actual > entry.count) {
      problems.push(`${entry.key} 现在 ${actual} 处（台账 ${entry.count}）—— 新增指令要来 scripts/check-lint-directives.mjs 写明理由后再更新台账`)
    } else {
      problems.push(`${entry.key} 现在 ${actual} 处（台账 ${entry.count}）—— 少了就是把一处 lint 债修掉了：请同步把台账改小，让这个数继续代表现状`)
    }
  }
  for (const key of tally.keys()) {
    if (!expected.some((entry) => entry.key === key)) {
      problems.push(`${key} 不在台账里 —— 新出现的指令必须登记（含理由）`)
    }
  }

  lines.push(`扫描：${files.length} 个 .ts/.tsx（口径 = src/）`)
  lines.push(`指令：${directives.length} 处 / 台账 ${expected.reduce((sum, entry) => sum + entry.count, 0)} 处`)
  for (const item of directives) {
    const rel = relative(root, item.file).split(sep).join('/')
    lines.push(`  · ${rel}:${item.line} ${item.rule} —— ${item.reason}`)
  }
  return { exitCode: problems.length === 0 ? 0 : 1, tally, problems, directives, lines }
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
    console.log(JSON.stringify({ exitCode: result.exitCode, directives: result.directives.length, problems: result.problems }, null, 2))
  } else {
    console.log('=== eslint-disable 指令台账（不是 lint，是棘轮：本仓没有 lint 工具） ===')
    for (const line of result.lines) console.log(`  ${line}`)
    if (result.problems.length === 0) {
      console.log('\n✅ 指令数与台账一致，且每一处都点名了规则与理由')
    } else {
      for (const problem of result.problems) console.log(`  ✖ ${problem}`)
      console.log('\n✖ 台账不一致，先处理上面 ✖ 的条目')
    }
  }
  process.exit(result.exitCode)
}
