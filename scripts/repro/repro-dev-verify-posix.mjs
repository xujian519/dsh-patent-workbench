/**
 * §4.2 的**真机**复现：验收链在非 Windows 上到底能不能"证明端口归属 → 停旧实例 → 拉起新实例"。
 *
 * ```sh
 * node scripts/repro/repro-dev-verify-posix.mjs            # 直接跑（自带清理）
 * node scripts/repro/repro-dev-verify-posix.mjs --json
 * ```
 *
 * ## 为什么必须真跑
 *
 * 单测覆盖的是"命令形状与解析分支"，用的是注入的假 `runCommandSync`；
 * 而这一段代码的全部风险恰恰在**真实世界那一侧**：`lsof` 的输出形态、
 * `ps -o comm=` 在 macOS 上给整条路径、`SIGTERM` 之后进程什么时候才真的消失、
 * 端口什么时候能重新 bind、`detached` 之后子进程活不活得下来。这些只能实测。
 *
 * ## 它动了什么（以及**不**动什么）—— 安全边界
 *
 * - **只碰它自己拉起来的诱饵进程**：诱饵是临时目录里的一个 stub（真监听端口、真收 SIGTERM），
 *   跑完逐个显式 kill 并核对已经死掉。不看、不动、不杀任何别人的进程。
 * - **绝不重启用户的实例**：本机 62620/19387 上跑的桌面端只拿来做**只读**的归属探测，
 *   用来证明"判据会拒绝桌面端"（这是本脚本最重要的一条负向证据）。
 * - 全程不改仓库、不改任何 profile、不写任何 DB。
 *
 * ## 六段实测（任一段不符就退出码 1）
 *
 * | 段 | 真实动作 | 期望 |
 * |---|---|---|
 * | 1 | `lsof` 探一个**空端口** | `{ok:true}` 且没有 owner |
 * | 2 | 只读探本机在跑的 dsh（桌面端） | 找到 pid/命令行，但归属判据**拒绝** |
 * | 3 | 诱饵：看起来**不是** dsh web 的 node 进程 | 硬拒绝，且诱饵**仍然活着**（没被误杀） |
 * | 4 | 诱饵：命令行是 `dsh web --port <P>` | 真 `SIGTERM` → 诱饵死 → 真拉起 stub → 端口重新在听 |
 * | 5 | 用 `--launcher` 交给自己的脚本 | POSIX 走 `sh <launcher>`，stub 起来 |
 * | 6 | 找不到 bin.js（探测路径全是假的） | `blocked:true` 透传（编排据此"继续跑但不报绿"） |
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPortOwnerCommandsPosix,
  findPortOwner,
  isTargetDshProcess,
  restartTarget,
  resolveDshCommand,
} from '../verify/runtime.mjs'

const JSON_OUT = process.argv.includes('--json')
const lines = []
const log = (text) => { lines.push(text); if (JSON_OUT !== true) console.log(text) }
let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) log(`  ✅ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  else { failures += 1; log(`  ✖ ${label}${detail === '' ? '' : ` —— ${detail}`}`) }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const cleanup = []
const cleanupAll = () => {
  for (const entry of cleanup.reverse()) {
    try { process.kill(entry.pid, 'SIGKILL') } catch { /* 已经死了 */ }
  }
}

/** 诱饵：真监听端口、真回 health、真能被 SIGTERM 杀掉（除非要求它扛住）。 */
const STUB = `const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const token = 'tok-' + Math.random().toString(36).slice(2)
const ignoreTerm = process.env.STUB_IGNORE_SIGTERM === '1'
if (ignoreTerm) process.on('SIGTERM', () => { console.log('SIGTERM ignored (on purpose)') })
const server = http.createServer((req, res) => {
  if (req.url === '/api/workbench/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); return }
  res.end('ok')
})
server.listen(port, '127.0.0.1', () => { console.log('stub listening http://127.0.0.1:' + port + '/?token=' + token) })
`

/** 起一个"命令行长得像 dsh web"的诱饵（这就是链的归属判据要放行的那种形态）。 */
function spawnDecoy({ stubPath, port, extraEnv = {}, argv = null }) {
  const args = argv ?? [stubPath, 'web', '--port', String(port), '--no-open']
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })
  child.unref()
  cleanup.push({ pid: child.pid, label: `decoy:${port}` })
  return child
}

async function waitForListening(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const owner = findPortOwner(port)
    if (owner.ok === true && owner.owner !== undefined) return owner.owner
    await sleep(150)
  }
  return undefined
}

