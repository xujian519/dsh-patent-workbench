#!/usr/bin/env node
/**
 * 装后**真启动**冒烟腿（T6 · 2026-10-07 灵枢调研落地）。
 *
 * ## 它补的是哪个洞
 *
 * 装盘这条路上已有三道检查，但**全是文件层面的**：
 *
 * | 脚本 | 判据 |
 * |---|---|
 * | `check-tgz.mjs` | 包里**有**哪些文件（静态读 tar 头） |
 * | `check-installed-fingerprint.mjs` | 装盘产物与开发树**逐字节相同** |
 * | `check-installed-version.mjs` | 装盘版本号对得上 |
 *
 * 它们谁也回答不了这个问题：**把这个包真的 `import` 进来、真的执行插件入口，
 * 它还认得路吗？** —— 灵枢（dsh-memory）的 `check_publish_smoke.py` 正是冲着这件事去的：
 * 真 pack → 空沙箱真装 → 真启动 → 断言工具面。
 *
 * 本仓已有的 `test/pluginEntry.test.mjs` 会 `import '../lib/index.js'`，但
 * ① 导的是**开发树**不是装盘产物；② 只读 `inject` 与命令定义，**从不调用 `apply()`** ——
 * 于是"入口真跑起来会不会当场抛错、工具面还是不是那 15 个、有没有掉进降级空转"
 * 在今天**没有任何判据**。这道腿补的就是这一格。
 *
 * ## 口径：做了什么、没做什么（别把绿色读大了）
 *
 * ✅ **做**：`pnpm pack` → 解到**空沙箱** → 从**沙箱里的产物** `import` →
 *    用最小 ctx 桩真调 `apply()` → 断言工具面 / 路由 / 系统提示 / 命令，
 *    并断言**没有走降级路径**。
 * ⚠️ **不做**：不启动真 DSH 宿主。`ctx` 是照宿主接口**手搭的最小桩**
 *    （`tools.register` / `webServer.register` / `systemPrompt.section` / `get` / `effect` / `inject`），
 *    所以真实接线（cordis fiber 的依赖注入顺序、真的 commands 服务、timer 调度）
 *    **不在这条腿的射程内** —— 那是 `dev-verify.mjs` 那条链的事。本腿射程是**产物本身**：
 *    `files` 白名单漏文件、`exports` 指错路径、入口 top-level import 解析不到、
 *    入口一执行就抛错、工具面漂移。
 * ⚠️ peer 依赖软链的是**仓库自己的** `node_modules/@deepseek-ai`。
 *    `lib/index.js` 有一个裸 import（`createUserMessage` from `@deepseek-ai/dsh-llm`），
 *    真机上由 DSH 宿主提供；沙箱里没有它连 `import` 都进不去。
 *    软链的是**开发树用的同一份 peer**，不是"干净环境"，这一点不许被读成"等价于真机"。
 *
 * ## 为什么沙箱里也要"真空装"而不是直接读 tgz 里的字符串
 *
 * 直接读 tgz 内容只能证明"文件在包里"，证明不了"这些文件按 `package.json` 的
 * `exports` / `main` 指路后**真能解析到一起**"。解到 `node_modules/<name>/` 再 `import`
 * 走的是 Node 的真实解析器 —— 这正是 DSH 装盘后宿主看到的那条路。
 *
 * 用法：`node scripts/verify-installed.mjs`
 * 退出码：0 = 通过；1 = 冒烟失败；2 = 用法/环境错误（打包失败、lib 缺失）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { listTarEntries, readEntryContent } from './lib/tarReader.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG_NAME = 'dsh-patent-workbench'
const PEER_SCOPE = '@deepseek-ai'

/**
 * 期望的**工具面**：与 `src/index.ts` 的 `ctx.tools.register(...)` 那一段**完全相等**。
 *
 * 为什么是"集合相等"而不是"至少包含"：工具面就是**暴露给模型的动作集合**，
 * 加一个工具 = 给 AI 多开一条能改数据的路，减一个工具 = 悄悄砍掉一条能力。
 * 两种都该被人**看见**并当场改这个名单，而不是"反正多了一个也不报错"。
 * 这条口径与 `release-preflight.mjs` 的 `KNOWN_TEST_FAILURES`（名单外必须红、
 * 名单里不红也必须红）是同一条纪律。
 */
