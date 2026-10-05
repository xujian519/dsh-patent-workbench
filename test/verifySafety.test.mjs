/**
 * AX-V03 / V04 / V05 与 AX-G03：自锁与安装目标校验。
 *
 * 判据来源：requirements.md §7.1（环境与授权）、acceptance.md AX-V03–V05 / AX-G03、plan.md V03。
 *
 * 这一组全部是**负向**判据 —— 正常路径只有一条，拒绝路径有一堆：
 *
 * | 拒绝理由 | 为什么必须拒绝 |
 * |---|---|
 * | 同端口 | 目标就是当前会话所在实例，装盘/重启会掐断自己 |
 * | 同 profile **物理目录**（含链接指过去） | 同上，换个端口也还是同一个实例 |
 * | 同**数据库物理文件** | 默认 DB 跨 profile 共用；写进去就是写用户的正式库 |
 * | 目标没显式配置独立 DB | "换端口/换 profile 名"根本不构成隔离证据 |
 * | `--db-path` 与实际配置不一致 | 参数是声明，不是证据 |
 * | 实际配置读不完整/多层冲突 | 证明不了独立 → fail-closed |
 * | 环境事实缺失/非法 | 拿不到 DSH_WEB_URL 就没法证明"目标不是当前实例" |
 * | 继承来的 desktop `DSH_PROFILE_DIR` | dev-install 会把它当成 web 的目标 |
 * | 非 3080/web | 超出预授权范围，`--force` 不能扩权 |
 *
 * 并且：**拒绝时安装/kill/DB 写次数必须是 0**（AX-V03/V05 的硬要求）。
 * 本文件里 preflight 被注入了 spawn/kill/writeDb/writeFile 探针，跑完必须全是 0；
 * 另有源码级断言：safety.mjs 不许 import child_process、不许出现写文件的调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTHORIZED_PORT,
  OVERRIDDEN_ENV,
  SCRUBBED_ENV,
  STAGE_PLAN,
  findPluginEntries,
  isLoopbackHost,
  normalizePath,
  parseHttpUrl,
  preflight,
  resolveDbPathConfig,
} from '../scripts/verify/safety.mjs'
import {
  buildPortOwnerCommandsPosix,
  buildPortOwnerScript,
  findPortOwner,
  isTargetDshProcess,
  resolveDshCommand,
  restartTarget,
  stopProcess,
} from '../scripts/verify/runtime.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOTFS = process.platform === 'win32' ? 'C:\\' : '/'
const DSH_HOME = join(ROOTFS, 'home', 'tester', '.dsh')
const CURRENT_DIR = join(DSH_HOME, 'profiles', 'desktop')
const TARGET_DIR = join(DSH_HOME, 'profiles', 'web')
const OTHER_WEB_DIR = join(DSH_HOME, 'profiles', 'web-staging')
const VERIFY_DB = join(DSH_HOME, 'workbench', 'verify-web.db')
const SHARED_DB = join(DSH_HOME, 'workbench', 'workbench.db')

const pathKey = (path) => (process.platform === 'win32' ? String(path).toLowerCase() : String(path))

/** 组装一个全注入的预检环境：零真实 FS 访问 + 副作用探针全为 0。 */
function harness({ configs = {}, existing = [TARGET_DIR, CURRENT_DIR], realpathMap = {} } = {}) {
  const existsSet = new Set(existing.map(pathKey))
  const realpaths = new Map(Object.entries(realpathMap).map(([key, value]) => [pathKey(key), value]))
  const effects = { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 }
  const deps = {
    platform: process.platform,
    existsSync: (path) => existsSet.has(pathKey(path)),
    realpath: (path) => realpaths.get(pathKey(path)) ?? path,
    statSync: () => ({ isDirectory: () => true }),
    spawn: () => { effects.spawned += 1 },
    kill: () => { effects.killed += 1 },
    writeDb: () => { effects.dbWrites += 1 },
    writeFileSync: () => { effects.filesWritten += 1 },
    readActualConfig: ({ profileDir }) => {
      const entry = configs[pathKey(profileDir)]
      if (entry === undefined) return { ok: true, values: {}, sources: [], conflicts: [], unparsable: [] }
      return {
        ok: (entry.unparsable ?? []).length === 0 && (entry.conflicts ?? []).length === 0,
        values: entry.values ?? {},
        sources: entry.sources ?? [],
        conflicts: entry.conflicts ?? [],
        unparsable: entry.unparsable ?? [],
      }
    },
  }
  return { deps, effects }
}

const baseEnv = () => ({
  DSH_WEB_URL: 'http://127.0.0.1:19387',
  DSH_PROFILE: 'desktop',
  DSH_PROFILE_DIR: CURRENT_DIR,
  DSH_HOME,
})

const baseInput = (overrides = {}) => ({
  url: `http://127.0.0.1:${AUTHORIZED_PORT}`,
  profile: 'web',
  profileDir: TARGET_DIR,
  dbPath: VERIFY_DB,
  env: baseEnv(),
  ...overrides,
})

const codes = (verdict, severity = 'error') => verdict.reasons.filter((entry) => entry.severity === severity).map((entry) => entry.code)

function isolatedHarness(overrides = {}) {
  return harness({
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
      [pathKey(CURRENT_DIR)]: { values: {} },
      ...(overrides.configs ?? {}),
    },
    ...overrides,
  })
}

