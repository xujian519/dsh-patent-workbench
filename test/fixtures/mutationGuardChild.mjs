/**
 * 护栏测试用的**子进程**：在一个临时工作区里 stage + 写入变异体，然后按 `--mode` 走向不同退出路径。
 *
 * 为什么必须是真子进程：`SIGTERM` / `SIGKILL` / `uncaughtException` 这几条路径
 * **只能在真实进程里观测**（在同一个进程里"模拟信号"就是在测自己写的假信号）。
 * 本仓的判据口径一贯是"测真东西"（见审计 §7 自省条目），所以这里用 `spawn` 起真进程。
 *
 * 用法（`test/mutationGuard.test.mjs` 调用）：
 *
 * ```sh
 * node test/fixtures/mutationGuardChild.mjs --root <dir> --file <relpath> --mode block|exit|uncaught|reject|close
 * ```
 *
 * `--mode block` 写完就挂着不动，等父进程发信号 —— 用来测 SIGTERM/SIGINT/SIGKILL。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createMutationGuard } from '../../scripts/lib/mutationGuard.mjs'

const args = process.argv.slice(2)
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const root = resolve(valueOf('--root', '.'))
const file = valueOf('--file', 'src/a.ts')
const label = valueOf('--label', 'child')
const mode = valueOf('--mode', 'block')
const text = valueOf('--text', 'MUTATED\n')
const abs = join(root, file)

const guard = createMutationGuard({ root, label })
guard.stage(abs)
guard.write(abs, text)
// 让父进程知道"变异体已经落盘"（否则它可能在写入前就发信号，测不到东西）。
console.log(`READY ${readFileSync(abs, 'utf8') === text ? 'mutated' : 'NOT-mutated'}`)

if (mode === 'close') {
  guard.close()
  process.exit(0)
}
if (mode === 'restored') {
  // 还原了，但**账本仍 open**（模拟"还原之后立刻被 KILL"）：
  // 下一个进程必须能认出来"其实已经干净了"，只关账本、不当作待恢复。
  guard.restore(abs)
  process.exit(0)
}
if (mode === 'exit') {
  process.exit(0) // 不 close：验证 `exit` 兜底会还原
}
if (mode === 'uncaught') {
  setTimeout(() => { throw new Error('fixture: uncaught') }, 10)
} else if (mode === 'reject') {
  Promise.reject(new Error('fixture: unhandled rejection'))
} else if (mode === 'block') {
  setInterval(() => {}, 1000) // 保持存活，等信号
} else {
  console.error(`未知 mode：${mode}`)
  process.exit(2)
}
