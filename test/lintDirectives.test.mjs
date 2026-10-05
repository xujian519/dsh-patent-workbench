/**
 * `eslint-disable` 台账棘轮（审计 §4.5 / v1.17.0）。
 *
 * 本仓没有 lint，但 `src/` 里有 5 处 `eslint-disable-next-line react-hooks/exhaustive-deps`。
 * 这一份测试钉住两件事：
 *
 * 1. **现状**：真实源码树跑一次，指令数与台账一致、每处都有规则名与理由；
 * 2. **棘轮真的会响**：在临时目录里造出"没点名规则 / 没写理由 / 多一处 / 少一处 /
 *    未登记的文件"五种形态，逐个断言会判失败 —— 否则这个工具只是打印好看的报告。
 *
 * ⚠️ 它**不是** lint，也不假装是：它不检查依赖数组对不对（那需要引入 eslint + CI 关卡，
 * 是一个要立项的决定，见审计 §4.5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_DIRECTIVES, runCheck } from '../scripts/check-lint-directives.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一个 `src/` 树，返回根目录；调用方负责删除。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'wb-lint-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

const GOOD = '// eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖用日键代替 Date\nconst a = 1\n'
const EXPECTED_ONE = [{ key: 'src/a.ts::react-hooks/exhaustive-deps', count: 1 }]

test('台账：真实源码树通过（指令数一致 + 每处都有规则与理由）', () => {
  const result = runCheck({ root: ROOT })
  assert.equal(result.exitCode, 0, `台账不一致：\n${result.problems.join('\n')}`)
  assert.equal(result.directives.length, EXPECTED_DIRECTIVES.reduce((sum, entry) => sum + entry.count, 0))
  assert.ok(result.directives.length > 0, '一处都没有的话这个工具已无意义 —— 请连台账一起删掉，而不是留着空跑')
  for (const item of result.directives) {
    assert.notEqual(item.rule, '', '每处都要点名规则')
    assert.ok(item.reason.length >= 6, `理由要说清（${item.file}:${item.line} 是 "${item.reason}"）`)
  }
})

test('台账：基线里点名了 react-hooks/exhaustive-deps，两处文件都在（不是空名单）', () => {
  const keys = EXPECTED_DIRECTIVES.map((entry) => entry.key)
  assert.ok(keys.includes('src/client/index.tsx::react-hooks/exhaustive-deps'))
  assert.ok(keys.includes('src/client/dayPanelModel.ts::react-hooks/exhaustive-deps'))
})

test('台账：合规的一处 → 通过', () => {
  const root = fixture({ 'src/a.ts': GOOD })
  try {
    assert.equal(runCheck({ root, expected: EXPECTED_ONE }).exitCode, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('台账：`eslint-disable` 不点名规则（关掉一切）→ 判失败', () => {
  const root = fixture({ 'src/a.ts': '// eslint-disable-next-line -- 就是想关掉\nconst a = 1\n' })
  try {
    const result = runCheck({ root, expected: [{ key: 'src/a.ts::(未指定规则)', count: 1 }] })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /没点名规则/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('台账：没写 `-- 理由` 或理由敷衍（`同上`）→ 判失败', () => {
  const root = fixture({ 'src/a.ts': '// eslint-disable-next-line react-hooks/exhaustive-deps -- 同上\nconst a = 1\n' })
  try {
    const result = runCheck({ root, expected: EXPECTED_ONE })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /缺 `-- 理由`/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('台账：多出一处 → 判失败并指路（新增必须登记）', () => {
  const root = fixture({
    'src/a.ts': `${GOOD}// eslint-disable-next-line react-hooks/exhaustive-deps -- 第二处，理由与上面同源\nconst b = 2\n`
      + '// eslint-disable-next-line no-console -- 临时排查用，定位完就删\nconst c = 3\n',
  })
  try {
    const result = runCheck({ root, expected: EXPECTED_ONE })
    assert.equal(result.exitCode, 1)
    const text = result.problems.join('\n')
    assert.match(text, /src\/a\.ts::react-hooks\/exhaustive-deps 现在 2 处（台账 1）/, text)
    assert.match(text, /src\/a\.ts::no-console 不在台账里/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('台账：修掉一处但台账没跟着改 → 也判失败（这个数必须代表现状，不许变成历史值）', () => {
  const root = fixture({ 'src/a.ts': 'const a = 1\n' })
  try {
    const result = runCheck({ root, expected: EXPECTED_ONE })
    assert.equal(result.exitCode, 1)
    assert.match(result.problems.join('\n'), /少了就是把一处 lint 债修掉了/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