test('AX-V05：正常路径（目标独立 DB + 不同端口/profile 名 + 目录不同）通过，且副作用全 0', () => {
  const { deps, effects } = isolatedHarness()
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, true, `不该拒绝：${JSON.stringify(verdict.reasons)}`)
  assert.equal(verdict.exitCode, 0)
  assert.deepEqual(effects, { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 }, '预检不许有任何副作用')
  assert.equal(verdict.facts.target.dbPath.toLowerCase().includes('verify-web.db'), true)
  assert.equal(verdict.facts.current.dbPath.toLowerCase().includes('workbench.db'), true)
  assert.notEqual(verdict.facts.target.dbPath, verdict.facts.current.dbPath)
  assert.deepEqual(Object.keys(verdict.plan.childEnv).sort(), ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_EXPECTED_DB_PATH', 'WORKBENCH_PROFILE_DIR'])
  assert.equal(verdict.plan.stages.length, STAGE_PLAN.length)
  assert.equal(verdict.plan.stages[0].name, 'preflight')
  assert.equal(verdict.plan.stages[0].readonly, true)
  assert.deepEqual(verdict.plan.overrideEnv, OVERRIDDEN_ENV)
  assert.deepEqual(verdict.plan.scrubEnv, SCRUBBED_ENV)
})

test('AX-V03：目标端口 == 当前 DSH_WEB_URL 端口 → 拒绝，且 --force 绕不过', () => {
  const { deps } = isolatedHarness()
  const env = { ...baseEnv(), DSH_WEB_URL: `http://127.0.0.1:${AUTHORIZED_PORT}` }
  for (const force of [false, true]) {
    const verdict = preflight(baseInput({ env, force }), deps)
    assert.equal(verdict.ok, false, `--force=${force} 时同端口必须仍然拒绝`)
    assert.ok(codes(verdict).includes('SAME_PORT'))
    assert.equal(verdict.exitCode, 2)
  }
  assert.equal(codes(preflight(baseInput({ env, force: true }), deps)).includes('SAME_PORT'), true)
})

test('AX-V03：DSH_WEB_URL 缺失/非法/非本机 → 拒绝（拿不到环境事实就没法自锁）', () => {
  const { deps } = isolatedHarness()
  for (const bad of [undefined, '', 'ftp://127.0.0.1:19387', 'http://10.0.0.5:19387', '不是URL']) {
    const env = { ...baseEnv(), DSH_WEB_URL: bad }
    const verdict = preflight(baseInput({ env }), deps)
    assert.equal(verdict.ok, false, `DSH_WEB_URL=${String(bad)} 必须拒绝`)
    assert.ok(codes(verdict).includes('ENV_URL_INVALID'), `期望 ENV_URL_INVALID，实际 ${codes(verdict)}`)
  }
  const missingProfile = preflight(baseInput({ env: { ...baseEnv(), DSH_PROFILE: undefined } }), deps)
  assert.ok(codes(missingProfile).includes('ENV_MISSING'))
  const missingDir = preflight(baseInput({ env: { ...baseEnv(), DSH_PROFILE_DIR: undefined } }), deps)
  assert.ok(codes(missingDir).includes('ENV_MISSING'))
})

test('AX-V03：非 3080/web 目标拒绝，--force 不能扩权', () => {
  const { deps } = isolatedHarness()
  const outOfPort = preflight(baseInput({ url: 'http://127.0.0.1:3999', force: true }), deps)
  assert.equal(outOfPort.ok, false)
  assert.ok(codes(outOfPort).includes('TARGET_OUT_OF_SCOPE'))
  const outOfProfile = preflight(baseInput({ profile: 'desktop', force: true }), deps)
  assert.equal(outOfProfile.ok, false)
  assert.ok(codes(outOfProfile).includes('TARGET_OUT_OF_SCOPE'))
  const remote = preflight(baseInput({ url: 'http://192.168.1.9:3080' }), deps)
  assert.ok(codes(remote).includes('TARGET_NOT_LOOPBACK'))
})

test('AX-V04：不同端口但 profile 是同一个物理目录（链接指过去）→ 拒绝', () => {
  const link = join(ROOTFS, 'links', 'web-via-desktop')
  const { deps } = isolatedHarness({ existing: [TARGET_DIR, CURRENT_DIR, link], realpathMap: { [link]: CURRENT_DIR } })
  const verdict = preflight(baseInput({ profileDir: link }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('SAME_PROFILE_DIR'), `期望 SAME_PROFILE_DIR，实际 ${codes(verdict)}`)
})

test('AX-V05：目标 DB 与当前是同一个物理文件 → 拒绝（--force 也绕不过）', () => {
  const { deps } = harness({
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dataDir: join(DSH_HOME, 'workbench') } },
      [pathKey(CURRENT_DIR)]: { values: {} },
    },
  })
  const verdict = preflight(baseInput({ dbPath: SHARED_DB, force: true }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('SAME_DB'), `期望 SAME_DB，实际 ${codes(verdict)}`)
})

test('AX-V05：目标没有显式独立 DB 配置 → 拒绝，并点名"它会用默认共享库"', () => {
  const { deps } = harness({ configs: { [pathKey(TARGET_DIR)]: { values: {} }, [pathKey(CURRENT_DIR)]: { values: {} } } })
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('DB_NOT_DECLARED'))
  const message = verdict.errors.find((entry) => entry.code === 'DB_NOT_DECLARED').message
  assert.ok(message.includes('workbench.db'), '必须说清它会落到哪个共享库')
  assert.ok(message.includes('换端口/换 profile 名都不能证明 DB 隔离'))
})

