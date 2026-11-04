/**
 * 工作根只有一处实现（`src/shared/workRoot.ts`）。
 * 扫描预填、省略 root 时的回退、bootstrap 下发给界面的值，都得指向它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { configuredWorkRoot, DEFAULT_WORK_ROOT, WORK_ROOT_EXAMPLE } from '../lib/shared/workRoot.js'

test('默认工作根是 ~/工作；绝对路径例子不是运行时默认值', () => {
  assert.equal(DEFAULT_WORK_ROOT, '~/工作')
  assert.equal(configuredWorkRoot({}), '~/工作')
  assert.equal(configuredWorkRoot({ DSH_WORK_ROOT: '   ' }), '~/工作', '空白环境变量等于没设')
  assert.equal(configuredWorkRoot({ DSH_WORK_ROOT: '  /tmp/cases  ' }), '/tmp/cases')
  assert.equal(WORK_ROOT_EXAMPLE, '/Users/xujian/工作')
  assert.notEqual(WORK_ROOT_EXAMPLE, DEFAULT_WORK_ROOT)
})

test('扫描预填、bootstrap、界面读的是同一处工作根', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.match(read('../src/client/matterImportApi.ts'), /DEFAULT_SCAN_ROOT = DEFAULT_WORK_ROOT/)
  assert.match(read('../src/api/routes.ts'), /workRoot: configuredWorkRoot\(process\.env\)/)
  assert.match(read('../src/client/index.tsx'), /defaultRoot: bootstrap\?\.workRoot/)
  assert.equal(
    read('../src/api/routes/matters.ts').includes('patent-workspace/<案号>'),
    false,
    '对用户的报错不许再把 patent-workspace/<案号> 说成必须补的目录',
  )
})
