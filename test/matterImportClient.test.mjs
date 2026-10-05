/**
 * 「扫描导入」客户端纯逻辑的判据（`src/client/matterImportApi.ts`）。
 *
 * 这一层只有一个判定值得反复钉：**哪些行会被送去落库**。它错了不会报错 ——
 * 只会「点了导入 10 条，实际进来 7 条」，而用户数不出少了哪三条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SCAN_ROOT, MATTER_IMPORT_ROUTE, importableItems, initialRows, matchesQuery,
  matterCommitUrl, matterScanUrl, rowIsImportable, selectionSummary,
} from '../lib/client/matterImportApi.js'

const CLIENT_DIR = fileURLToPath(new URL('../src/client/', import.meta.url))

function candidate(overrides = {}) {
  return {
    relPath: '01_专利申请/某案',
    path: '/tmp/某案',
    name: '某案',
    tier: 'high',
    evidence: [],
    caseNumber: '202010388021',
    title: '一种测试装置',
    applicationNo: '202010388021',
    matterType: 'drafting',
    ...overrides,
  }
}

test('初始行：高置信默认勾选，中/其余默认不勾（分档是启发式，默认全勾等于把机器猜的当用户的意图）', () => {
  const rows = initialRows([
    candidate({ relPath: 'a', tier: 'high' }),
    candidate({ relPath: 'b', tier: 'mid', caseNumber: '', title: '' }),
    candidate({ relPath: 'c', tier: 'rest', caseNumber: '', title: '' }),
  ])
  assert.equal(rows.a.checked, true)
  assert.equal(rows.b.checked, false)
  assert.equal(rows.c.checked, false)
  assert.equal(rows.a.caseNumber, '202010388021', '预填值要带进来')
  assert.equal(rows.a.title, '一种测试装置')
  assert.equal(rows.c.title, '', '候选自带的空标题就照搬（界面上等人补），不要偷偷换成目录名')
})

test('能不能导入：必须同时满足「勾选 + 案号非空 + 名称非空」', () => {
  assert.equal(rowIsImportable({ checked: true, caseNumber: 'X', title: 'Y', matterType: 'other' }), true)
  assert.equal(rowIsImportable({ checked: false, caseNumber: 'X', title: 'Y', matterType: 'other' }), false, '没勾选')
  assert.equal(rowIsImportable({ checked: true, caseNumber: '  ', title: 'Y', matterType: 'other' }), false, '案号只有空白')
  assert.equal(rowIsImportable({ checked: true, caseNumber: 'X', title: '', matterType: 'other' }), false, '名称为空')
  assert.equal(rowIsImportable(undefined), false)
})

test('提交载荷：只收勾选且字段齐的，且值都 trim 过', () => {
  const candidates = [
    candidate({ relPath: 'a' }),
    candidate({ relPath: 'b', caseNumber: '  202111246629  ', title: '  另一种装置  ' }),
    candidate({ relPath: 'c', caseNumber: '', title: '缺案号' }),
  ]
  const rows = initialRows(candidates)
  rows.b.checked = true
  rows.c.checked = true /* 勾了但缺案号 → 不该进载荷 */

  const items = importableItems(candidates, rows)
  assert.deepEqual(items.map((item) => item.relPath), ['a', 'b'])
  assert.equal(items[1].caseNumber, '202111246629', 'trim 后再发')
  assert.equal(items[1].title, '另一种装置')
  assert.equal(items[0].path, '/tmp/某案', 'workspacePath 用绝对路径')
})

test('摘要：勾选数 / 可导入数 / 缺字段数分开报（「勾了 10 条只进 7 条」必须看得见）', () => {
  const candidates = [candidate({ relPath: 'a' }), candidate({ relPath: 'b' }), candidate({ relPath: 'c', caseNumber: '' })]
  const rows = initialRows(candidates)
  rows.b.checked = true
  rows.c.checked = true
  assert.deepEqual(selectionSummary(candidates, rows), { checked: 3, importable: 2, incomplete: 1 })
})

test('搜索：路径 / 目录名 / 案号 / 名称都能搜到（用户找的可能是其中任何一个）', () => {
  const item = candidate({ relPath: '04_审查意见/02_已答复/山东中匠', name: '山东中匠', caseNumber: '202522146475', title: '兽用中药智能熬制设备' })
  assert.equal(matchesQuery(item, ''), true, '空查询不过滤')
  assert.equal(matchesQuery(item, '审查意见'), true)
  assert.equal(matchesQuery(item, '山东中匠'), true)
  assert.equal(matchesQuery(item, '202522146475'), true)
  assert.equal(matchesQuery(item, '熬制'), true)
  assert.equal(matchesQuery(item, '不存在的词'), false)
})

test('请求形状：两端点 URL 与默认扫描根只有这一处定义', () => {
  assert.equal(matterScanUrl(), `${MATTER_IMPORT_ROUTE}/scan`)
  assert.equal(matterCommitUrl(), `${MATTER_IMPORT_ROUTE}/commit`)
  assert.equal(DEFAULT_SCAN_ROOT, '~/工作')
})

// --------------------------------------------------------------------------- 源码扫描

function clientSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
  }
  walk(CLIENT_DIR)
  return out
}

test('源码扫描：路由字面量只许出现在 matterImportApi.ts 一处', () => {
  const offenders = clientSources()
    .filter((file) => !file.endsWith('matterImportApi.ts'))
    .filter((file) => readFileSync(file, 'utf8').includes(MATTER_IMPORT_ROUTE))
  assert.deepEqual(
    offenders.map((file) => file.slice(CLIENT_DIR.length)),
    [],
    '别的客户端文件里再拼一遍路径，将来改路由必漏一处（列目录那条路已因此设过围栏）',
  )
})

test('源码扫描：新客户端文件不得出现 list-local-dir 字面量（列目录只能走 localDirBrowser）', () => {
  const offenders = clientSources()
    .filter((file) => /matterImport|MatterImport/.test(file))
    .filter((file) => readFileSync(file, 'utf8').includes('list-local-dir'))
  assert.deepEqual(offenders, [])
})