test('AX-V05：仅 --db-path 声明不能冒充隔离（必须与目标实际配置指向同一个文件）', () => {
  const { deps } = harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: join(DSH_HOME, 'workbench', 'other.db') } },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } })
  const verdict = preflight(baseInput({ dbPath: VERIFY_DB }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('DB_PATH_MISMATCH'))
  const ok = preflight(baseInput({ dbPath: join(DSH_HOME, 'workbench', 'other.db') }), deps)
  assert.equal(ok.ok, true, `实际配置与 --db-path 一致时应通过：${JSON.stringify(ok.reasons)}`)
})

test('AX-V05：目标/当前实际配置读不完整、多层冲突、缺 --db-path → 全部 fail-closed', () => {
  const unparsable = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: {}, unparsable: [{ file: 'x.yml', reason: 'config 里有不可静态判定的键：dbPath' }] },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } }).deps)
  assert.ok(codes(unparsable).includes('DB_UNKNOWN'))

  const currentUnparsable = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
    [pathKey(CURRENT_DIR)]: { values: {}, unparsable: [{ file: 'desktop.yml', reason: '读不了' }] },
  } }).deps)
  assert.ok(codes(currentUnparsable).includes('DB_UNKNOWN'), '当前实例的库也算不出来时不许声称"不同"')

  const conflict = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB }, conflicts: [{ key: 'dbPath', values: ['a', 'b'] }] },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } }).deps)
  assert.ok(codes(conflict).includes('DB_CONFLICT'))

  const noDbPath = preflight(baseInput({ dbPath: undefined }), isolatedHarness().deps)
  assert.ok(codes(noDbPath).includes('DB_PATH_REQUIRED'))
})

test('AX-V04：继承 desktop 的 DSH_PROFILE_DIR 不许传给 web 安装（子进程环境必须被重设）', () => {
  const { deps } = isolatedHarness()
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.plan.childEnv.DSH_PROFILE, 'web')
  assert.equal(verdict.plan.childEnv.DSH_PROFILE_DIR, TARGET_DIR)
  assert.equal(verdict.plan.childEnv.WORKBENCH_PROFILE_DIR, TARGET_DIR)
  assert.notEqual(verdict.plan.childEnv.DSH_PROFILE_DIR, CURRENT_DIR.replace(/desktop$/, 'desktop'))
  assert.equal(verdict.plan.childEnv.DSH_PROFILE_DIR, TARGET_DIR, '必须显式指向目标，而不是继承来的 desktop 目录')
  assert.ok(verdict.warnings.some((entry) => entry.code === 'INHERITED_PROFILE_DIR'), '继承污染必须被如实警告并说明会被重设')
  assert.deepEqual(verdict.plan.overrideEnv, ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_PROFILE_DIR'])

  const mismatch = preflight(baseInput({ env: { ...baseEnv(), WORKBENCH_PROFILE_DIR: CURRENT_DIR } }), deps)
  assert.equal(mismatch.ok, false)
  assert.ok(codes(mismatch).includes('WORKBENCH_PROFILE_DIR_MISMATCH'))

  const aligned = preflight(baseInput({ env: { ...baseEnv(), WORKBENCH_PROFILE_DIR: TARGET_DIR } }), deps)
  assert.equal(aligned.ok, true, `一致时不该报错：${JSON.stringify(aligned.reasons)}`)
})

test('AX-V04/AX-G03：profile 名相同但目录不同 → 无 --force 拒绝；带 --force 通过但必须写明原因', () => {
  const { deps } = harness({
    existing: [TARGET_DIR, OTHER_WEB_DIR],
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
      [pathKey(OTHER_WEB_DIR)]: { values: {} },
    },
  })
  const env = { ...baseEnv(), DSH_PROFILE: 'web', DSH_PROFILE_DIR: OTHER_WEB_DIR }
  const denied = preflight(baseInput({ env }), deps)
  assert.equal(denied.ok, false)
  assert.ok(codes(denied).includes('PROFILE_NAME_COLLISION'))
  assert.equal(denied.errors.find((entry) => entry.code === 'PROFILE_NAME_COLLISION').bypassable, true)

  const forced = preflight(baseInput({ env, force: true }), deps)
  assert.equal(forced.ok, true)
  const warning = forced.warnings.find((entry) => entry.code === 'PROFILE_NAME_COLLISION')
  assert.ok(warning !== undefined, '被 --force 绕过的原因必须留在报告里')
  assert.equal(warning.bypassedBy, 'force')
  assert.ok(warning.message.includes('--force'))
})

test('AX-V03/V05：preflight 全程零副作用（探针 0 / 源码里连 child_process 都不 import）', () => {
  const { deps, effects } = isolatedHarness()
  preflight(baseInput(), deps)
  preflight(baseInput({ force: true, url: 'http://127.0.0.1:3080', env: { ...baseEnv(), DSH_WEB_URL: 'http://127.0.0.1:3080' } }), deps)
  preflight(baseInput({ profileDir: undefined, dbPath: undefined }), deps)
  assert.deepEqual(effects, { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 })

  const source = readFileSync(join(REPO, 'scripts', 'verify', 'safety.mjs'), 'utf8')
  assert.equal(source.includes('child_process'), false, '预检模块不许有执行子进程的能力')
  assert.equal(/writeFileSync|rmSync|unlinkSync|execFileSync|spawnSync/.test(source), false, '预检模块不许写文件/删文件')
})

