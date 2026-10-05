/**
 * 打开/迁移工作台 SQLite 数据库。
 * 运行态数据库默认在 ~/.dsh/workbench/workbench.db。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'
import { withTransaction } from './repo/shared.js'

export interface WorkbenchDbConfig {
  /** 数据目录；缺省 ~/.dsh/workbench */
  dataDir?: string
  /** 数据库文件绝对路径；优先于 dataDir */
  dbPath?: string
}

export function defaultDbPath(): string {
  return join(homedir(), '.dsh', 'workbench', 'workbench.db')
}

/**
 * 忙等上限：多个连接同时写时**排队等**这么久，超时才报 `SQLITE_BUSY`。
 *
 * 为什么必须有（2026-10-05 审计 §3.4）：本仓自己把"多机共用 `DSH_HOME`"写进了注释
 * （v1.16.4 的 `DB_PATH_MISMATCH` 就是撞到过），而此前全仓**一处 `busy_timeout` 都没有** ——
 * 默认是 0，于是两个连接同时写不是"等一下"，而是**立刻** `SQLITE_BUSY`。
 * 表现形态很坏：用户点一下保存，偶发失败，重试又成功。
 *
 * 5000ms 的取值理由：这是本机交互式操作的量级（用户点一下 → 写完），
 * 而不是批处理的量级；超过 5 秒的话，HTTP 请求早该返回错误而不是继续挂着。
 */
export const BUSY_TIMEOUT_MS = 5000

/**
 * 全新库的判据里用到的**业务表**：只要其中任何一张存在，这个库就"跑过迁移"。
 *
 * 为什么需要这份名单：`meta` 表与业务表是**分开创建**的（`migrate()` 第一句建 meta），
 * 所以"业务表在、meta 没了"是一种真实可达的状态（手改库、旧版本写坏、文件被截断）。
 * 见 `assertFreshDatabase`。
 */
const BUSINESS_TABLES = ['dictionaries', 'tasks', 'task_drafts', 'knowledge_entries', 'matters', 'task_events'] as const

/**
 * 迁移表自身的不变量：版本号**唯一**且**严格升序**。
 *
 * 为什么要断言：`migrate()` 的循环是 `if (migration.version <= current) continue` ——
 * 它假定版本号单调。一旦手抖写出重复版本（复制粘贴新迁移改了 `up` 忘了改 `version`），
 * 重复的那条会被 `<=` 静默跳过，schema 停在半截，而**没有任何报错**。
 * 升序同理：乱序时 `current` 会先跳到较大的值，于是排在后面的小版本永远不跑。
 * 这两件事在测试里都可能全绿（新装的库恰好都跑到），只有老库升级那天才炸。
 *
 * 最后一条断言（最大版本 == `SCHEMA_VERSION`）是为了堵住另一个方向的错：
 * 加了迁移却忘了抬 `SCHEMA_VERSION`，或者抬了却没加迁移。
 */
export function assertMigrationTable(): void {
  if (MIGRATIONS.length === 0) throw new Error('迁移表为空：工作台无法建库（构建产物损坏？）')
  const seen = new Set<number>()
  let previous = 0
  for (const migration of MIGRATIONS) {
    const { version } = migration
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`迁移表里有非法版本号 ${JSON.stringify(version)}（必须是 >=1 的整数）`)
    }
    if (seen.has(version)) {
      throw new Error(`迁移表里有重复版本号 ${version}：重复的那条会被 migrate() 静默跳过，schema 会停在半截。请修正后再发布。`)
    }
    if (version <= previous) {
      throw new Error(`迁移表版本号不是严格升序：${previous} 之后出现 ${version}。乱序会让后面较小的版本永远不执行。`)
    }
    seen.add(version)
    previous = version
  }
  if (previous !== SCHEMA_VERSION) {
    throw new Error(`迁移表最大版本 ${previous} 与 SCHEMA_VERSION ${SCHEMA_VERSION} 不一致（加了迁移就要抬 SCHEMA_VERSION，反之亦然）`)
  }
}

