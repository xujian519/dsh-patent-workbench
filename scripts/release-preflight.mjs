#!/usr/bin/env node
/**
 * 发布门禁：**一条命令跑完所有机械判据**。
 *
 * ## 为什么要有它
 *
 * `dsh-release` skill 的门禁原来只写在文档里，靠人逐条记得 —— 2026-10-01 发 v1.16.1 时
 * **变异探针那条就被整条漏跑了**（skill 里写的路径还是过时的，照着敲根本找不到文件），
 * 补跑后才发现 3 处判据盲点。结论：**门禁要能被执行，而不是被记住**。
 *
 * ## 两个阶段
 *
 * ```sh
 * node scripts/release-preflight.mjs                 # 发版前：typecheck / 单测 / 全探针 / PII / 文档与版本号
 * node scripts/release-preflight.mjs --phase post --version 1.16.2   # 发布后：只信 tarball 的产物对账
 * ```
 *
 * ## 三条设计纪律
 *
 * 1. **欠账显式登记、双向断言**：名单外的红 → 失败；名单里已经不红的 → **也失败**
 *    （见 `scripts/lib/releasePreflight.mjs` 头部说明）。
 * 2. **探针之间必须 `pnpm build`**：探针只还原 `src/` 而**不重建 `lib/`**，
 *    连着跑会把上一个变异体的构建产物留给下一个，跑出**假红**（本次实测：单跑 0/4，
 *    `pnpm build` 后 83/83）。
 * 3. **发布复核一律直连 registry**，不用 `npm view` / `npm i` 当判据 ——
 *    它们会命中**本地 npm 缓存**，而中间态（元数据 200、tarball 404、网页显示 Published）
 *    正是靠直连才认出来的。
 * 4. **探针批次前后必须核对工作区指纹**（`src` + `lib` 逐字节），且每条命令都有墙钟上限
 *    （`run()` / `runNode()`；探针走不经 shell 的那条，好让超时信号直达探针的护栏）。
 *    理由：探针是唯一一条**门禁自己改写发布产物**的路径 —— 残留的 `src/` 会被下一次
 *    `pnpm build` 烘焙进 `lib/`，残留的 `lib/` 更是直接随包发出（审计 §4.3）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  judgePii, judgePostArtifact, judgePreVersion, judgeProbes, judgeTests, judgeWorkspaceResidue,
  merge, parsePiiRules, parseProbeResult, parseTestSummary,
} from './lib/releasePreflight.mjs'
import { describeRecovery, recoverCrashedSessions } from './lib/mutationGuard.mjs'
import { diffFingerprints, fingerprintWorkspace, formatDrift } from './lib/workspaceFingerprint.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name

/**
 * curl 的**可执行名**与"丢弃输出"的 sink —— 两个平台不一样，不能写死。
 *
 * 原先这里逐字写 `curl.exe` + `-o NUL`（5 处）：门禁**只能在 Windows 上跑**，
 * 换到 macOS/Linux 会以 `curl.exe: command not found` 的形式全阶段失败 ——
 * 而发布门禁恰恰是最该在任何机器上都能执行的东西（"门禁要能被执行，而不是被记住"）。
 */
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'
const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * 显式登记的**已知失败**。用例名必须完全相等。
 * 每加一条都要问自己：这是"与本次改动无关的历史问题"吗？有 issue 追踪吗？
 */
const KNOWN_TEST_FAILURES = [
  {
    test: 'db migrations, dictionaries and task tree',
    reason: 'Windows 清理期 rmSync EPERM（既有环境问题、与代码无关；已长期存在，不删断言）',
  },
]

/**
 * 显式登记的**已知探针欠账**（还清了必须删掉，否则门禁会红）。
 *
 * ⚠️ 每条都要写清是**真盲点**（装回缺陷后仍全绿 → 要补判据）还是**探针失效**
 *（变异点没匹配上 → 要重锚探针）。两者混在一起会让这份名单同时虚高与虚低 ——
 * 详见 `docs/issues/2026-10-01-mutation-probe-maintenance.md`。
 */
