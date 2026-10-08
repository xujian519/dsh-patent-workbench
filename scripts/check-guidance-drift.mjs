/**
 * 注入文本防漂移校验（**只读**，不改任何文件）。
 *
 * ## 它解决什么问题
 *
 * 「AI 不能直接把任务标记为已完成/已取消」这条规则**写在 4 处**：
 * `src/index.ts` 2 处（执行流程段 + 进度语义段）、`src/tools.ts` 2 处
 * （工具描述 + 拒绝 `status_code=done/cancelled` 的错误消息）。
 *
 * 而且**已经漂移过**：`index.ts` 两处写的是「完成/取消」，`tools.ts` 两处写的是
 * 「已完成/已取消」。它们不是逐字复制（语域不同：常驻引导 / 工具描述 / 错误消息），
 * 所以 import 不了同一个字符串 —— 但它们**是同一条规定**，改一处漏三处就是事故。
 *
 * 真源因此不是「一个字符串导出」，而是 `src/shared/guidance.ts` 里的**规范表述**；
 * 各挂点按自己的语域从中取值。本工具断言：规范短语**只允许**出现在真源里，
 * 别处再手打一遍就报错。
 *
 * ## 口径（为什么不是 `src/**` 全扫）
 *
 * 扫 `src/**` 但**排除 `src/client/**`**。客户端里「标记为已完成」是**给人看的 UI 文案**
 * （`client/index.tsx` 的确认弹窗、`client/components/TaskProgress.tsx` 的状态提示），
 * 不是注入给模型的引导文本 —— 把它们算进来只会制造误报。
 * 按 `check-lint-directives.mjs` 的同一条口径：**扫得少但不误报，比扫得全但没人看更可用**。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-guidance-drift.mjs          # 人读
 * node scripts/check-guidance-drift.mjs --json   # 机读
 * ```
 *
 * 退出码：0 = 无漂移；1 = 有漂移（逐条打印修法）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 真源文件（相对仓库根，正斜杠）。规范短语**只允许**出现在这里。 */
export const GUIDANCE_REL = 'src/shared/guidance.ts'

/**
 * 「这条规则的样子」——照它判一句话是不是又被手打了一遍。
 *
 * 刻意不写完整句子（完整句子从真源里读，见 `readMark`）：这里的每一项都是
 * **历史上真出现过的变体**（`完成/取消` 与 `已完成/已取消` 的四种组合）。
 */
export const RULE_STEMS = [
  ['标记为', '已完成'].join(''),
  ['标记为', '完成'].join(''),
  ['标记为', '已取消'].join(''),
  ['标记为', '取消'].join(''),
]

/** 递归列出 `src/` 下的 `.ts` / `.tsx`，**排除 `src/client/`**（见顶部口径）。 */
export function listInjectedScopeFiles(root) {
  const out = []
  const srcRoot = join(root, 'src')
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'lib' || name.startsWith('.')) continue
      if (name === 'client' && dir === srcRoot) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
    }
  }
  walk(srcRoot)
  return out
}

/**
 * 从真源里读出规范短语 —— **不在这里手打它**，否则本工具自己就成了第 5 处副本。
 * 读不到返回 `null`（真源被改坏 / 改名，跑一次就知道）。
 */
export function readMark(guidanceSource) {
  const match = /export const COMPLETION_AUTHORITY_MARK = '([^']+)'/.exec(guidanceSource)
  return match === null ? null : match[1]
}

/**
 * 跑一次校验。`deps` 可注入（测试用临时目录）。返回 `{ exitCode, problems, lines }`。
 */
export function runCheck(options = {}) {
  const root = resolve(options.root ?? join(HERE, '..'))
  const read = options.deps?.readFileSync ?? readFileSync
  const files = options.files ?? listInjectedScopeFiles(root)
  const problems = []
  const lines = []

  const guidancePath = join(root, GUIDANCE_REL)
  let mark = null
  try {
    mark = readMark(read(guidancePath, 'utf8'))
  } catch { mark = null }
  if (mark === null) {
    problems.push(`${GUIDANCE_REL} 里读不到 \`COMPLETION_AUTHORITY_MARK\` —— 真源没了，各挂点就无从取值`)
    return { exitCode: 1, problems, lines: [`扫描：${files.length} 个 .ts/.tsx（口径 = src/ 去掉 src/client/）`] }
  }

  let mentions = 0
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    const text = read(file, 'utf8')
    const isSource = rel === GUIDANCE_REL
    const handWritten = text.includes(mark)
    const stems = isSource ? [] : RULE_STEMS.filter((stem) => text.includes(stem))
    const importsSource = /from\s+['"][^'"]*shared\/guidance(\.js)?['"]/.test(text)

    if (isSource) {
      lines.push(`  · ${rel}（真源，规范短语「${mark}」）`)
      continue
    }
    if (handWritten) {
      problems.push(`${rel} 手打了规范短语「${mark}」—— 必须从 ${GUIDANCE_REL} 取值`)
      continue
    }
    if (stems.length === 0) continue
    mentions += 1
    if (importsSource) {
      lines.push(`  · ${rel} 提到「${stems[0]}」，已从真源取值 ✅`)
      continue
    }
    problems.push(`${rel} 提到「${stems.join(' / ')}」却没有从 ${GUIDANCE_REL} 取值 —— 这条规则历史漂移过（完成/取消 vs 已完成/已取消），改一处会漏三处`)
  }

  lines.unshift(`扫描：${files.length} 个 .ts/.tsx（口径 = src/ 去掉 src/client/）· 真源外引用 ${mentions} 处`)
  return { exitCode: problems.length === 0 ? 0 : 1, problems, lines, mark }
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
    console.log(JSON.stringify({ exitCode: result.exitCode, mark: result.mark ?? null, problems: result.problems }, null, 2))
  } else {
    console.log('=== 注入文本防漂移（真源 = src/shared/guidance.ts）===')
    for (const line of result.lines) console.log(line)
    if (result.problems.length === 0) {
      console.log('\n✅ 规范短语只出现在真源里，各挂点都从真源取值')
    } else {
      for (const problem of result.problems) console.log(`  ✖ ${problem}`)
      console.log('\n✖ 有漂移，先按上面每条 ✖ 的修法处理')
    }
  }
  process.exit(result.exitCode)
}