/**
 * 读库里的 schema 版本（不存在 = 0 = 新库）。
 *
 * ⚠️ 脏值必须**当场拒绝**，绝不能当成 0：
 * `Number('…')` 对非数字串给 `NaN`，而 `migration.version <= NaN` 恒为 false ——
 * 于是**全部迁移会从第一个开始重放**。在已有数据的库上重放，轻则撞"表已存在"让插件起不来，
 * 重则按建表语句把历史数据改掉。这不是理论风险：手改过 meta、或旧版本写过别的形状，都会走到这里。
 * 负数与小数同理会让判定错位（小数会让某一条迁移被跳过且版本号不前进）。
 *
 * 拒绝并说清原因，比默默重放安全；回滚点见数据目录下的 `backups/`。
 */
function readVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  if (row === undefined) return 0
  const raw = row.value.trim()
  if (raw === '') return 0
  const version = Number(raw)
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`工作台数据库的 schema_version 不是合法版本号（读到 ${JSON.stringify(row.value)}）：拒绝按"版本 0"重放全部迁移。请从数据目录的 backups/ 恢复，或联系维护者。`)
  }
  return version
}

/**
 * 版本读出来是 0 时，确认这**真的**是个空库。
 *
 * ## 为什么必须有（2026-10-05 审计 §3.1 的第 2 条，实测可达）
 *
 * `schema_version` 的行没了（或 meta 表整个没了）时，`readVersion` 返回 0。
 * 历史行为是"当成全新库，从迁移 1 重放" —— 而 `V1_DDL` 首句是**不带 `IF NOT EXISTS`** 的
 * `CREATE TABLE dictionaries`，于是必然抛错 → ROLLBACK → 插件降级空转。
 * 数据没丢（回滚了），但：**用户卡死在一个"无法打开"的工作台上，而且一个备份都没留下**
 * —— 因为备份只挂在"将要跑破坏性迁移"这一条路上，此时 `current` 读出来是 0，
 * 被判成"没有可丢的东西"而跳过。
 *
 * 所以判据不能只看版本号，要**同时看有没有业务表**：
 * - 业务表一张都没有 → 真·空库 → 正常建库；
 * - 有业务表 → 这不是空库，是**元数据坏了** → 拒绝打开，指路 backups/。
 *
 * 拒绝而不是"猜一个版本继续"：猜错就是拿用户的任务/知识/案卷当赌注。
 */
function assertFreshDatabase(db: DatabaseSync): void {
  const placeholders = BUSINESS_TABLES.map(() => '?').join(', ')
  const found = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...BUSINESS_TABLES) as unknown as Array<{ name: string }>
  if (found.length === 0) return
  const names = found.map((row) => row.name).sort().join('、')
  throw new Error(
    `工作台数据库不是空库（已存在业务表：${names}），但读不到 schema_version（meta 表或该行丢失）。`
    + '拒绝按"版本 0"重放全部迁移 —— 那会拿你的任务/知识/案卷当赌注。'
    + '请从数据目录的 backups/ 里挑一份最近的备份恢复（备份是自包含单文件：覆盖 workbench.db，'
    + '并删掉同目录残留的 workbench.db-wal / workbench.db-shm），或联系维护者。',
  )
}

/** 时间戳：`YYYYMMDD-HHMMSS`（本地时间，供人读）。 */
function backupStamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 挑一个**当前不存在**的路径：同名已有文件时依次试 `-2`、`-3`…（同一秒内两次调用不会互相覆盖）。
 *
 * 为什么需要：`VACUUM INTO` 遇到已存在的目标文件会**报错**（实测 `output file already exists`）。
 * 若不做这件事，同一秒内第二次开库就是一次"打不开工作台"的假故障。
 */
export function freeSnapshotPath(file: string): string {
  let candidate = file
  for (let index = 2; index < 100; index += 1) {
    if (!existsSync(candidate)) return candidate
    candidate = `${file}-${index}`
  }
  throw new Error(`备份文件名冲突过多，无法生成空闲路径：${file}`)
}