test('V03 解析：patch 里嵌套 insert / profile patch 的 config 都能被读出来；不可静态判定时报 unparsable', () => {
  const bundle = [
    '# bundle layer',
    '- insert:',
    '    - id: patent-workbench',
    "      name: 'dsh-patent-workbench'",
    '      config: {}',
    '- id: something-else',
    '  config:',
    '    dbPath: /should/not/be/read',
  ].join('\n')
  const parsed = findPluginEntries(bundle)
  assert.equal(parsed.entries.length, 1)
  assert.deepEqual(parsed.entries[0].config, {})
  assert.deepEqual(parsed.unparsable, [])

  const profile = [
    '- id: dsh-pocket',
    '  config:',
    '    port: 3082',
    '- id: patent-workbench',
    "  name: 'dsh-patent-workbench'",
    '  config:',
    '    dbPath: "C:/tmp/verify/web.db"',
    '    dataDir: C:/tmp/verify',
  ].join('\n')
  const profiled = findPluginEntries(profile)
  assert.equal(profiled.entries.length, 1)
  assert.deepEqual(profiled.entries[0].config, { dbPath: 'C:/tmp/verify/web.db', dataDir: 'C:/tmp/verify' })

  const dynamic = findPluginEntries(['- id: patent-workbench', '  config:', '    dbPath: !!js process.env.WB_DB'].join('\n'))
  assert.equal(dynamic.entries[0].unknownKeys.includes('dbPath'), true, '表达式算不出实际值时必须标记为不可静态判定')
  assert.equal(dynamic.entries[0].config.dbPath, undefined)
})

test('V03 解析：DB 路径语义与 openWorkbenchDb 一致（dbPath 优先于 dataDir，都没有就落默认共享库）', () => {
  assert.equal(resolveDbPathConfig({ dbPath: join(ROOTFS, 'x', 'a.db'), dataDir: join(ROOTFS, 'y') }, { home: DSH_HOME }), join(ROOTFS, 'x', 'a.db'))
  assert.equal(resolveDbPathConfig({ dataDir: join(ROOTFS, 'y') }, { home: DSH_HOME }), join(ROOTFS, 'y', 'workbench.db'))
  assert.equal(resolveDbPathConfig({}, { home: DSH_HOME }), join(DSH_HOME, 'workbench', 'workbench.db'))
  assert.equal(parseHttpUrl('http://127.0.0.1:3080/').port, 3080)
  assert.equal(parseHttpUrl('https://localhost/').port, 443)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('192.168.1.1'), false)
  assert.equal(normalizePath(join(ROOTFS, 'A', 'b')) === normalizePath(join(ROOTFS, 'a', 'B')), process.platform === 'win32')
})

test('AX-V04：dev-install 真的拒绝继承 desktop 目录（真子进程，零副作用：--print-target 不做构建/装盘）', () => {  const script = join(REPO, 'scripts', 'dev-install.mjs')
  const run = (args, env) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, cwd: REPO }) }
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  }
  const clean = { DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined, WORKBENCH_PROFILE_DIR: undefined }

  const plain = run(['--print-target', '--profile', 'web'], clean)
  assert.equal(plain.status, 0)
  assert.equal(JSON.parse(plain.stdout).profileDirSource.startsWith('默认'), true)

  const polluted = run(['--print-target', '--profile', 'web'], { ...clean, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: CURRENT_DIR })
  assert.notEqual(polluted.status, 0, '继承 desktop 目录去装 web 必须被拒绝')
  assert.match(polluted.stderr, /拒绝继承 profile 目录/)
  assert.match(polluted.stderr, /--profile-dir/)

  const explicit = run(['--print-target', '--profile', 'web', '--profile-dir', TARGET_DIR], { ...clean, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: CURRENT_DIR })
  assert.equal(explicit.status, 0)
  const parsed = JSON.parse(explicit.stdout)
  assert.equal(parsed.profileDir.toLowerCase(), TARGET_DIR.toLowerCase())
  assert.equal(parsed.profileDirSource.includes('--profile-dir'), true)

  const sameProfileInherited = run(['--print-target', '--profile', 'web'], { ...clean, DSH_PROFILE: 'web', DSH_PROFILE_DIR: TARGET_DIR })
  assert.equal(sameProfileInherited.status, 0)
  assert.equal(JSON.parse(sameProfileInherited.stdout).profileDir.toLowerCase(), TARGET_DIR.toLowerCase())
})

