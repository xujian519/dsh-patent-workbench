/**
 * 工作区指纹（`scripts/lib/workspaceFingerprint.mjs`）单测 —— 变异探针残留的判据本身。
 *
 * ## 为什么这份测试比它测的函数还重要
 *
 * 它是**门禁的判据**：出错方式是"该红不红"（探针残留没被发现 → 变异体随包发布）。
 * 所以这里不只测"能发现变化"，还刻意钉住三件更容易腐坏的事：
 *
 * 1. **豁免只有那一个字段**：只改 `lib/build-info.json` 的 `generatedAt` 不算漂移，
 *    改 `buildId` / `inputs` **必须算** —— 否则"归一化"会慢慢长成"整个文件都不看"。
 * 2. **豁免名单本身是台账**：`NORMALIZED_FILES` / `VOLATILE_JSON_KEYS` 一旦被加宽，
 *    这些用例先红（不许有人为了让自己那次变绿而扩豁免）。
 * 3. **真数据上真的在量东西**：对**当前仓库**跑一次，`src/` 与 `lib/` 都得在里面 ——
 *    "量到 0 个文件"和"量到很干净"是完全不同的两件事（与 `judgeProbes` 的
 *    "一个探针都没跑"同规）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FINGERPRINT_DIRS, NORMALIZED_FILES, VOLATILE_JSON_KEYS, diffFingerprints, fingerprintWorkspace,
  formatDrift, hashFileContent,
} from '../scripts/lib/workspaceFingerprint.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一棵 { src, lib } 小树；调用方负责清理。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'wb-fp-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

function withFixture(files, fn) {
  const root = fixture(files)
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

const snap = (root) => fingerprintWorkspace({ root })

// ── 基本判据 ────────────────────────────────────────────────────────────────

test('指纹：同一棵树两次拍摄完全相同（含 digest）', () => {
  withFixture({ 'src/a.ts': 'a', 'lib/a.js': 'A', 'src/nested/b.ts': 'b' }, (root) => {
    const first = snap(root)
    const second = snap(root)
    assert.equal(first.count, 3)
    assert.equal(first.digest, second.digest)
    assert.deepEqual(diffFingerprints(first, second), [])
  })
})

test('指纹：src 里的内容变化 → changed（这就是"变异体没还原"）', () => {
  withFixture({ 'src/a.ts': 'a', 'lib/a.js': 'A' }, (root) => {
    const before = snap(root)
    writeFileSync(join(root, 'src/a.ts'), 'MUTATED', 'utf8')
    const drift = diffFingerprints(before, snap(root))
    assert.equal(drift.length, 1)
    assert.deepEqual(drift[0], { kind: 'changed', path: 'src/a.ts', before: drift[0].before, after: drift[0].after })
    assert.notEqual(drift[0].before, drift[0].after)
  })
})

test('指纹：lib 里的内容变化同样算漂移（lib 才是随包产物，探针也确实只改它）', () => {
  withFixture({ 'src/a.ts': 'a', 'lib/client/x.js': 'X' }, (root) => {
    const before = snap(root)
    writeFileSync(join(root, 'lib/client/x.js'), 'X-mutated', 'utf8')
    const drift = diffFingerprints(before, snap(root))
    assert.equal(drift.length, 1)
    assert.equal(drift[0].path, 'lib/client/x.js')
    assert.equal(drift[0].kind, 'changed')
  })
})

test('指纹：多出文件（added）与文件没了（removed）都算漂移', () => {
  withFixture({ 'src/a.ts': 'a', 'lib/gone.js': 'g' }, (root) => {
    const before = snap(root)
    writeFileSync(join(root, 'src/leaked.ts'), 'leak', 'utf8')
    rmSync(join(root, 'lib/gone.js'))
    const kinds = diffFingerprints(before, snap(root)).map((d) => `${d.kind}:${d.path}`).sort()
    assert.deepEqual(kinds, ['added:src/leaked.ts', 'removed:lib/gone.js'])
  })
})

test('指纹：目录不存在不算错误，只是量到 0 个文件（调用方必须能把这种情况判为失败）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-fp-empty-'))
  try {
    const fp = snap(root)
    assert.equal(fp.count, 0)
    assert.equal(fp.digest.length, 64)
    assert.deepEqual(fp.normalized, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 唯一的豁免：只豁免"墙钟字段"，不豁免内容 ────────────────────────────────

test('豁免：只改 lib/build-info.json 的 generatedAt → 不算漂移（并在 normalized 里显式列出）', () => {
  const original = JSON.stringify({ name: 'pkg', buildId: 'wb-aaaa', inputs: 178, generatedAt: '2026-10-05T00:00:00.000Z' }, null, 2)
  withFixture({ 'src/a.ts': 'a', 'lib/build-info.json': original }, (root) => {
    const before = snap(root)
    assert.deepEqual(before.normalized, ['lib/build-info.json'])
    writeFileSync(join(root, 'lib/build-info.json'), original.replace('2026-10-05T00:00:00.000Z', '2026-10-05T01:02:03.456Z'), 'utf8')
    assert.deepEqual(diffFingerprints(before, snap(root)), [])
  })
})

test('豁免的边界：改 buildId / inputs / 任何别的字段 → **必须**算漂移', () => {
  const base = { name: 'pkg', buildId: 'wb-aaaa', inputs: 178, generatedAt: '2026-10-05T00:00:00.000Z' }
  for (const patch of [{ buildId: 'wb-deadbeef' }, { inputs: 999 }, { name: 'other' }, { extra: 'sneaky' }]) {
    withFixture({ 'lib/build-info.json': JSON.stringify(base, null, 2) }, (root) => {
      const before = snap(root)
      writeFileSync(join(root, 'lib/build-info.json'), JSON.stringify({ ...base, ...patch }, null, 2), 'utf8')
      const drift = diffFingerprints(before, snap(root))
      assert.equal(drift.length, 1, `改了 ${Object.keys(patch)[0]} 却没被发现`)
      assert.equal(drift[0].path, 'lib/build-info.json')
    })
  }
})

test('豁免名单是台账：只豁免 build-info.json，且只豁免 generatedAt 这一个字段', () => {
  assert.deepEqual(NORMALIZED_FILES, ['lib/build-info.json'])
  assert.deepEqual(VOLATILE_JSON_KEYS, ['generatedAt'])
})

test('豁免的兜底：build-info.json 不是合法 JSON / 不是对象 → 退回原文哈希（保守：算漂移）', () => {
  assert.equal(hashFileContent('lib/build-info.json', 'not json at all').normalized, false)
  const before = hashFileContent('lib/build-info.json', '[1,2,3]')
  assert.equal(before.normalized, false)
  assert.notEqual(before.hash, hashFileContent('lib/build-info.json', '[1,2,4]').hash)
})

test('豁免只对该路径生效：同名文件在别的目录不算豁免', () => {
  const content = '{"generatedAt":"x","buildId":"y"}'
  assert.equal(hashFileContent('lib/build-info.json', content).normalized, true)
  assert.equal(hashFileContent('src/build-info.json', content).normalized, false)
})

// ── 报告与真实数据 ──────────────────────────────────────────────────────────

test('formatDrift：超长漂移列表被折叠，不刷屏（但给出剩余条数）', () => {
  const drift = Array.from({ length: 20 }, (_, i) => ({ kind: 'changed', path: `src/f${i}.ts`, before: 'a', after: 'b' }))
  const text = formatDrift(drift, 5)
  assert.match(text, /src\/f0\.ts/)
  assert.doesNotMatch(text, /src\/f5\.ts/)
  assert.match(text, /另有 15 处/)
})

test('真数据：当前仓库的指纹确实覆盖 src 与 lib（不然判据等于没在量东西）', () => {
  const fp = fingerprintWorkspace()
  assert.ok(fp.count > 300, `只量到 ${fp.count} 个文件，判据不在工作`)
  assert.ok(Object.keys(fp.files).some((p) => p.startsWith('src/')), 'src/ 没进指纹')
  assert.ok(fp.dirs.includes('lib'))
  if (existsSync(join(REPO_ROOT, 'lib', 'build-info.json'))) {
    assert.ok(fp.normalized.includes('lib/build-info.json'), 'lib/build-info.json 没走归一化（两次构建会误报）')
    const info = JSON.parse(readFileSync(join(REPO_ROOT, 'lib', 'build-info.json'), 'utf8'))
    assert.match(String(info.buildId), /^wb-[0-9a-f]{16}$/)
  }
})

test('真数据：FINGERPRINT_DIRS 同时包含 src 与 lib（少一个都会漏掉半条路径）', () => {
  assert.deepEqual([...FINGERPRINT_DIRS].sort(), ['lib', 'src'])
})
