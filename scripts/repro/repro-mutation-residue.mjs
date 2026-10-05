/**
 * 复现 + 验证：**变异探针被强杀后，工作区会不会带着变异体跑进发布产物**（审计 §4.3）。
 *
 * ## 它演示的完整链条
 *
 * 1. 在**真实仓库**里对一个真实源文件注入变异体（走护栏：先备份、再改）；
 * 2. 用 `SIGKILL` 把注入者干掉（`finally` 与信号处理器都**没有机会**执行）；
 * 3. 证明残留**确实发生**：工作区指纹漂移 1 处、备份目录里留着 `state:open` 的账本；
 * 4. 证明下一道腿能救回来：`recoverCrashedSessions()` 从备份还原；
 * 5. 证明最终状态与跑前**逐字节相同**（这才是判据）。
 *
 * 为什么不用"容器内造几个文件"就够了：判据的数字（多少个文件、源文件长什么样）
 * 必须在**真仓库**上成立 —— 本仓反复吃过"夹具上全对、真数据上不对"的亏。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/repro/repro-mutation-residue.mjs            # 默认 dry-run：只报当前状态，不改一个字
 * node scripts/repro/repro-mutation-residue.mjs --apply    # 真做（会短暂改写一个源文件，随后自动还原）
 * ```
 *
 * ⚠️ `--apply` 期间若**本进程**也被 `SIGKILL`：`src/client/index.tsx` 会是 `MUTATED` 形态。
 * 恢复方式（三步任一）：
 * - 再跑一次 `node scripts/repro/repro-mutation-residue.mjs --apply`（开头自动恢复）；
 * - `node scripts/release-preflight.mjs --only probes`（门禁开头也会恢复）；
 * - 手工：`cp _local-build/mutation-backup/src__client__index.tsx src/client/index.tsx`
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_DIR_RELATIVE, recoverCrashedSessions } from '../lib/mutationGuard.mjs'
import { diffFingerprints, fingerprintWorkspace } from '../lib/workspaceFingerprint.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const CHILD = join(ROOT, 'test', 'fixtures', 'mutationGuardChild.mjs')
const TARGET = 'src/client/index.tsx'
const TARGET_ABS = join(ROOT, TARGET)
const LABEL = 'repro-mutation-residue'
const BACKUP_DIR = join(ROOT, BACKUP_DIR_RELATIVE)
const logger = { log: (m) => console.log(m), error: (m) => console.error(m) }
const apply = process.argv.includes('--apply')

function manifests() {
  return existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).sort() : []
}

function openManifests() {
  return manifests().filter((name) => {
    if (!name.endsWith('.json')) return false
    try { return JSON.parse(readFileSync(join(BACKUP_DIR, name), 'utf8')).state === 'open' } catch { return false }
  })
}

/** 注入变异体并**立刻 SIGKILL** 注入者（模拟断电 / CI 被砍 / 内核 panic）。 */
function injectAndKill() {
  return new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, [CHILD, '--root', ROOT, '--file', TARGET, '--label', LABEL, '--mode', 'block', '--text', 'MUTATED_BY_REPRO\n'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let stderr = ''
    let killed = false
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
      if (out.includes('READY') && !killed) {
        killed = true
        setTimeout(() => child.kill('SIGKILL'), 50)
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const bail = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('exit', (code, signal) => {
      clearTimeout(bail)
      if (!killed) return reject(new Error(`注入者没等到变异体落盘就退出了（code=${String(code)} signal=${String(signal)}）：${stderr}`))
      resolveDone({ signal })
    })
  })
}

// ───────────────────────────────────────────────────────────────────────────

console.log(`变异残留复现 · ${apply ? '--apply（真改，随后自动还原）' : 'dry-run（只读）'}`)
console.log(`   仓库根：${ROOT}`)
console.log(`   目标文件：${TARGET}`)

const stale = openManifests()
if (stale.length > 0) {
  console.log(`\n⚠️ 发现上一次没走完的账本（${stale.join('、')}）—— 先恢复：`)
  const r = recoverCrashedSessions({ root: ROOT, logger })
  console.log(`   还原 ${r.restored.length} 个文件、待人工确认 ${r.damaged.length} 项`)
}