test('AX-V03：端口归属判据只认"目标那个 dsh web 实例"（杀进程前的最后一关，纯函数全表驱动）', () => {
  const owner = (name, commandLine) => ({ pid: 1234, name, commandLine })
  /**
   * 命令行的真实形态（2026-10-01 本机实测）：
   * `"node" "C:\Users\...\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080 --no-open`
   * —— `dsh` 出现在包路径里，不在可执行名里，所以判据必须看**整个命令行**。
   */
  const BIN = '"C:\\Users\\x\\AppData\\Roaming\\npm\\\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"'
  const cases = [
    ['端口没有监听进程', undefined, false],
    ['端口被别的程序占了', owner('chrome.exe', 'chrome.exe --remote-debugging-port=3080'), false],
    ['node 但不是 dsh', owner('node.exe', 'node C:\\other\\server.js --port 3080'), false],
    ['别的 dsh 无关服务（有 web 但整条命令行里没有 dsh）', owner('node.exe', 'node C:\\apps\\web-server\\bin.js web --port 3080'), false],
    ['是 dsh 但不是 web 子命令', owner('node.exe', `node ${BIN} desktop --port 3080`), false],
    ['dsh web 但端口对不上', owner('node.exe', `node ${BIN} web --port 3081`), false],
    ['dsh web --port 3080（空格式）', owner('node.exe', `node ${BIN} web --port 3080 --no-open`), true],
    ['dsh web --port=3080（等号式）', owner('node.exe', `node ${BIN} web --port=3080`), true],
    ['命令行显式指定了别的 profile', owner('node.exe', `node ${BIN} web --port 3080 --profile desktop`), false],
    ['命令行没写 profile（由 DSH_PROFILE 环境变量决定，允许）', owner('node.exe', `node ${BIN} web --port 3080`), true],
  ]
  /**
   * ⚠️ 这张表的每一行都是 **Windows** 形态（命令行里是 `AppData\Roaming\npm` 与 `node.exe`），
   * 所以必须显式传 `platform: 'win32'` —— 不传就按本机平台走（本机是 darwin，
   * 名字判据只认 `node`），那会让这张表在 macOS 上整片变红。POSIX 的形态见下面那两条用例。
   */
  for (const [label, candidate, expected] of cases) {
    const verdict = isTargetDshProcess(candidate, { port: 3080, profile: 'web', platform: 'win32' })
    assert.equal(verdict.ok === true, expected, `${label}：${JSON.stringify(verdict)}`)
    if (!expected) assert.equal(typeof verdict.reason, 'string', `${label} 必须给出可读原因`)
  }
})

/**
 * AX-V03 + §4.2：非 Windows 的端口归属。
 *
 * **审判据为什么被改**（2026-10-06）：老版本在非 Windows 上无条件 `ok:false`（"拒绝在没有归属校验能力时杀进程"）——
 * 那条纪律在**当时**是对的（当时确实没有实现），但它的代价是验收链在 macOS 上**必然**停在 restart。
 * 现在实现了 POSIX 的归属校验，判据改成三条更强的：
 * 1. 能证明 → 给 pid/name/commandLine（本文件只测**命令形状与解析**，真机实测在
 *    `scripts/repro/repro-dev-verify-posix.mjs`）；
 * 2. 证明不了（缺 lsof / ps 读不到 / 多个监听者）→ 拒绝且**必须带 `blocked:true`**（编排据此"继续跑但不报绿"）；
 * 3. 读到了但**不是目标进程** → 普通拒绝，**不带 `blocked`**（链不认识占端口的东西，必须硬停）。
 */