const KNOWN_PROBE_DEBT = [
  {
    probe: 'probe-model-picker-notify-mutations',
    reason: '失效 3 条（B7/B8/B10：selectionToApply / unavailableReason / clearExitReachable 的写法与位置变了）—— '
      + '**无真盲点**，重锚即可',
  },
  {
    probe: 'probe-quick-workspace-mutations',
    reason: '失效 2 条（M6/M14：调用点与按钮渲染条件已换位置，需重锚）—— 真盲点 M10 已于 2026-10-02 补判据并销账',
  },
  // probe-capacity-mutations 的欠账曾于 2026-10-02 全部销账（20/20 全红）。2026-10-03 容量功能
  // 整体删除（决策 4），该探针连同它锚定的容量账本一起删除 —— 探针按 `scripts/repro/probe-*-mutations.mjs`
  // 自动发现，删文件即自动出列（名单里若再留有它，双向断言会让门禁直接失败："盲点已消除，请从名单删掉"）。
]

/** PII 扫描的良性规则基线（逐条人工判断过）。 */
const PII_BASELINE = ['通用占位家目录（允许，仅提示）', '凭据文件名引用']

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const PHASE = valueOf('--phase', 'pre')
const VERSION = valueOf('--version', PHASE === 'pre' ? PKG.version : null)
const ONLY = valueOf('--only', null)
const SKIP_INSTALL = has('--no-install')
const JSON_OUT = valueOf('--json', null)

/**
 * 每条命令的**墙钟上限**（毫秒）。为什么必须有：门禁是发布前最后一道机械关卡，
 * 一条挂住的命令会让它**永远不返回** —— 那比报错更难发现（人和 CI 都以为"还在跑"）。
 *
 * ⚠️ **实测（2026-10-05）的边界**：`spawnSync` 的 `timeout` 只把信号发给**直接子进程**。
 * 在 `shell: true` 且命令是复合语句时，`sh` 才是直接子进程，**孙进程会活下来继续写盘**
 * （实测：命令返回之后 marker 文件仍在增长）。所以本脚本两条规矩：
 *
 * 1. `node` 类命令一律走 `runNode()`（**不经 shell**）→ 超时信号直达探针，
 *    护栏的 `SIGTERM` 处理器能把工作区还原干净再退出；
 * 2. 超时一律记 **失败**（不是"重试看看"），且探针批次收尾的工作区指纹就是对
 *    "活下来的孙进程"的兜底判据。
 */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const TEST_TIMEOUT_MS = 30 * 60 * 1000
const PROBE_TIMEOUT_MS = 20 * 60 * 1000

/** 把 `spawnSync` 的结果归一成 `{code, out, timedOut}`（输出合并 stderr，便于把失败原因原样打出来）。 */
function describeResult(result, timeoutMs) {
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const suffix = timedOut
    ? `\n⏱️ 超过 ${timeoutMs} ms 未结束，已 SIGTERM（注意：spawnSync 只杀直接子进程）`
    : ''
  return { code: result.status === null ? 1 : result.status, out: out + suffix, timedOut }
}