const EXPECTED_TOOLS = [
  'workbench_knowledge_recall_control',
  'workbench_link_knowledge_matter',
  'workbench_load_persona',
  'workbench_propose_daily_plan',
  'workbench_propose_subtasks',
  'workbench_read_persona_resource',
  'workbench_request_completion',
  'workbench_save_task_memory',
  'workbench_search_knowledge',
  'workbench_submit_knowledge',
  'workbench_submit_review',
  'workbench_submit_task',
  'workbench_sync_matter_events',
  'workbench_update_progress',
  'workbench_update_task',
]

/**
 * 期望**必须存在**的核心路由（不要求相等，只要求这几条在场）。
 *
 * 只钉"工作台能不能起来"这件事本身：bootstrap 是前端首屏、health 是宿主探活、
 * settings 是设置面板、workspaces/ensure 是任务资料夹落点。新增路由不必改这里，
 * **删掉这几条**必须红。
 */
const REQUIRED_ROUTES = [
  '/api/workbench/bootstrap',
  '/api/workbench/health',
  '/api/workbench/settings',
  '/api/workbench/workspaces/ensure',
]

const problems = []
const note = (line) => console.log(`   ${line}`)
const fail = (message) => { problems.push(message); console.log(`   ❌ ${message}`) }

/** 环境/用法错误：不是"产物有问题"，是"这条腿根本没跑起来"，退出码必须与失败分开。 */
class RefuseError extends Error {}

/**
 * 环境/用法错误（退出码 2）：不是"产物有问题"，是"这条腿根本没跑起来"。
 *
 * ⚠️ 刻意**不在这里 `process.exit`**：所有调用点都在下面那个 `try` 的体内，
 * 而 `finally` 负责删掉沙箱临时目录。直接退出会**绕过 `finally`** —— 每遇到一次
 * 环境错误（没 pnpm、tgz 没打出来、产物 import 不进去）就在 `$TMPDIR` 里
 * 永久漏下一个装着 tgz 与整棵解包 `node_modules` 的目录，与文件头"失败也要清干净"
 * 的承诺相反。改成抛标记错误，由最外层统一收口后再退出。
 */
function refuse(message) {
  throw new RefuseError(message)
}

/** 跑一条命令并整份捕获输出（管道 stdio ⇒ 子进程不会继承我们的 TTY）。 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'wb-installed-'))

/**
 * 沙箱根先建、`refuse` 的收口在 `finally` **之后** —— 这样无论走哪条路
 * （正常 / 冒烟失败 / 环境错误 / 真异常），临时目录都恰好被删一次。
 */