test('AX-V03：POSIX 端口归属（lsof+ps）——命令形状、解析分支、blocked 标记只在"能力缺失"时出现', () => {
  const commands = buildPortOwnerCommandsPosix(3080)
  assert.equal(commands.listPids, 'lsof -nP -iTCP:3080 -sTCP:LISTEN -t')
  assert.equal(commands.processName(42), 'ps -ww -p 42 -o comm=')
  assert.equal(commands.commandLine(42), 'ps -ww -p 42 -o command=')
  assert.match(commands.processName(42), /-ww/, '命令行/进程名必须用 -ww 读全：截断的判据输入等于瞎判')

  const run = (table) => (command) => {
    const hit = Object.keys(table).find((key) => command.includes(key))
    assert.notEqual(hit, undefined, `测试没有为这条命令准备应答：${command}`)
    return table[hit]
  }
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' })

  // 1) 正常：一个监听者 + 名字是整条路径（macOS 实测形态）→ 取 basename
  const found = findPortOwner(3080, {
    platform: 'darwin',
    runCommandSync: run({
      'lsof -nP': ok('43901\n'),
      'ps -ww -p 43901 -o comm=': ok('/Applications/DSH Patent.app/Contents/MacOS/DSH Patent\n'),
      'ps -ww -p 43901 -o command=': ok('/x/node /x/dsh/lib/bin.js web --port 3080\n'),
    }),
  })
  assert.equal(found.ok, true)
  assert.deepEqual(found.owner, { pid: 43901, name: 'DSH Patent', commandLine: '/x/node /x/dsh/lib/bin.js web --port 3080' })

  // 2) 端口空着：lsof 退出码 1 且无输出 —— **这不是错误**，是"没有监听者"
  const free = findPortOwner(3080, { platform: 'linux', runCommandSync: () => ({ status: 1, stdout: '', stderr: '' }) })
  assert.deepEqual(free, { ok: true, owner: undefined })

  // 3) 没有 lsof：退出码 127 → 拒绝且 blocked（不许把"查不了"当成"端口空着"）
  const noLsof = findPortOwner(3080, { platform: 'linux', runCommandSync: () => ({ status: 127, stdout: '', stderr: 'sh: lsof: not found' }) })
  assert.equal(noLsof.ok, false)
  assert.equal(noLsof.blocked, true)
  assert.match(noLsof.reason, /lsof/)
  assert.match(noLsof.reason, /--launcher/, '必须告诉人怎么绕过（把重启交给他自己的启动器）')

  // 4) 一个端口挂多个监听者：选谁都是猜 → 拒绝且 blocked
  const many = findPortOwner(3080, { platform: 'darwin', runCommandSync: () => ok('11\n22\n') })
  assert.equal(many.ok, false)
  assert.equal(many.blocked, true)
  assert.match(many.reason, /2 个监听进程/)

  // 5) ps 读不到（进程刚死）→ blocked，且**不许**把不完整的信息当 owner 交出去
  const psGone = findPortOwner(3080, {
    platform: 'darwin',
    runCommandSync: run({ 'lsof -nP': ok('43901\n'), 'ps -ww -p 43901': { status: 1, stdout: '', stderr: 'ps: No such process' } }),
  })
  assert.equal(psGone.ok, false)
  assert.equal(psGone.blocked, true)
  assert.match(psGone.reason, /No such process/)

  // 6) 命令行为空 → 没有命令行就证明不了它是谁 → blocked
  const empty = findPortOwner(3080, {
    platform: 'darwin',
    runCommandSync: run({ 'lsof -nP': ok('43901\n'), 'o comm=': ok('node\n'), 'o command=': ok('   \n') }),
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.blocked, true)
  assert.match(empty.reason, /命令行为空/)
})

test('AX-V03：进程名判据按平台（POSIX 只认 node；桌面端 DSH Patent 必须被拦住）', () => {
  const posixDsh = { pid: 1, name: 'node', commandLine: '/x/node /x/dsh/lib/bin.js web --port 3080 --no-open' }
  assert.equal(isTargetDshProcess(posixDsh, { port: 3080, profile: 'web', platform: 'darwin' }).ok, true)

  /**
   * 真机实测（2026-10-06）：本机 62620 的归属进程就是桌面端 —— 名字 `DSH Patent`、
   * 命令行里也含 `dsh` 字样（`app.asar/dsh/...`）。这条判据是"别把用户正在用的桌面端杀掉"的那一关。
   */
  const desktop = { pid: 43901, name: 'DSH Patent', commandLine: '/Applications/DSH Patent.app/Contents/MacOS/DSH Patent --expose-internals /Applications/DSH Patent.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' }
  const refused = isTargetDshProcess(desktop, { port: 62620, profile: 'web', platform: 'darwin' })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /非 node 进程/)

  // Windows 侧的判据**没有动**：`node.exe` 认，`node`（不带 .exe）不认
  assert.equal(isTargetDshProcess({ pid: 1, name: 'node.exe', commandLine: 'node C:\\dsh\\bin.js web --port 3080' }, { port: 3080, profile: 'web', platform: 'win32' }).ok, true)
  assert.equal(isTargetDshProcess({ pid: 1, name: 'node', commandLine: 'node C:\\dsh\\bin.js web --port 3080' }, { port: 3080, profile: 'web', platform: 'win32' }).ok, false)
})

test('AX-V03 + §4.2：POSIX 停机用 SIGTERM 且等它真的退出；绝不静默升级 SIGKILL', async () => {
  const signals = []
  const dead = new Set()
  const kill = (pid, signal) => {
    signals.push(`${pid}:${signal}`)
    if (signal === 0) { if (dead.has(pid)) { const error = new Error('no such process'); error.code = 'ESRCH'; throw error } return }
    if (signal === 'SIGTERM') dead.add(pid)
  }
  const stepped = await stopProcess({ pid: 7, name: 'node', commandLine: 'x' }, { platform: 'darwin', kill, sleep: async () => {}, graceMs: 50, pollMs: 1 })
  assert.equal(stepped.ok, true)
  assert.equal(stepped.method, 'sigterm')
  assert.deepEqual(signals.filter((entry) => entry.endsWith(':SIGTERM')), ['7:SIGTERM'], 'SIGTERM 只发一次')
  assert.ok(signals.some((entry) => entry === '7:0'), '必须轮询 kill(pid,0) 确认它真的死了，而不是 sleep 猜')
  assert.equal(signals.some((entry) => entry.includes('SIGKILL')), false, '不许出现 SIGKILL')

  // 不死的进程：如实失败 + 告诉人自己处理；仍然不许 SIGKILL
  const stubborn = []
  const stuck = await stopProcess({ pid: 8, name: 'node', commandLine: 'x' }, { platform: 'darwin', kill: (pid, signal) => { stubborn.push(`${pid}:${signal}`) }, sleep: async () => {}, graceMs: 30, pollMs: 1 })
  assert.equal(stuck.ok, false)
  assert.match(stuck.reason, /SIGTERM 后 30ms 仍在运行/)
  assert.match(stuck.reason, /人工/)
  assert.equal(stubborn.some((entry) => entry.includes('SIGKILL')), false)

  // 发信号前就没了 / 发信号被拒
  const gone = await stopProcess({ pid: 9, name: 'node', commandLine: 'x' }, { platform: 'darwin', kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error } })
  assert.equal(gone.ok, true)
  assert.equal(gone.killed, false)
  const denied = await stopProcess({ pid: 10, name: 'node', commandLine: 'x' }, { platform: 'darwin', kill: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error } })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /EPERM/)

  // Windows 分支保持原样：Stop-Process -Force
  const seen = []
  const win = await stopProcess({ pid: 11, name: 'node.exe', commandLine: 'x' }, { platform: 'win32', runCommandSync: (command) => { seen.push(command); return { status: 0, stdout: '', stderr: '' } } })
  assert.equal(win.ok, true)
  assert.match(seen[0], /Stop-Process -Id 11 -Force/)
})