async function main() {
  log('# §4.2 真机复现：非 Windows 的端口归属 / 停机 / 重启')
  log(`  平台 ${process.platform}｜node ${process.version}`)
  if (process.platform === 'win32') {
    log('  · Windows 上这段走 PowerShell（`test/verifySafety.test.mjs` 覆盖命令形状）；本脚本只测 POSIX 路径，跳过')
    return
  }
  const lsof = findPortOwner(1)
  log(`  lsof 命令：${buildPortOwnerCommandsPosix(1).listPids}`)
  if (lsof.ok !== true && lsof.blocked === true && /没有 lsof/.test(lsof.reason)) {
    log(`  ⚠️ 本机没有 lsof：链会判 blocked（这正是"能力缺失"那一支）。${lsof.reason}`)
  }

  const root = mkdtempSync(join(tmpdir(), 'wb-posix-repro-'))
  const stubPath = join(root, 'dsh', 'lib', 'bin.js')
  mkdirSync(join(root, 'dsh', 'lib'), { recursive: true })
  writeFileSync(stubPath, STUB, 'utf8')

  // ── 1. 空端口 ──────────────────────────────────────────────────────────────
  log('\n## 1. 空端口：`lsof` 退出码 1 应该被读成"没有监听者"，不是错误')
  const freePort = 30901
  const free = findPortOwner(freePort)
  check('空端口返回 ok:true 且无 owner', free.ok === true && free.owner === undefined, JSON.stringify(free))

  // ── 2. 本机在跑的 dsh：**只读**探测，判据必须拒绝 ────────────────────────────
  log('\n## 2. 本机正在跑的实例（只读探测）：判据必须拒绝它，绝不能杀')
  const guiPorts = [process.env.DSH_WEB_URL, 'http://127.0.0.1:62620', 'http://127.0.0.1:19387']
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => { try { return Number(new URL(value).port) } catch { return Number(value) } })
    .filter((port) => Number.isInteger(port) && port > 0)
  for (const port of [...new Set(guiPorts)]) {
    const owner = findPortOwner(port)
    if (owner.ok !== true || owner.owner === undefined) { log(`  · 端口 ${port} 上没有监听者，跳过`); continue }
    const verdict = isTargetDshProcess(owner.owner, { port, profile: 'web' })
    check(`端口 ${port} 的归属被拒绝（${owner.owner.name} / PID ${owner.owner.pid}）`, verdict.ok !== true, verdict.reason)
    const alive = isAlive(owner.owner.pid)
    check(`拒绝之后那个进程仍然活着（PID ${owner.owner.pid}）`, alive === true)
  }

  // ── 3. 诱饵：不像 dsh web 的 node 进程 → 硬拒绝，且不许误杀 ────────────────
  log('\n## 3. 诱饵 ≠ dsh web：必须硬拒绝（不带 blocked），且诱饵必须活着')
  const otherPort = 30902
  const other = spawnDecoy({ stubPath, port: otherPort, argv: ['-e', `require('node:http').createServer((q,s)=>s.end('x')).listen(${otherPort},'127.0.0.1')`] })
  const otherListening = await waitForListening(otherPort)
  check('诱饵已在监听', otherListening !== undefined)
  const refused = await restartTarget({ port: otherPort, profile: 'web', env: {}, logPath: join(root, 'other.log'), workDir: root })
  check('重启被拒绝', refused.ok === false, refused.reason)
  check('拒绝原因是"拒绝 kill"（不是 blocked）', refused.blocked !== true && /拒绝 kill/.test(refused.reason ?? ''), JSON.stringify({ blocked: refused.blocked, reason: refused.reason }))
  check('诱饵**没有**被误杀', isAlive(other.pid) === true, `PID ${other.pid}`)

  // ── 4. 诱饵 = dsh web 形态 → 真 SIGTERM + 真拉起 ───────────────────────────
  log('\n## 4. 诱饵 = `dsh web --port <P>`：真找归属 → 真 SIGTERM → 真拉起新实例')
  const port = 30903
  const decoy = spawnDecoy({ stubPath, port })
  const decoyOwner = await waitForListening(port)
  check('诱饵已在监听且归属可查', decoyOwner !== undefined, JSON.stringify(decoyOwner))
  const accepted = isTargetDshProcess(decoyOwner, { port, profile: 'web' })
  check('归属判据放行（这就是"目标实例"的形态）', accepted.ok === true, accepted.reason)

  const logPath = join(root, 'dsh-server-30903.log')
  writeFileSync(logPath, '', 'utf8')
  const restarted = await restartTarget({
    port,
    profile: 'web',
    workDir: root,
    logPath,
    env: { DSH_VERIFY_DSH_CMD: `${process.execPath} ${stubPath}` },
  })
  check('重启成功', restarted.ok === true, JSON.stringify({ ok: restarted.ok, method: restarted.method, killedPid: restarted.killedPid, pid: restarted.pid, reason: restarted.reason }))
  check('被停掉的就是那个诱饵 PID', restarted.killedPid === decoy.pid, `killedPid=${restarted.killedPid} / decoy=${decoy.pid}`)
  await sleep(300)
  check('诱饵真的死了（SIGTERM 之后等到了它退出）', isAlive(decoy.pid) === false)
  const after = await waitForListening(port)
  check('同一个端口上已经有新的监听者（说明旧实例确实让开了端口）', after !== undefined && after.pid !== decoy.pid, JSON.stringify(after))
  const logText = readFileSync(logPath, 'utf8')
  check('新实例的标准输出**落进了日志文件**（不走管道、不走 msys 那一层）', /token=/.test(logText), `${logText.trim().slice(0, 120)}`)
  if (after !== undefined) cleanup.push({ pid: after.pid, label: 'relaunched' })
  if (typeof restarted.pid === 'number') cleanup.push({ pid: restarted.pid, label: 'relaunched-shell' })

  // ── 5. --launcher：POSIX 走 sh ────────────────────────────────────────────
  log('\n## 5. `--launcher`：POSIX 上必须走 `sh`（老代码只会 `cmd /c`，macOS 上起不来）')
  const launcherPort = 30904
  const launcherPath = join(root, 'restart-web.sh')
  const launcherLog = join(root, 'launcher-stub.log')
  /**
   * ⚠️ 启动器**必须自己返回**（把实例丢到后台）。
   *
   * 这不是脚本的洁癖，是 2026-10-06 实测撞出来的：第一版写成 `exec node <stub> ...`
   * （前台跑实例），`restartTarget` 里的 `run()` 就在等这个子进程退出 ——
   * 实例永不退出，于是链一路等到 180s 超时才返回。契约写在 `--help` 与文档里。
   */
  writeFileSync(launcherPath, `#!/bin/sh\n"${process.execPath}" "${stubPath}" web --port ${launcherPort} --no-open > "${launcherLog}" 2>&1 &\nexit 0\n`, 'utf8')
  const launcherStarted = Date.now()
  const viaLauncher = await restartTarget({ port: launcherPort, profile: 'web', workDir: root, launcher: launcherPath, logPath: join(root, 'launcher.log'), env: {} })
  const launcherMs = Date.now() - launcherStarted
  check('启动器返回 ok', viaLauncher.ok === true && viaLauncher.method === 'launcher', JSON.stringify({ ok: viaLauncher.ok, method: viaLauncher.method, reason: viaLauncher.reason }))
  check('启动器自己返回了（没有把链挂住）', launcherMs < 10000, `${launcherMs}ms`)
  const launcherOwner = await waitForListening(launcherPort)
  check('启动器真的把实例拉起来了', launcherOwner !== undefined, JSON.stringify(launcherOwner))
  if (launcherOwner !== undefined) cleanup.push({ pid: launcherOwner.pid, label: 'launcher' })

  // ── 6. 找不到 bin.js → blocked 透传 ───────────────────────────────────────
  log('\n## 6. 找不到 dsh 的 bin.js：必须 `blocked:true`（下游照跑、本轮不报绿），而不是硬失败')
  const resolved = resolveDshCommand({}, { platform: process.platform, existsSync: () => false, homedir: () => join(root, 'nohome') })
  check('探测结论是 missing', resolved.kind === 'missing', resolved.reason)
  const blockedRun = await restartTarget(
    { port: 30905, profile: 'web', workDir: root, logPath: join(root, 'blocked.log'), env: {} },
    { resolveDshCommand: () => resolved },
  )
  check('blocked 透传到编排', blockedRun.ok === false && blockedRun.blocked === true && blockedRun.exitCode === 2, JSON.stringify(blockedRun))
  log(`  真实台的 dsh 入口：${JSON.stringify(resolveDshCommand(process.env))}`)
  log(`  探测过的候选：${existsSync(join(root, 'nohome')) ? '(临时目录被创建了？)' : '(未创建任何目录)'}`)

  rmSync(root, { recursive: true, force: true })
}

try {
  await main()
} catch (error) {
  failures += 1
  log(`✖ 脚本内部异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  cleanupAll()
  await sleep(300)
}

log('')
log(`=== ${failures === 0 ? '全部通过' : `${failures} 段不符`} ===`)
if (JSON_OUT) console.log(JSON.stringify({ failures, lines }, null, 2))
process.exit(failures === 0 ? 0 : 1)