const before = fingerprintWorkspace()
console.log(`\n跑前指纹：${before.count} 个文件（src + lib），digest ${before.digest.slice(0, 16)}`)

if (!apply) {
  console.log(`\n（dry-run 到此为止。加 --apply 才会真的注入变异体并 SIGKILL 注入者。）`)
  console.log(`当前没有任何 open 账本：${stale.length === 0 ? '✅' : '❌'}`)
  process.exit(0)
}

let residueSeen = false
let fingerprintDrift = []
try {
  console.log('\n1) 注入变异体 → 立刻 SIGKILL 注入者（`finally` / 信号处理器都跑不到）')
  const killed = await injectAndKill()
  console.log(`   注入者已被 ${String(killed.signal)} 收走`)

  console.log('\n2) 残留是否真的发生？')
  const mutated = readFileSync(TARGET_ABS, 'utf8')
  residueSeen = mutated === 'MUTATED_BY_REPRO\n'
  console.log(`   ${TARGET} 现在是：${JSON.stringify(mutated.slice(0, 40))} —— ${residueSeen ? '⚠️ 残留（预期）' : '❌ 没残留？那这个复现就没成立'}`)
  fingerprintDrift = diffFingerprints(before, fingerprintWorkspace())
  console.log(`   工作区指纹漂移 ${fingerprintDrift.length} 处：${fingerprintDrift.map((d) => d.path).join('、') || '（无）'}`)
  const opens = openManifests()
  console.log(`   open 账本：${opens.join('、') || '（无）'}`)
  const backupFile = join(BACKUP_DIR, 'src__client__index.tsx')
  console.log(`   原文备份在盘上：${existsSync(backupFile) ? '✅' : '❌'}（${BACKUP_DIR_RELATIVE}/src__client__index.tsx）`)
  if (!residueSeen || fingerprintDrift.length !== 1 || opens.length !== 1) {
    throw new Error('复现没有成立 —— 判据（残留 / 漂移 / open 账本）与实际不符，先查清楚再谈修复')
  }

  console.log('\n3) 崩溃恢复：下一个进程从账本 + 备份还原')
  const recovery = recoverCrashedSessions({ root: ROOT, logger })
  console.log(`   还原 ${recovery.restored.length} 个文件，待人工确认 ${recovery.damaged.length} 项`)
  if (recovery.restored.length !== 1 || recovery.damaged.length !== 0) {
    throw new Error(`恢复结果不符合预期：restored=${recovery.restored.length} damaged=${recovery.damaged.length}`)
  }

  console.log('\n4) 最终判据：与跑前**逐字节相同**')
  const after = fingerprintWorkspace()
  const finalDrift = diffFingerprints(before, after)
  console.log(`   digest ${after.digest.slice(0, 16)} vs 跑前 ${before.digest.slice(0, 16)} —— ${finalDrift.length === 0 ? '✅ 相同' : `❌ 仍有 ${finalDrift.length} 处漂移`}`)
  if (finalDrift.length !== 0) throw new Error(`仍有漂移：${finalDrift.map((d) => d.path).join('、')}`)

  console.log('\n✅ 链条完整：注入 → SIGKILL → 残留（指纹看得见）→ 恢复 → 逐字节回到原样')
} finally {
  // 自己也要留一条后路：万一上面某步抛错，别把变异体留在盘上。
  const recovery = recoverCrashedSessions({ root: ROOT, logger: { log: () => {}, error: () => {} } })
  const left = readFileSync(TARGET_ABS, 'utf8') === 'MUTATED_BY_REPRO\n'
  if (left) {
    console.error(`\n❌ 收尾时发现 ${TARGET} 仍是变异体 —— 请手工恢复（见本脚本头部说明）`)
    process.exitCode = 2
  } else if (recovery.damaged.length > 0) {
    console.error(`\n❌ 收尾时仍有 ${recovery.damaged.length} 项需要人工确认`)
    process.exitCode = 2
  } else if (process.exitCode === undefined) {
    process.exitCode = residueSeen ? 0 : 1
  }
}