/**
 * 用 `VACUUM INTO` 做一份**一致快照**，返回落盘路径。
 *
 * ## 为什么不是"checkpoint + copyFileSync"（2026-10-05 审计 §3.1，实测推翻旧实现）
 *
 * 旧实现是 `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')` 后 `copyFileSync(db, target)`。
 * 三处问题，全部实测过：
 *
 * 1. **`exec` 的返回值是 `undefined`** —— `wal_checkpoint` 的状态只有
 *    `prepare(...).get()` 才拿得到（实测：`{"busy":0,"log":0,"checkpointed":0}`）。
 *    旧代码把返回值丢掉了，所以"checkpoint 有没有成功"根本没人看。
 * 2. **`busy=1` 是真实可达的**：另一个连接持有读快照时，实测
 *    `{"busy":1,"log":1,"checkpointed":0}` —— WAL 没截断。
 * 3. 此时 `copyFileSync` 得到的是**缺最新事务**的备份。实测：活库 `t` 有 2 行，
 *    朴素拷贝出来的副本只有 1 行。文件在、大小也对，**回滚时才发现少了数据**。
 *
 * `VACUUM INTO` 把这三件事一次消掉：它读的是**单个事务的一致性快照**
 * （实测在有外部读快照、且 WAL 未截断时，快照里仍有最新那 3 行），
 * 输出是**自包含单文件**（`journal_mode=delete`，不依赖 `-wal`/`-shm`），
 * 顺带把库紧凑化。它还能在**只读连接**上跑（救援脚本就靠这一点）。
 *
 * 注意参数必须走**绑定**（`VACUUM INTO ?` 实测可用）：路径里带单引号时拼接会写坏 SQL。
 *
 * @param db 源连接（可读即可）
 * @param target 目标文件路径；**必须不存在**（调用方用 `freeSnapshotPath` 兜底）
 */
export function snapshotDatabase(db: DatabaseSync, target: string): void {
  db.prepare('VACUUM INTO ?').run(target)
}

/**
 * 破坏性迁移前的**整库备份**（决策 D4「迁移前自动备份」）。
 *
 * ## 为什么必须有
 *
 * `migrate()` 里的破坏性迁移（`destructive: true`，如 `DROP TABLE`）是不可逆的。
 * 光在提交说明里写"已经备份过了"只对**开发者自己的机器**成立；用户装盘那一刻跑的是
 * 迁移本身，没人替他备份。所以备份必须长在打开库的路径上。
 *
 * ## 四个刻意的判断
 *
 * 1. **只有"将要跑破坏性迁移"才备份**（有一条 `destructive` 的版本号大于当前版本）。
 *    每次开库都拷一份会让 `backups/` 迅速膨胀，也会掩盖真正的回滚点。
 * 2. **用 `VACUUM INTO` 而不是拷贝文件**：见 `snapshotDatabase` 的注释（实测三处问题）。
 * 3. **备份后回读断言**：把备份**当库打开**，读它的 `schema_version` 必须正好等于
 *    `current`。旧实现只 `existsSync(file)` —— "文件在"不等于"备份可用"，
 *    而上面那条 WAL 坑恰好就是"文件在、内容缺"（实测就是这么漏的）。
 * 4. **拷不出来就抛**（不吞）：宁可让插件启动失败并说清原因，也不能在没有回滚点的情况下
 *    去删表。全新库（`schema_version` 为 0 或不存在）没有可丢的东西，跳过
 *    —— 但"业务表在而版本读成 0"**不算全新库**，见 `assertFreshDatabase`。
 *
 * 返回备份文件路径（跳过时返回 undefined），便于测试与排障时直接断言。
 */
function backupBeforeDestructiveMigrations(db: DatabaseSync, dbPath: string): string | undefined {
  if (dbPath === ':memory:' || dbPath === '') return undefined
  /**
   * ⚠️ `meta` 表是 `migrate()` 自己建的，而本函数跑在它**之前** —— 全新库这里
   * 连表都没有（本轮实测踩到：`no such table: meta`）。没有 meta 表 = 一个迁移都没跑过
   * = 没有任何可丢的东西，直接跳过。
   */
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined
  if (!hasMeta) {
    assertFreshDatabase(db)
    return undefined
  }
  const current = readVersion(db)
  if (current === 0) {
    // 版本读成 0：要么真是空库，要么是"业务表在、meta 坏了"。后者必须拒开（不是"没什么可丢"）。
    assertFreshDatabase(db)
    return undefined
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current && migration.destructive === true)
  if (pending.length === 0) return undefined
  const target = pending[pending.length - 1].version
  const dir = join(dirname(dbPath), 'backups')
  mkdirSync(dir, { recursive: true })
  const file = freeSnapshotPath(join(dir, `${basename(dbPath, '.db')}-${backupStamp()}-pre-schema${current}-to-${target}.db`))
  snapshotDatabase(db, file)
  /**
   * 回读断言（不是 `existsSync`）：备份必须能被独立打开，且**停在迁移前的版本**。
   * 任何一步不成立都抛 —— 在没有可用回滚点的情况下继续去删表是禁止的。
   */
  let restored: DatabaseSync
  try {
    restored = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    throw new Error(`破坏性迁移前备份不可用（打开备份失败）：${file} —— ${String(error)}。已中止迁移（不删表）`)
  }
  try {
    assertMigrationTable()
    const row = restored.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    const version = row === undefined ? '（缺 schema_version 行）' : row.value
    if (String(version) !== String(current)) {
      throw new Error(`破坏性迁移前备份校验失败：备份里的 schema_version 是 ${version}，期望 ${current}（备份文件 ${file}）。已中止迁移（不删表）`)
    }
  } finally {
    restored.close()
  }
  return file
}