let refused = null
try {
  // ── 1. 打包 ───────────────────────────────────────────────────────────────
  // `pnpm pack` 会触发 `prepare`（= `pnpm build`），所以包里的 `lib/` 必然是
  // **当前源码构建出来的** —— 冒烟不会测到旧构建产物。下面第 4 步再验一次这个事实。
  const packDir = join(sandboxRoot, 'pack')
  mkdirSync(packDir, { recursive: true })
  note(`① 打包：pnpm pack → ${packDir}`)
  const pack = run('pnpm', ['pack', '--pack-destination', packDir])
  if (pack.code !== 0) refuse(`pnpm pack 失败（退出码 ${pack.code}）：\n${pack.out.trim().split('\n').slice(-15).join('\n')}`)

  const { readdirSync } = await import('node:fs')
  const tgzName = readdirSync(packDir).find((file) => file.endsWith('.tgz'))
  if (tgzName === undefined) refuse(`打包目录里没有 tgz：${packDir}`)
  const tgzPath = join(packDir, tgzName)
  note(`   ${tgzName}`)

  // ── 2. 解到空沙箱的 node_modules/<name>/ ──────────────────────────────────
  const pkgRoot = join(sandboxRoot, 'node_modules', PKG_NAME)
  const buffer = gunzipSync(readFileSync(tgzPath))
  let extracted = 0
  for (const entry of listTarEntries(buffer)) {
    // 只要普通文件（`0` / NUL）。目录条目（`5`）由 writeFileSync 的 mkdir 顺带建出来。
    if (entry.typeFlag !== '0' && entry.typeFlag !== '\0') continue
    const name = entry.name.replace(/^package\//, '')
    // 我们自己的包不该有这些，但解包是"把字符串当路径用"，越界一律当场停。
    if (name.startsWith('/') || name.split('/').includes('..')) refuse(`tgz 里有越界路径：${entry.name}`)
    const dest = join(pkgRoot, name)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readEntryContent(buffer, entry))
    extracted += 1
  }
  note(`② 沙箱解包：${extracted} 个文件 → node_modules/${PKG_NAME}/`)
  for (const required of ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    if (!(await import('node:fs')).existsSync(join(pkgRoot, required))) fail(`装盘产物里缺少 ${required}`)
  }

  // ── 3. peer 依赖：软链仓库自己那份（见文件头"口径"第 3 条） ────────────────
  const peerSource = join(ROOT, 'node_modules', PEER_SCOPE)
  symlinkSync(peerSource, join(sandboxRoot, 'node_modules', PEER_SCOPE), process.platform === 'win32' ? 'junction' : 'dir')
  note(`③ peer 依赖：软链 ${PEER_SCOPE} → 仓库 node_modules`)

  // ── 4. 包里的构建标识必须与当前源码一致（否则冒烟测的是别的代码） ──────────
  const packedInfo = JSON.parse(readFileSync(join(pkgRoot, 'lib', 'build-info.json'), 'utf8'))
  const { computeBuildId } = await import('./build-info.mjs')
  const sourceBuildId = computeBuildId(ROOT)
  note(`④ 构建标识：包内 ${packedInfo.buildId} / 当前源码 ${sourceBuildId}`)
  if (packedInfo.buildId !== sourceBuildId) {
    fail(`包内构建标识与当前源码不一致（${packedInfo.buildId} ≠ ${sourceBuildId}）—— 冒烟会测到别的代码，结论无效`)
  }

  // ── 5. 从**沙箱里的产物** import，并用最小 ctx 桩真调 apply() ──────────────
  const ctx = makeStubContext()
  const dbPath = join(sandboxRoot, 'data', 'workbench.db')
  const entryUrl = pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href
  note(`⑤ 真启动：import(沙箱产物) + apply(ctx, { dbPath })`)

  let plugin
  try {
    plugin = await import(entryUrl)
  } catch (error) {
    refuse(`装盘产物的 lib/index.js 连 import 都进不去（模块解析失败）：${String(error)}`)
  }
  try {
    plugin.apply(ctx.stub, { dbPath })
  } catch (error) {
    fail(`插件入口 apply() 当场抛错：${String(error)}`)
  }

  // ── 6. 断言 ───────────────────────────────────────────────────────────────
  const degraded = ctx.logs.some((line) => /降级为空转/.test(line))
  if (degraded) fail(`apply() 掉进了降级空转（数据库打不开）：\n      ${ctx.logs.filter((l) => /降级为空转/.test(l)).join('\n      ')}`)

  const actualTools = [...ctx.tools.map((tool) => tool.name)].sort()
  const missing = EXPECTED_TOOLS.filter((name) => !actualTools.includes(name))
  const extra = actualTools.filter((name) => !EXPECTED_TOOLS.includes(name))
  if (missing.length > 0) fail(`工具面少了：${missing.join(' / ')}`)
  if (extra.length > 0) fail(`工具面多了（新工具必须同时更新 scripts/verify-installed.mjs 的 EXPECTED_TOOLS）：${extra.join(' / ')}`)
  if (missing.length === 0 && extra.length === 0) note(`   工具面 ${actualTools.length} 个：${actualTools.join(' ')}`)

  const routePaths = ctx.routes.map((route) => route.path)
  const missingRoutes = REQUIRED_ROUTES.filter((path) => !routePaths.includes(path))
  if (missingRoutes.length > 0) fail(`核心路由缺失：${missingRoutes.join(' / ')}`)
  if (routePaths.length === 0) fail('一条路由都没注册')
  note(`   路由 ${routePaths.length} 条`)

  // 只判"节在场"是不够的：`applyDegraded` 也用**同一个** `name: 'plugin:workbench'`
  // （见 src/index.ts 的 `degraded-prompt` 分支），所以那条判据分不出正常与降级。
  // 连着正文一起判，这条才算数 ——「有引导段」和「引导段是正常文案」是两件事。
  const prompt = ctx.sections.find((section) => section.name === 'plugin:workbench')
  if (prompt === undefined) fail('systemPrompt 里没有 plugin:workbench 引导段（AI 看不到工作台的存在）')
  else if (/降级空转/.test(String(prompt.text ?? ''))) fail('systemPrompt 的 plugin:workbench 节是**降级告警**文案，不是正常引导段')
  if (!ctx.commands.some((definition) => definition.name === 'workbench')) fail('`/workbench` 命令没有注册')
  if (!(await import('node:fs')).existsSync(dbPath)) fail(`apply() 没有真的建出数据库：${dbPath}（说明它没走到正常装配路径）`)

  // `apply` 本体也是产物的一部分：入口被掏空成 `export function apply() {}` 时上面全绿。
  if (plugin.name !== 'patent-workbench') fail(`入口 name 不是 patent-workbench：${String(plugin.name)}`)
  for (const service of ['webServer', 'systemPrompt', 'tools', 'commands']) {
    if (!plugin.inject.includes(service)) fail(`inject 少了 ${service}`)
  }
  note(`   入口 name=${plugin.name} · inject=[${plugin.inject.join(', ')}]`)
} catch (error) {
  // 环境错误在这里停下等 `finally` 清完沙箱；其余异常是真 bug，照旧往上抛。
  if (error instanceof RefuseError) refused = error.message
  else throw error
} finally {
  // 沙箱全在 mkdtemp 出来的临时目录里，失败也要清干净（Windows 上先关掉再删会 EPERM，
  // 但这里没有打开的句柄 —— 数据库连接由 apply() 持有，进程退出时随之释放）。
  rmSync(sandboxRoot, { recursive: true, force: true })
}

