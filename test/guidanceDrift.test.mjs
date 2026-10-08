/**
 * 注入文本防漂移（T4）。
 *
 * 「AI 不能直接把任务标记为已完成/已取消」这条纪律写在 4 个挂点上，且已经漂移过
 * （`index.ts` 的「完成/取消」vs `tools.ts` 的「已完成/已取消」）。T4 把规范表述收进
 * `src/shared/guidance.ts`，`scripts/check-guidance-drift.mjs` 断言它没被别处手打回去。
 *
 * 这一份测试钉住两件事：
 *
 * 1. **现状**：真实源码树跑一次，无漂移；
 * 2. **棘轮真的会响**：在临时目录里造出「手打规范短语 / 写老变体却不 import / 真源丢了
 *    规范短语」三种形态，逐个断言会判失败 —— 否则这个工具只是打印好看的报告。
 *
 * 另钉住**口径**：`src/client/**` 是给人看的 UI 文案，不算注入文本，必须被排除
 * （不然 `TaskProgress.tsx` 的「标记为已完成」就是天天报的假警报）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDANCE_REL, readMark, runCheck } from '../scripts/check-guidance-drift.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 规范短语：拼接构造，免得这份测试自己成了第 5 处副本。 */
const MARK = ['AI 不能直接把任务标记为', '已完成/已取消'].join('')
/** 真源文件的最小形态。 */
const SOURCE = `export const COMPLETION_AUTHORITY_MARK = '${MARK}'\n`
const REL = 'src/shared/guidance.ts'

/** 造一个 `src/` 树，返回根目录；调用方负责删除。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'wb-guidance-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

test('防漂移：真实源码树无漂移', () => {
  const result = runCheck({ root: ROOT })
  assert.equal(result.exitCode, 0, `有漂移：\n${result.problems.join('\n')}`)
  assert.equal(result.mark, MARK, '规范短语要从真源里读出来（不是校验脚本自己写死）')
})

test('防漂移：真源确实导出了规范短语（readMark 能读出来）', () => {
  assert.equal(GUIDANCE_REL, REL)
  assert.equal(readMark(SOURCE), MARK)
  assert.equal(readMark('export const OTHER = 1\n'), null, '读不到就该返回 null，不能瞎猜一个')
})

test('防漂移：合规的一处 → 通过', () => {
  const root = fixture({
    [REL]: SOURCE,
    'src/a.ts': `import { COMPLETION_AUTHORITY_RULE } from './shared/guidance.js'\nexport const x = COMPLETION_AUTHORITY_RULE\n`,
  })
  try {
    assert.equal(runCheck({ root }).exitCode, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('防漂移：别处手打规范短语 → 判失败并指路', () => {
  const root = fixture({
    [REL]: SOURCE,
    'src/a.ts': `export const x = '${MARK}'\n`,
  })
  try {
    const result = runCheck({ root })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /src\/a\.ts 手打了规范短语/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('防漂移：写老变体（「标记为完成」）却不 import → 判失败（这正是历史漂移的形态）', () => {
  const root = fixture({
    [REL]: SOURCE,
    'src/a.ts': `export const x = '错误：AI 不得直接把任务标记为完成/取消。'\n`,
  })
  try {
    const result = runCheck({ root })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /却没有从 src\/shared\/guidance\.ts 取值/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('防漂移：真源丢了规范短语 → 判失败（真源没了各挂点就无从取值）', () => {
  const root = fixture({ [REL]: 'export const SOMETHING_ELSE = 1\n', 'src/a.ts': 'export const x = 1\n' })
  try {
    const result = runCheck({ root })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /读不到 `COMPLETION_AUTHORITY_MARK`/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('防漂移：`src/client/**` 不在口径内（UI 文案不是注入文本，不许误报）', () => {
  const root = fixture({
    [REL]: SOURCE,
    'src/client/components/Thing.tsx': `export const L = '通过后才会标记为已完成。'\n`,
  })
  try {
    assert.equal(runCheck({ root }).exitCode, 0, '客户端文案被当成漂移就是假警报')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
