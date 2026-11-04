/**
 * 案卷「扫描导入」端点的判据。
 *
 * 这一层的两条纪律：
 * 1. **scan 不落库**（它只读盘；用户没点确认之前，库里一条都不该多）；
 * 2. **拒绝要说清为什么** —— 路径打错、给了个文件、给了相对路径，一律带中文原因。
 *    静默返回一份空清单会被读成「我的案卷怎么都没了」，那比报错难查得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { getMatterByCaseNumber, listMatters } from '../lib/db/repo.js'
import { makeMatterImportRoute } from '../lib/api/matterImportRoute.js'
import { commitMatterImport } from '../lib/matter-import/commit.js'
import { scanWorkspaceTree } from '../lib/matter-import/scan.js'

const BASE = '/api/workbench/matter-import'

/** 造一棵临时目录树：`{ '相对路径': ['文件名', ...] }`；返回根路径。 */
function makeTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-import-'))
  for (const [rel, files] of Object.entries(spec)) {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(dir, file), '')
  }
  return root
}

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeMatterImportRoute(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}${BASE}`, db)
  } finally {
    server.close()
    db.close()
  }
}

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function withTree(spec, fn) {
  const root = makeTree(spec)
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------------------- scan

test('scan：扫目录树返回三档候选，字段已预填（案号 / 名称 / 案型 / 绝对路径）', async () => {
  await withTree({
    '01_专利申请/202010388021-山东植丰复审': ['交底书.md'],
    '01_专利申请/张国艳2件/手动式农药精准喷洒器': ['说明书附图.dwg'],
    '09_临时文件/杂项': ['note.txt'],
  }, async (root) => {
    await withServer(async (base) => {
      const res = await post(base, '/scan', { root })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(body.root, root)
      assert.equal(body.scanned.truncated, false)
      /* 6 个候选 = 3 个叶子 + 3 个中间目录（`01_专利申请` / `张国艳2件` / `09_临时文件`
         自己也是候选，否则用户看不到「客户层目录」那一档）。 */
      assert.deepEqual(body.tiers, { high: 1, mid: 1, rest: 4 })

      const shandong = body.candidates.find((candidate) => candidate.relPath === '01_专利申请/202010388021-山东植丰复审')
      assert.equal(shandong.tier, 'high')
      assert.equal(shandong.caseNumber, '202010388021')
      assert.equal(shandong.title, '山东植丰复审')
      assert.equal(shandong.matterType, 'drafting')
      assert.equal(shandong.path, join(root, '01_专利申请/202010388021-山东植丰复审'), 'workspacePath 预填用绝对路径')
      assert.deepEqual(shandong.evidence, ['目录名含申请号 202010388021'])
    })
  })
})

test('scan：只读盘 —— 扫完库里一条案卷都不多', async () => {
  await withTree({ '某案卷/交底书.md': [] }, async (root) => {
    await withServer(async (base, db) => {
      await post(base, '/scan', { root })
      assert.equal(listMatters(db).length, 0, 'scan 是纯读：用户没点确认之前库里不该多出任何东西')
    })
  })
})

test('scan：不写用户的盘（扫描前后目录树逐条一致）', async () => {
  await withTree({ '01_专利申请/202010388021-山东植丰复审': ['交底书.md', '_matter-log.md'] }, async (root) => {
    const before = readdirSync(root, { recursive: true }).sort()
    await withServer(async (base) => { await post(base, '/scan', { root }) })
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
  })
})

test('scan：`~` 展开成主目录（错误里能看到展开后的路径，证明不是原样拿 `~` 去 stat）', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/scan', { root: '~/绝不可能存在的目录 dsh-workbench-test' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /目录不存在/)
    assert.doesNotMatch(body.error, /~/, '错误里应是展开后的绝对路径，不是原样的 ~')
  })
})

test('scan：路径问题一律 400 + 能读懂的中文原因（绝不静默返回空清单）', async () => {
  await withServer(async (base) => {
    const cases = [
      [{ root: '' }, /不能为空/],
      [{ root: '   ' }, /不能为空/],
      [{ root: 123 }, /不能为空/],
      [{ root: '/no/such/dir/dsh-workbench-test' }, /目录不存在/],
      [{ root: 'relative/path' }, /绝对路径/],
      [{ root: './工作' }, /绝对路径/],
    ]
    for (const [payload, pattern] of cases) {
      const res = await post(base, '/scan', payload)
      assert.equal(res.status, 400, `payload=${JSON.stringify(payload)}`)
      const body = await res.json()
      assert.match(body.error, pattern, `payload=${JSON.stringify(payload)}`)
    }
  })
})

test('scan：给了个文件（不是目录）→ 400 说不清是哪种', async () => {
  await withTree({ '某目录': [] }, async (root) => {
    const file = join(root, '某目录')
    await withServer(async (base) => {
      const res = await post(base, '/scan', { root: join(file, '不存在.txt') })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /目录不存在/)
    })
  })
})

// --------------------------------------------------------------------------- 围栏

test('scan：GET 不接（405）；未知子资源 404', async () => {
  await withServer(async (base) => {
    const get = await fetch(`${base}/scan`)
    assert.equal(get.status, 405)

    const unknown = await post(base, '/whatever', {})
    assert.equal(unknown.status, 404)
    assert.match((await unknown.json()).error, /unknown sub-resource/)
  })
})

test('scan：跨站请求被回环围栏挡在门外（403）', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/scan', { root: '/' }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(res.status, 403)
  })
})

// --------------------------------------------------------------------------- commit

/** 一条界面回传的候选（形态与 `scan` 响应对齐）。 */
function item(overrides = {}) {
  return {
    caseNumber: '202010388021',
    title: '一种测试装置',
    matterType: 'drafting',
    path: '/tmp/某目录',
    relPath: '01_专利申请/某目录',
    ...overrides,
  }
}

test('commit：建 N 条 = N，字段落库正确，并留下「这条从哪来」的痕迹', async () => {
  await withServer(async (base, db) => {
    const res = await post(base, '/commit', {
      items: [
        item(),
        item({ caseNumber: '202111246629', title: '另一种装置', path: '/tmp/另一目录', relPath: '02_复审无效/另一目录', matterType: 'reexamination' }),
      ],
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.created, 2)
    assert.deepEqual(body.failed, [])
    assert.equal(body.matters.length, 2)

    const first = getMatterByCaseNumber(db, '202010388021')
    assert.equal(first.title, '一种测试装置')
    assert.equal(first.workspacePath, '/tmp/某目录', 'workspacePath 是扫描导入的独有价值')
    assert.equal(first.applicationNo, '202010388021', '案号是申请号形态时，申请号自动跟上')
    assert.equal(first.stageCode, 'open')
    assert.equal(first.extra.source.kind, 'scan-import', '留痕：这条是扫进来的')
    assert.equal(first.extra.source.relPath, '01_专利申请/某目录')

    assert.equal(getMatterByCaseNumber(db, '202111246629').matterType, 'reexamination')

    /* 校验位要保留：申请号的规范写法是 `202520556678.1`，剥成 12 位后拿去对官方文件对不上 */
    await post(base, '/commit', { items: [item({ caseNumber: '202520556678.1', title: '一种电动谱台' })] })
    assert.equal(getMatterByCaseNumber(db, '202520556678.1').applicationNo, '202520556678.1')
  })
})

test('commit：空案号 / 空名称逐条带中文原因进 failed，其余照常建', async () => {
  await withServer(async (base, db) => {
    const body = await (await post(base, '/commit', {
      items: [
        item({ caseNumber: '' }),
        item({ caseNumber: '202211111111', title: '   ' }),
        item({ caseNumber: '2026-UM-002', title: '内部编号的案子' }),
      ],
    })).json()

    assert.equal(body.created, 1, '只有第三条能建')
    assert.equal(body.failed.length, 2)
    assert.deepEqual(body.failed.map((failure) => failure.index), [0, 1], 'failed 要带下标，用户才对得回界面上那一行')
    assert.match(body.failed[0].reason, /案号/)
    assert.match(body.failed[1].reason, /名称/)

    assert.equal(getMatterByCaseNumber(db, '2026-UM-002').applicationNo, null, '内部案号不是申请号形态 → 申请号留空，不硬塞')
  })
})

test('commit：同一批里自带重复案号 → 第二条进 failed，不是整批崩', async () => {
  await withServer(async (base) => {
    const body = await (await post(base, '/commit', { items: [item(), item({ title: '同名不同目录' })] })).json()
    assert.equal(body.created, 1)
    assert.equal(body.failed.length, 1)
    assert.match(body.failed[0].reason, /已存在/)
  })
})

test('commit：库内已有同案号且目录变了 → 只更新 workspace_path，不改名称、不另建', async () => {
  await withServer(async (base, db) => {
    await post(base, '/commit', { items: [item({ title: '手改过的名称', path: '/tmp/旧目录' })] })
    const body = await (await post(base, '/commit', {
      items: [
        item({ title: '目录名里的新标题', path: '/tmp/新目录', relPath: '01_专利申请/新目录' }),
        item({ caseNumber: '202111246629' }),
      ],
    })).json()
    assert.equal(body.created, 1, '新案号仍然新建')
    assert.equal(body.updated, 1)
    assert.equal(body.unchanged, 0)
    assert.deepEqual(body.failed, [])
    const existing = getMatterByCaseNumber(db, '202010388021')
    assert.equal(existing.workspacePath, '/tmp/新目录')
    assert.equal(existing.title, '手改过的名称', '再扫一次不覆盖台账里改过的名称')
    assert.equal(existing.extra.source.relPath, '01_专利申请/新目录')
  })
})

test('commit：整批导两次且路径相同 → 第二次不新建、不报失败（目录未变）', async () => {
  await withServer(async (base) => {
    const items = [item(), item({ caseNumber: '202111246629' }), item({ caseNumber: '202210132346' })]
    assert.equal((await (await post(base, '/commit', { items })).json()).created, 3)
    const second = await (await post(base, '/commit', { items })).json()
    assert.equal(second.created, 0)
    assert.equal(second.updated, 0)
    assert.equal(second.unchanged, 3, '同一路径再登记是索引确认，不是失败')
    assert.deepEqual(second.failed, [])
  })
})

test('commit：省略 root 的扫描使用 DSH_WORK_ROOT（与可配置工作根是同一处）', async () => {
  await withTree({ '202010388021-一种装置': ['交底书.md'] }, async (root) => {
    const previous = process.env.DSH_WORK_ROOT
    process.env.DSH_WORK_ROOT = root
    try {
      await withServer(async (base) => {
        const res = await post(base, '/scan', {})
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.root, root)
        assert.equal(body.candidates.some((candidate) => candidate.path === join(root, '202010388021-一种装置')), true)
      })
    } finally {
      if (previous === undefined) delete process.env.DSH_WORK_ROOT
      else process.env.DSH_WORK_ROOT = previous
    }
  })
})

test('commit：items 不是数组 / 空 / 超上限 → 400 中文原因', async () => {
  await withServer(async (base) => {
    const cases = [
      [undefined, /必须是数组/],
      [[], /没有要导入/],
      [Array.from({ length: 1001 }, () => item()), /最多导入 1000 条/],
    ]
    for (const [items, pattern] of cases) {
      const res = await post(base, '/commit', { items })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, pattern)
    }
  })
})

test('commit：拒绝正文类字段，且 matters 表没有正文列', async () => {
  await withServer(async (base, db) => {
    const sentinel = 'MATTER_BODY_SENTINEL_不应进库'
    const body = await (await post(base, '/commit', {
      items: [item({ content: sentinel, contentMd: sentinel, body: sentinel })],
    })).json()
    assert.equal(body.created, 0)
    assert.equal(body.updated, 0)
    assert.match(body.failed[0].reason, /不接收案卷正文/)
    assert.equal(getMatterByCaseNumber(db, '202010388021'), undefined)
    const columns = db.prepare('PRAGMA table_info(matters)').all().map((column) => column.name)
    for (const name of ['content', 'content_md', 'body', 'full_text', 'document_text']) {
      assert.equal(columns.includes(name), false, `matters 不应有正文列 ${name}`)
    }
    assert.equal(columns.includes('workspace_path'), true)
  })
})

test('commit：不写用户的盘（只写库）', async () => {
  await withTree({ '01_专利申请/某目录': ['交底书.md'] }, async (root) => {
    const before = readdirSync(root, { recursive: true }).sort()
    await withServer(async (base) => {
      await post(base, '/commit', { items: [item({ path: join(root, '01_专利申请/某目录') })] })
    })
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
  })
})

test('扫描导入只写路径索引：正文哨兵不进库，删库后案卷文件夹仍在', async () => {
  const sentinel = `MATTER_BODY_SENTINEL_不应进库_${'正文'.repeat(2000)}`
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-matter-truth-'))
  const caseDir = join(root, '01_专利申请', '202010388021-一种装置')
  mkdirSync(caseDir, { recursive: true })
  const bodyPath = join(caseDir, '交底书.md')
  const logPath = join(caseDir, '_matter-log.md')
  writeFileSync(bodyPath, `# 交底\n${sentinel}\n`)
  writeFileSync(logPath, `2026-11-04T00:00:00Z | 建案 | 交底书.md | 用户 | ${sentinel}\n`)
  const ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-workbench-ledger-'))
  const dbPath = join(ledgerDir, 'workbench.db')
  const db = openWorkbenchDb({ dbPath })
  seedDictionaries(db)
  try {
    const scan = await scanWorkspaceTree(root)
    assert.equal(JSON.stringify(scan).includes('MATTER_BODY_SENTINEL'), false, '扫描结果不得含文件正文')
    const candidate = scan.candidates.find((entry) => entry.relPath === '01_专利申请/202010388021-一种装置')
    assert.equal(candidate.path, caseDir)

    const rejected = commitMatterImport(db, [{
      caseNumber: '202010388021',
      title: '一种装置',
      matterType: 'drafting',
      path: caseDir,
      relPath: candidate.relPath,
      content: sentinel,
    }])
    assert.equal(rejected.created, 0)
    assert.match(rejected.failed[0].reason, /不接收案卷正文/)

    const committed = commitMatterImport(db, [{
      caseNumber: '202010388021',
      title: '一种装置',
      matterType: 'drafting',
      path: caseDir,
      relPath: candidate.relPath,
    }])
    assert.equal(committed.created, 1)
    assert.equal(committed.matters[0].workspacePath, caseDir)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM knowledge_entries').get().c, 0, '扫描导入不写知识库')

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table.name}"`).all()
      assert.equal(JSON.stringify(rows).includes('MATTER_BODY_SENTINEL'), false, `表 ${table.name} 含有案卷正文`)
    }
  } finally {
    db.close()
  }

  rmSync(ledgerDir, { recursive: true, force: true })
  assert.equal(readFileSync(bodyPath, 'utf8').includes(sentinel), true, '删掉台账后交底书还在')
  assert.equal(readFileSync(logPath, 'utf8').includes(sentinel), true, '删掉台账后 _matter-log.md 还在')
  assert.equal(existsSync(dbPath), false, '台账文件已经删掉')
  rmSync(root, { recursive: true, force: true })
})