/** 跑一条命令（**经 shell**，用于 `pnpm` 这类需要 PATH 解析的可执行名）。 */
function run(command, { cwd = ROOT, env = {}, timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return describeResult(result, timeoutMs)
}

/**
 * 跑一个 node 脚本，**不经 shell**：超时信号直达脚本本身。
 *
 * 这条不是洁癖 —— 探针超时若只 SIGTERM 到 `sh`，探针进程会带着变异体活下来继续跑
 * （实测见上面的注释块）。直接 exec 后 `SIGTERM` 交给探针的护栏，它能还原再退出（143）。
 */
function runNode(script, args = [], { cwd = ROOT, env = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return describeResult(result, timeoutMs)
}

/** 直连 HTTP（**绕开 npm 本地缓存**）：用 curl 拿 `{code, out}`（可执行名见 `CURL`）。 */
function curl(url, extra = []) {
  return run(`${CURL} -sS --max-time 120 -o ${NULL_SINK} -w "%{http_code}" ${extra.join(' ')} "${url}"`)
}

function curlJson(url, extra = []) {
  return run(`${CURL} -sS --max-time 120 ${extra.join(' ')} "${url}"`)
}

const results = []
function add(name, verdict) { results.push({ name, verdict }) }
function banner(text) { console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}`) }
function show(verdict) {
  for (const d of verdict.debts) console.log(`   ⚠️  ${d}`)
  for (const n of verdict.notes) console.log(`   ℹ️  ${n}`)
  for (const f of verdict.failures) console.log(`   ❌ ${f}`)
  if (verdict.failures.length === 0) console.log('   ✅ 通过')
}

// ───────────────────────────────────────────────────────────────────────────
// 发版前
// ───────────────────────────────────────────────────────────────────────────

function gateTypecheck() {
  banner('1/5 类型检查')
  const r = run('pnpm typecheck')
  console.log(r.code === 0 ? '   ✅ typecheck 0' : r.out.trim().split('\n').slice(-8).map((l) => `   ${l}`).join('\n'))
  add('typecheck', { ok: r.code === 0, failures: r.code === 0 ? [] : ['pnpm typecheck 非 0'], debts: [], notes: [] })
}

function gateTests() {
  banner('2/5 全量单测')
  const r = run('pnpm test', { timeoutMs: TEST_TIMEOUT_MS })
  const summary = parseTestSummary(r.out)
  const verdict = judgeTests(summary, KNOWN_TEST_FAILURES)
  console.log(`   ℹ️  tests ${summary.tests} / pass ${summary.pass} / fail ${summary.fail}`)
  show(verdict)
  add('单测', verdict)
}

/**
 * 3/5 变异探针。
 *
 * ## 为什么开头先做"崩溃恢复"、结尾必做"工作区指纹"
 *
 * 探针必须**改写工作区**才能证明断言有牙（改 `src/` 或直接改 `lib/`）。
 * 于是门禁自己成了唯一一条"污染发布产物"的路径（审计 §4.3）。三道处理：
 *
 * 1. **开跑前**：`recoverCrashedSessions()` 收拾上一次被 SIGKILL/断电留下的账本
 *    （能被捕获的信号已由探针内的护栏处理）；
 * 2. **整批前后**：对 `src` + `lib` 拍指纹并逐字节比对 —— 与 git 无关，
 *    所以**脏工作区同样成立**（`git diff --quiet` 在未提交改动上必然误判）；
 * 3. 残留一律记**失败**，并且把探针调用改成 `runNode()`（不经 shell），
 *    让超时信号直达探针的护栏而不是停在 `sh` 上。
 */
function gateProbes() {
  banner('3/5 变异探针（每个之间 pnpm build —— 探针只还原工作区，不重建 lib）')

  // 3a. 上次没走完的账本（SIGKILL / 断电 / CI 被砍）
  const recovery = recoverCrashedSessions()
  if (recovery.recovered.length > 0 || recovery.damaged.length > 0 || recovery.skipped.length > 0) {
    console.log(`   🔧 崩溃恢复：${describeRecovery(recovery)}`)
  }

  // 3b. 跑前基线。**先构建一次**：让指纹里的 lib/ 是本轮构建的确定内容，
  //     而不是"上一轮构建 + 某个探针残留"的混合体（否则漂移判据会指向错误的地方）。
  const files = readdirSync(join(ROOT, 'scripts', 'repro'))
    .filter((f) => /^probe-.*-mutations\.mjs$/.test(f))
    .sort()
  if (files.length > 0) {
    const warm = run('pnpm build', { timeoutMs: BUILD_TIMEOUT_MS })
    if (warm.code !== 0) {
      console.log(`   ❌ 跑前构建失败（探针的基线不可信）：`)
      console.log(warm.out.trim().split('\n').slice(-8).map((l) => `      ${l}`).join('\n'))
    } else if (warm.timedOut) {
      console.log('   ❌ 跑前构建超时 —— 见下面的构建失败记录')
    }
  }
  const before = fingerprintWorkspace()
  console.log(`   ℹ️ 跑前基线：${before.count} 个文件（src + lib），digest ${before.digest.slice(0, 16)}`)

  const parsed = []
  for (const file of files) {
    const build = run('pnpm build', { timeoutMs: BUILD_TIMEOUT_MS })
    if (build.code !== 0) {
      console.log(`   ❌ ${file}：构建失败${build.timedOut ? '（超时）' : ''}，探针无法执行`)
      parsed.push({ id: file, caughtAll: false, caught: 0, total: 0, stale: false, unreliable: true, survived: null, detail: `构建失败${build.timedOut ? '（超时）' : ''}` })
      continue
    }
    const r = runNode(`scripts/repro/${file}`, [], { timeoutMs: PROBE_TIMEOUT_MS })
    const verdict = parseProbeResult({ id: file.replace(/\.mjs$/, ''), exitCode: r.code, stdout: r.out })
    if (r.timedOut) {
      verdict.caughtAll = false
      verdict.detail = `⏱️ 超过 ${Math.round(PROBE_TIMEOUT_MS / 60000)} 分钟未结束，被 SIGTERM（护栏已还原工作区；输出可能被截断）`
    }
    parsed.push(verdict)
    const mark = verdict.caughtAll ? '✅' : '❌'
    console.log(`   ${mark} ${verdict.id}：${verdict.detail}`)
  }
  const probeVerdict = judgeProbes(parsed, KNOWN_PROBE_DEBT)
  show(probeVerdict)
  add('探针', probeVerdict)

  // 3c. 逐字节核对：跑完之后工作区必须回到跑之前
  const after = fingerprintWorkspace()
  const drift = diffFingerprints(before, after)
  if (drift.length > 0) console.log(formatDrift(drift))
  const residueVerdict = judgeWorkspaceResidue({ drift, recovery, before })
  show(residueVerdict)
  add('探针残留', residueVerdict)
}

function gatePii() {
  banner('4/5 PII（两个面：GitHub 跟踪 + 随包 lib/**）')
  const r = run('node scripts/check-pii.mjs')
  const rules = parsePiiRules(r.out)
  const verdict = judgePii(rules, PII_BASELINE)
  show(verdict)
  add('PII', verdict)
}

function gateVersionDocs() {
  banner('5/5 版本号与文档就位')
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const verdict = judgePreVersion({
    plannedVersion: VERSION,
    packageVersion: PKG.version,
    releaseNotesExists: existsSync(join(ROOT, 'docs', 'releases', `v${VERSION}.md`)),
    readmeHasVersionRow: new RegExp(`\\|\\s*\\*{0,2}${VERSION.replace(/\./g, '\\.')}`).test(readme),
  })
  show(verdict)
  add('版本与文档', verdict)
}

// ───────────────────────────────────────────────────────────────────────────
// 发布后
// ───────────────────────────────────────────────────────────────────────────

function gateArtifact() {
  banner(`发布后 1/2 产物对账（version=${VERSION}）`)
  if (VERSION === null) {
    add('产物对账', { ok: false, failures: ['post 阶段必须给 --version'], debts: [], notes: [] })
    return
  }
  const encoded = PKG_NAME.replace('/', '%2f').replace('@', '@')
  const tags = curlJson(`https://registry.npmjs.org/-/package/${PKG_NAME}/dist-tags`)
  let latest = null
  try { latest = JSON.parse(tags.out).latest ?? null } catch { latest = null }
  const doc = curlJson(`https://registry.npmjs.org/${encoded}/${VERSION}`)
  let expectedSha1 = null
  let versionDocStatus = null
  try {
    const parsed = JSON.parse(doc.out)
    expectedSha1 = parsed?.dist?.shasum ?? null
    versionDocStatus = parsed?.version === VERSION ? 200 : null
  } catch { versionDocStatus = null }
  const tarballUrl = `https://registry.npmjs.org/${PKG_NAME}/-/${PKG_NAME.split('/')[1]}-${VERSION}.tgz`
  const tarballStatus = Number(curl(tarballUrl).out.trim()) || null
  let sha1 = null
  if (tarballStatus === 200) {
    const tmp = join(ROOT, '_local-build', `preflight-${VERSION}.tgz`)
    mkdirSync(join(ROOT, '_local-build'), { recursive: true })
    run(`${CURL} -sSL --max-time 300 -o "${tmp}" "${tarballUrl}"`)
    const h = run(`node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha1').update(f.readFileSync(process.argv[1])).digest('hex'))" "${tmp}"`)
    sha1 = h.out.trim().split(/\r?\n/).pop() ?? null
  }
  console.log(`   ℹ️  dist-tags.latest=${String(latest)}  versionDoc=${String(versionDocStatus)}  tarball=${String(tarballStatus)}`)
  const verdict = judgePostArtifact({ plannedVersion: VERSION, distTagLatest: latest, versionDocStatus, tarballStatus, sha1, expectedSha1 })
  show(verdict)
  add('产物对账', verdict)

  if (!SKIP_INSTALL) {
    banner('发布后 1b 用户视角安装（空目录 + 全新缓存，走 latest）')
    const dir = join(ROOT, '_local-build', `preflight-install-${VERSION}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'preflight-smoke', private: true }), 'utf8')
    const r = run(`npm i ${PKG_NAME} --no-audit --no-fund --cache "${join(dir, '.npmcache')}"`, { cwd: dir, timeoutMs: TEST_TIMEOUT_MS })
    const installed = existsSync(join(dir, 'node_modules', ...PKG_NAME.split('/'), 'package.json'))
      ? JSON.parse(readFileSync(join(dir, 'node_modules', ...PKG_NAME.split('/'), 'package.json'), 'utf8')).version
      : null
    const ok = r.code === 0 && installed === VERSION
    console.log(ok ? `   ✅ 装到 ${String(installed)}` : `   ❌ 安装失败或版本不符（装到 ${String(installed)}）`)
    if (!ok) console.log(r.out.trim().split('\n').slice(-6).map((l) => `      ${l}`).join('\n'))
    add('用户视角安装', { ok, failures: ok ? [] : [`npm i ${PKG_NAME} 没装到 ${VERSION}`], debts: [], notes: [] })
  }
}

function gateGitHubRelease() {
  banner('发布后 2/2 GitHub Release（走本机代理，公开端点不需要 token）')
  const proxy = process.env.DSH_GITHUB_PROXY ?? 'http://127.0.0.1:5782'
  const r = run(`${CURL} -sS --max-time 60 -x ${proxy} -H "User-Agent: dsh-preflight" -H "Accept: application/vnd.github+json" https://api.github.com/repos/xujian519/dsh-patent-workbench/releases/latest`)
  let tag = null
  try { tag = JSON.parse(r.out).tag_name ?? null } catch { tag = null }
  const ok = tag === `v${VERSION}`
  console.log(ok ? `   ✅ releases/latest = ${String(tag)}` : `   ❌ releases/latest = ${String(tag)}（期望 v${VERSION}）—— 只推 tag 不等于建了 Release`)
  add('GitHub Release', { ok, failures: ok ? [] : [`releases/latest 是 ${String(tag)}，不是 v${VERSION}`], debts: [], notes: [] })
}

// ───────────────────────────────────────────────────────────────────────────

const PLAN = PHASE === 'post'
  ? [['artifact', gateArtifact], ['github', gateGitHubRelease]]
  : [['typecheck', gateTypecheck], ['tests', gateTests], ['probes', gateProbes], ['pii', gatePii], ['version', gateVersionDocs]]

console.log(`发布门禁 · phase=${PHASE} · pkg=${PKG_NAME}@${String(VERSION)}`)
for (const [key, fn] of PLAN) {
  if (ONLY !== null && ONLY !== key) continue
  fn()
}

const summary = merge(results)
banner('汇总')
for (const d of summary.debts) console.log(`   ⚠️  ${d}`)
for (const n of summary.notes) console.log(`   ℹ️  ${n}`)
for (const f of summary.failures) console.log(`   ❌ ${f}`)
console.log(summary.ok
  ? `\n✅ 门禁通过（欠账 ${summary.debts.length} 条，见上）`
  : `\n❌ 门禁未通过：${summary.failures.length} 条阻塞项`)

if (JSON_OUT !== null) {
  const path = resolve(ROOT, JSON_OUT)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ phase: PHASE, version: VERSION, ...summary }, null, 2), 'utf8')
  console.log(`   证据已写入 ${path}`)
}

process.exit(summary.ok ? 0 : 1)