// 清完沙箱再报环境错误并退出 2（与"冒烟失败"的退出码 1 分开，见文件头）。
if (refused !== null) {
  console.error(`❌ ${refused}`)
  process.exit(2)
}

if (problems.length > 0) {
  console.log(`\n❌ 装后真启动冒烟未通过：${problems.length} 条`)
  process.exit(1)
}
console.log('\n✅ 装后真启动冒烟通过（产物能 import、入口能执行、工具面与路由符合预期）')
process.exit(0)

/**
 * 最小 ctx 桩：**只实现被真实调用的那几个方法**，每个都把结果记下来供断言。
 *
 * 刻意不做的两件事：
 * - **不给 `timer`**：`applyReady` 用 `ctx.inject(['timer'], cb)` 软取提醒调度，
 *   timer 不在时 cordis **不会**调 `cb` —— 桩照这个语义实现（只记录、不执行），
 *   于是这里跑的就是"宿主没装 timer 插件"那条真实的降级分支。
 * - **不给 `get('llm')` / `get('dshIm')` / `get('skills')`**：都是软探测，未安装返回 undefined，
 *   与真宿主上"没装那个插件"同形。
 *
 * `get('commands')` 必须给：`inject` 声明了 `commands`，宿主一定有它。
 */
function makeStubContext() {
  const tools = []
  const routes = []
  const sections = []
  const commands = []
  const logs = []
  const injected = []
  const record = (list) => (value) => { list.push(value); return () => {} }
  const commandService = { register: record(commands) }

  const stub = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug: () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    get: (name) => (name === 'commands' ? commandService : undefined),
    // 下划线前缀 = 有意不用的参数：这里**只记录** `inject` 请求、**不调** `cb`，
    // 复刻"宿主没装那个服务时 cordis 不会调回调"的语义（见上方 makeStubContext 文档）。
    inject: (names, _cb) => { injected.push(names); return () => {} },
    tools: { register: record(tools) },
    webServer: { register: record(routes) },
    systemPrompt: { section: record(sections), context: record([]) },
  }

  return { stub, tools, routes, sections, commands, logs, injected }
}
