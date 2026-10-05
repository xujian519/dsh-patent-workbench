/**
 * 探针安全化的**接线棘轮**（审计 §4.3）—— 防止"修好的护栏下次被绕过"。
 *
 * ## 为什么需要"接线"这一层测试
 *
 * 护栏与指纹都是**能力**，能力不接线就等于不存在：
 *
 * - 新增一个探针时忘了 `createMutationGuard` → 这个探针又变成"`finally` 自觉"；
 * - 有人图省事把探针调用改回 `run('node scripts/repro/...')` → 超时信号停在 `sh` 上，
 *   探针（孙进程）带着变异体活下来（本轮**实测**过这个形态）；
 * - 有人把整批探针前后那两个指纹调用删了 → 残留判据静默消失，门禁照样报绿。
 *
 * 这三种都不会被行为测试发现（行为测试测的是"现在的代码对不对"，不是"下一个人有没有拆掉它"）。
 * 所以这里按本仓既有的**源码棘轮**口径钉住（同 `test/workbenchAppBudget.test.mjs`）。
 *
 * ⚠️ 它是**文本级**判据，不假装是行为判据：这些断言只能证明"接线还在源码里"，
 * 证明不了"接得对"。行为那一半在 `test/mutationGuard.test.mjs`（真信号）与
 * `test/workspaceFingerprint.test.mjs`（真比对）里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPRO_DIR = join(ROOT, 'scripts', 'repro')

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

/** 与 `release-preflight.mjs` 的 `gateProbes()` 同一口径的探针发现规则。 */
const PROBE_PATTERN = /^probe-.*-mutations\.mjs$/
const probeFiles = readdirSync(REPRO_DIR).filter((name) => PROBE_PATTERN.test(name)).sort()

const readProbe = (name) => stripComments(readFileSync(join(REPRO_DIR, name), 'utf8'))
const PREFLIGHT = stripComments(readFileSync(join(ROOT, 'scripts', 'release-preflight.mjs'), 'utf8'))

/**
 * 粗略切出一个顶层函数的源码（`function <name>(` → 下一个顶格 `}`）。
 *
 * 为什么要按函数切片：门禁里的 `run()` 与 `runNode()` 长得很像，
 * 一条全文件级的正则会被**另一个函数里的同名代码**满足 —— 那样断言就形同虚设（见下面那条用例）。
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 function ${name}`)
  const end = source.indexOf('\n}', start)
  assert.notEqual(end, -1, `function ${name} 找不到收尾的 }`)
  return source.slice(start, end)
}

test('棘轮：探针还是那 4 个（少了说明文件被改名/删除，发现规则也不再覆盖它）', () => {
  assert.ok(probeFiles.length >= 4, `只发现 ${probeFiles.length} 个探针：${probeFiles.join(', ')}`)
  // 发现规则与门禁里那条必须同形，否则"门禁跑的那一批"和"被护栏管住的那一批"会分叉
  assert.match(PREFLIGHT, /probe-\.\*-mutations/)
})

for (const name of probeFiles) {
  const source = readProbe(name)
  const label = name.replace(/\.mjs$/, '')

  test(`棘轮 ${label}：走护栏（stage/write/restore/close），不再自己碰 fs`, () => {
    assert.match(source, /import \{ createMutationGuard \} from '\.\.\/lib\/mutationGuard\.mjs'/)
    assert.match(source, new RegExp(`const PROBE_LABEL = '${label}'`), `账本名与文件名不一致（崩溃后指认不出是谁留下的）`)
    assert.match(source, /guard\.stage\(/)
    assert.match(source, /guard\.write\(/)
    assert.match(source, /guard\.restore\(/)
    assert.match(source, /guard\.close\(\)/)
    // 恰好一处 stage / 一处 write / 一处 close（都在循环那一段），多出来通常是抄漏了替换
    assert.equal(source.split('guard.stage(').length - 1, 1, 'stage 调用点不止一处')
    assert.equal(source.split('guard.write(').length - 1, 1, 'write 调用点不止一处')
    assert.equal(source.split('guard.close()').length - 1, 1, 'close 调用点不止一处')
  })

  test(`棘轮 ${label}：没有任何直接的 fs 写入（否则绕过备份）`, () => {
    assert.doesNotMatch(source, /writeFileSync\(/, '探针里还有 writeFileSync —— 那会绕过"先备份再改"')
    assert.doesNotMatch(source, /from 'node:fs'/, '探针不该再直接 import node:fs')
  })
}

test('棘轮：探针调用**不经 shell**（否则超时信号杀不到探针，孙进程会带着变异体活下来）', () => {
  assert.match(PREFLIGHT, /function runNode\(/, 'runNode() 没了')
  assert.match(PREFLIGHT, /spawnSync\(process\.execPath, \[script, \.\.\.args\]/, 'runNode 不是"直接 exec node"的形态')
  assert.match(PREFLIGHT, /runNode\(`scripts\/repro\/\$\{file\}`/, '探针没有走 runNode')
  assert.doesNotMatch(PREFLIGHT, /run\(`node scripts\/repro\//, '探针又走回 shell 了（超时会只杀 sh）')
})

test('棘轮：每条命令都有墙钟上限，且超时被识别出来', () => {
  // ⚠️ 这里**必须按函数分别断言**：第一版只写了 `assert.match(PREFLIGHT, /timeout: timeoutMs/)`，
  // 于是一个变异（把 `run()` 的 timeout 摘掉）**照样全绿** —— 因为 `runNode()` 里还有同名参数，
  // 正则被另一个函数满足了。变异验证抓出了这条弱断言（审计 §7 第 24 条）。
  for (const fn of ['run', 'runNode']) {
    assert.match(functionBody(PREFLIGHT, fn), /timeout: timeoutMs\b/, `${fn}() 没接超时参数`)
  }
  assert.match(PREFLIGHT, /error\?\.code === 'ETIMEDOUT'/, '超时没有被识别（会退化成"退出码 1"这种含糊失败）')
  for (const constant of ['BUILD_TIMEOUT_MS', 'TEST_TIMEOUT_MS', 'PROBE_TIMEOUT_MS']) {
    assert.match(PREFLIGHT, new RegExp(`const ${constant} = \\d[\\d\\s*]*\\d`), `${constant} 不是显式数字上限`)
  }
})

test('棘轮：整批探针前后必须拍指纹并逐字节核对', () => {
  assert.match(PREFLIGHT, /fingerprintWorkspace\(\)/, '没有拍工作区指纹')
  assert.match(PREFLIGHT, /diffFingerprints\(before, after\)/, '没有比对跑前跑后指纹')
  assert.match(PREFLIGHT, /judgeWorkspaceResidue\(\{ drift, recovery, before \}\)/, '残留判据没有接进判定')
  assert.match(PREFLIGHT, /add\('探针残留', residueVerdict\)/, '残留判定没有进汇总（跑了但不影响结论）')
})

test('棘轮：开跑前先做崩溃恢复（SIGKILL/断电留下的账本）', () => {
  assert.match(PREFLIGHT, /recoverCrashedSessions\(\)/, '没有崩溃恢复这一腿')
  assert.match(PREFLIGHT, /describeRecovery\(recovery\)/, '恢复了却没说出来（静默恢复等于没有证据）')
})