/**
 * 数据库 schema 比当前插件版本新——典型成因是插件被包管理器回退
 * （`dsh plugin add` 是 pnpm 转发器，会按 pnpm-lock.yaml 对齐整个 profile）。
 *
 * 单独成类型是为了让宿主侧能按类型判别并**降级**，而不是把整个 DSH 拖死：
 * 数据库比插件新属于运维常态（版本回退、多机共用 DSH_HOME），
 * 不该等于"宿主拒绝启动"。
 */
export class SchemaTooNewError extends Error {
  readonly dbVersion: number
  readonly supportedVersion: number

  constructor(dbVersion: number, supportedVersion: number) {
    super(`workbench db schema version ${dbVersion} is newer than supported ${supportedVersion}`)
    this.name = 'SchemaTooNewError'
    this.dbVersion = dbVersion
    this.supportedVersion = supportedVersion
  }
}

/**
 * 跑迁移。`dbPath` 只用于**破坏性迁移前的备份落点**；省略/`:memory:` 时跳过备份
 * （内存库没有可丢的东西，测试也因此可以继续只传 `db`）。
 *
 * 备份从 `openWorkbenchDb` **移进来**（2026-10-05 审计 §3.1 的第 3 条）：
 * 备份是"迁移的"前置条件，把两者放在同一个函数里，才不会出现"有人新开一条
 * 建库路径、忘了先备份"的情况 —— 后者正是这次审计能发现漏洞的原因。
 */
export function migrate(db: DatabaseSync, dbPath?: string): void {
  assertMigrationTable()
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const current = readVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(current, SCHEMA_VERSION)
  }
  if (current === 0 && dbPath !== undefined) {
    // 走的是"打开真实文件"这条路：把"业务表在而版本为 0"的坏库挡在重放迁移之前。
    assertFreshDatabase(db)
  }
  if (dbPath !== undefined && current !== 0) backupBeforeDestructiveMigrations(db, dbPath)
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    /**
     * 每条迁移**各自**一个事务：跑一半的迁移绝不能留下半个 schema。
     * 用 `withTransaction`（而不是裸 BEGIN）是为了让全仓只有一处事务实现 ——
     * 它是审计 §3.4「事务边界不一致」的收敛目标。`immediate: true` 一次拿写锁，
     * 配合上面的 `busy_timeout` 就是排队等，而不是撞上 `SQLITE_BUSY`。
     */
    withTransaction(db, () => {
      migration.up(db)
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version))
    }, { immediate: true })
  }
}

export function openWorkbenchDb(config: WorkbenchDbConfig = {}): DatabaseSync {
  const dbPath = config.dbPath ?? join(config.dataDir ?? dirname(defaultDbPath()), 'workbench.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    /**
     * `busy_timeout` 必须**第一个**设：连 `journal_mode = WAL` 本身都可能因为
     * 另一个连接持有锁而返回 `SQLITE_BUSY`（切 WAL 需要短暂排他锁）。
     */
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, dbPath)
  } catch (error) {
    // 迁移失败必须先把连接关掉：否则句柄泄漏，Windows 上文件被占用，
    // 用户连"删库重来"或备份都做不了（降级路径同样会走到这里）。
    try { db.close() } catch { /* 关不掉也不能掩盖原始错误 */ }
    throw error
  }
  return db
}