test('AX-V03 + §4.2：没有监听进程时停机是空操作（不报错、也不发信号）', async () => {
  const result = await stopProcess(undefined, { platform: 'darwin', kill: () => { throw new Error('不该被调用') } })
  assert.deepEqual(result, { ok: true, killed: false })
})

test('AX-V03 + §4.2：重启的启动器按平台跑（POSIX 走 sh，Windows 走 cmd /c）', async () => {
  const commands = []
  const deps = {
    platform: 'darwin',
    existsSync: () => true,
    runCommand: async (command) => { commands.push(command); return { status: 0, stdout: '', stderr: '', ms: 1 } },
    fileSize: () => 0,
  }
  const posix = await restartTarget({ port: 3080, profile: 'web', workDir: '/tmp', launcher: '/tmp/restart-web.sh', env: {}, logPath: '/tmp/x.log' }, deps)
  assert.equal(posix.ok, true)
  assert.equal(posix.method, 'launcher')
  assert.deepEqual(commands, ['sh "/tmp/restart-web.sh"'])

  const winCommands = []
  const win = await restartTarget({ port: 3080, profile: 'web', workDir: 'C:\\tmp', launcher: 'C:\\restart-web.ps1', env: {}, logPath: 'C:\\x.log' }, {
    platform: 'win32',
    existsSync: () => true,
    runCommand: async (command) => { winCommands.push(command); return { status: 0, stdout: '', stderr: '', ms: 1 } },
    fileSize: () => 0,
  })
  assert.equal(win.ok, true)
  assert.deepEqual(winCommands, ['cmd /c ""C:\\restart-web.ps1""'], 'Windows 侧的原命令一个字符都不许变')

  /**
   * 启动器前台跑实例（不返回）→ 超时。2026-10-06 真机实测撞到过：
   * `run()` 在等这个子进程，链一路挂到 180s。判据要求**报超时**（退出码 3），
   * 不许报成"退出码 1" —— 那会让人去查一个不存在的错误码。
   */
  const timedOut = await restartTarget({ port: 3080, profile: 'web', workDir: '/tmp', launcher: '/tmp/slow.sh', env: {}, logPath: '/tmp/x.log' }, {
    platform: 'darwin',
    existsSync: () => true,
    fileSize: () => 0,
    runCommand: async () => ({ status: 1, stdout: '', stderr: '', ms: 180000, timedOut: true }),
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.exitCode, 3, '超时是退出码 3 那一档，不是 1')
  assert.match(timedOut.reason, /180s 没返回/)
  assert.match(timedOut.reason, /后台/)

  // 启动器不存在 = 配置写错（不是"本机做不到"）→ 硬失败，**不许**带 blocked
  const missing = await restartTarget({ port: 3080, profile: 'web', launcher: '/tmp/nope.sh', env: {}, logPath: '/tmp/x.log' }, { platform: 'darwin', existsSync: () => false })
  assert.equal(missing.ok, false)
  assert.equal(missing.exitCode, 2)
  assert.notEqual(missing.blocked, true)
})

test('AX-V03 + §4.2：端口归属证明不了 ⇒ blocked 透传到编排（下游照跑、本轮不报绿）', async () => {
  const blocked = await restartTarget({ port: 3080, profile: 'web', env: {}, logPath: '/tmp/x.log' }, {
    platform: 'darwin',
    findPortOwner: () => ({ ok: false, blocked: true, reason: '这台机器没有 lsof' }),
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.exitCode, 2)
  assert.match(blocked.reason, /没有 lsof/)

  // 链**认识**占着端口的那个进程、只是拒绝下手 ⇒ 硬停，不带 blocked
  const refused = await restartTarget({ port: 3080, profile: 'web', env: {}, logPath: '/tmp/x.log' }, {
    platform: 'darwin',
    findPortOwner: () => ({ ok: true, owner: { pid: 5, name: 'chrome', commandLine: 'chrome --remote-debugging-port=3080' } }),
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.exitCode, 2)
  assert.notEqual(refused.blocked, true)
  assert.match(refused.reason, /拒绝 kill/)

  /**
   * 还有一条**必须**是 blocked：本机找不到 dsh 的 `bin.js`（`restartTarget` 里 `resolved.kind==='missing'`）。
   * 这条断言的来历：2026-10-06 变异验证里"把 missing 退回硬失败（去掉 blocked）"**活下来了** ——
   * 因为当时只有真机复现脚本覆盖它，单测没覆盖。补上之后同一条变异立刻变红。
   */
  const noBin = await restartTarget({ port: 3080, profile: 'web', env: {}, logPath: '/tmp/x.log' }, {
    platform: 'darwin',
    findPortOwner: () => ({ ok: true, owner: undefined }),
    resolveDshCommand: () => ({ kind: 'missing', reason: '没找到 dsh 的 bin.js（探测过：A、B、C）' }),
  })
  assert.equal(noBin.ok, false)
  assert.equal(noBin.exitCode, 2)
  assert.equal(noBin.blocked, true, '找不到入口是"本机做不到"（blocked），不是硬失败')
  assert.match(noBin.reason, /没找到 dsh 的 bin\.js/)
})

/**
 * AX-V03：dsh 命令发现。
 *
 * 2026-10-01（T6 第一次真跑）改过行为，判据跟着改，**不是**放宽：
 * 1. 原来"什么都没配就退回 PATH 上的 `dsh`"—— 实测那条路会走 `dsh.cmd`（多一层 cmd.exe），
 *    **stdout 落不进日志文件**，token 阶段必然 60s 超时；而且 PATH 上的 dsh 未必是目标实例的那个。
 *    现在改成：显式覆盖 / 找到全局安装的 `bin.js`（直接 `node bin.js`）/ **明确失败**。
 * 2. 返回值从"字符串命令"变成带 `kind` 的对象 —— 编排要按 kind 决定怎么 spawn（shell vs 直接 node）。
 *
 * 2026-10-06（§4.2）加 POSIX 候选，并把 `existsSync` 做成可注入：老版本这条用例实际读**本机磁盘**，
 * 于是"本机恰好没有那个文件"才是它通过的原因（在装了 dsh 的机器上会红/绿不定）。现在用假文件表，任何机器上结论一致。
 */
test('AX-V03 + §4.2：dsh 命令发现（覆盖优先 → 全局 bin.js → 明确失败，不猜 PATH；POSIX 与 Windows 各自的路）', () => {
  const withOverride = resolveDshCommand({ DSH_VERIFY_DSH_CMD: 'C:/tools/dsh.cmd' }, { existsSync: () => false })
  assert.equal(withOverride.kind, 'override')
  assert.equal(withOverride.command, 'C:/tools/dsh.cmd')

  const nothing = resolveDshCommand({}, { platform: 'win32', existsSync: () => false, homedir: () => join(ROOTFS, 'home', 'tester') })
  assert.equal(nothing.kind, 'missing', '找不到 bin.js 时必须明确失败（不许悄悄用 PATH 上的 dsh）')
  assert.match(nothing.reason, /bin\.js|DSH_VERIFY_DSH_CMD/)

  const appData = join(ROOTFS, 'home', 'tester', 'AppData', 'Roaming')
  const win = resolveDshCommand({ APPDATA: appData }, {
    platform: 'win32',
    existsSync: (path) => path === join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  })
  assert.equal(win.kind, 'node')
  assert.equal(win.bin, join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.equal(win.command, process.execPath, '要直接 node bin.js（绕开 cmd.exe 那一层）')

  // POSIX 1：与当前 Node 同前缀的全局安装（nvm / Homebrew / apt 的布局）
  const execPath = join(ROOTFS, 'nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node')
  const nvmBin = join(ROOTFS, 'nvm', 'versions', 'node', 'v22.22.3', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const nvm = resolveDshCommand({}, { platform: 'darwin', execPath, homedir: () => '/home/tester', existsSync: (path) => path === nvmBin })
  assert.equal(nvm.kind, 'node')
  assert.equal(nvm.bin, nvmBin)
  assert.equal(nvm.command, execPath)

  // POSIX 2：独立本地安装（本机实测的那一种：~/.local/bin/dsh 是个 shim → ~/.local/lib/dsh/backend/lib/bin.js）
  const localBin = '/home/tester/.local/lib/dsh/backend/lib/bin.js'
  const local = resolveDshCommand({}, { platform: 'darwin', execPath, homedir: () => '/home/tester', existsSync: (path) => path === localBin })
  assert.equal(local.bin, localBin)
  assert.match(local.source, /独立本地安装/)

  // POSIX 3：一个候选都没有 → missing，且把探测过的路径都列出来
  const none = resolveDshCommand({}, { platform: 'linux', execPath, homedir: () => '/home/tester', existsSync: () => false })
  assert.equal(none.kind, 'missing')
  assert.ok(none.reason.split('、').length >= 3, `必须列出探测过的候选路径：${none.reason}`)
  assert.equal(/PATH/.test(none.reason), false)

  /**
   * POSIX 4：**PATH 上有 dsh 也不许用**（ADR0006 明令：那条路会多一层 shell，
   * stdout 落不进日志文件；而且 PATH 上的 dsh 未必是目标实例的那个）。
   *
   * 这条断言的来历：变异验证里"给 POSIX 加一条 `/usr/local/bin/dsh` 兜底"**活下来了** ——
   * 因为上面那条用的是 `existsSync: () => false`，兜底候选也一并看不见。
   * 现在把 PATH 上的 dsh **做成存在的**：正确实现必须仍然判 missing。
   */
  const withPathDsh = resolveDshCommand({}, {
    platform: 'linux',
    execPath,
    homedir: () => '/home/tester',
    existsSync: (path) => path === '/usr/local/bin/dsh' || path === '/usr/bin/dsh',
  })
  assert.equal(withPathDsh.kind, 'missing', 'PATH 上的 dsh 存在也不许用：它不是"目标实例的那个 dsh"')
})

test('AX-V03：端口归属脚本走 .ps1 文件（不内联转义，ConvertTo-Json 输出必须能被 JSON.parse）', () => {
  const script = buildPortOwnerScript(3080)
  assert.match(script, /Get-NetTCPConnection/)
  assert.match(script, /ConvertTo-Json/)
  assert.equal(/-Compress/.test(script), false, '不许用 -Compress：它输出的 {none:true} 不是合法 JSON（本次实测踩到）')
  assert.match(script, /\{"none":true\}/, '查不到时必须输出**合法** JSON 的空结果')
})
