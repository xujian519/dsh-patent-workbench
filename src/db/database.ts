/**
 * 打开/迁移工作台 SQLite 数据库。
 * 运行态数据库默认在 ~/.dsh/workbench/workbench.db。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

export interface WorkbenchDbConfig {
  /** 数据目录；缺省 ~/.dsh/workbench */
  dataDir?: string
  /** 数据库文件绝对路径；优先于 dataDir */
  dbPath?: string
}

export function defaultDbPath(): string {
  return join(homedir(), '.dsh', 'workbench', 'workbench.db')
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  return row === undefined ? 0 : Number(row.value)
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
 * ## 三个刻意的判断
 *
 * 1. **只有"将要跑破坏性迁移"才备份**（有一条 `destructive` 的版本号大于当前版本）。
 *    每次开库都拷一份会让 `backups/` 迅速膨胀，也会掩盖真正的回滚点。
 * 2. **先 `wal_checkpoint(TRUNCATE)` 再 copy**：WAL 模式下未 checkpoint 的事务还在
 *    `.db-wal` 里，直接拷 `.db` 会得到一个**缺最近事务**的备份 —— 这正是本仓
 *    `~/.dsh/workbench/backup-case-db.sh` 里那行的原因，同法照抄。
 * 3. **拷不出来就抛**（不吞）：宁可让插件启动失败并说清原因，也不能在没有回滚点的情况下
 *    去删表。全新库（`schema_version` 为 0 或不存在）没有可丢的东西，跳过。
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
  if (!hasMeta) return undefined
  const current = readVersion(db)
  if (current === 0) return undefined
  const pending = MIGRATIONS.filter((migration) => migration.version > current && migration.destructive === true)
  if (pending.length === 0) return undefined
  const target = pending[pending.length - 1].version
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dir = join(dirname(dbPath), 'backups')
  mkdirSync(dir, { recursive: true })
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const file = join(dir, `${basename(dbPath, '.db')}-${stamp}-pre-schema${current}-to-${target}.db`)
  copyFileSync(dbPath, file)
  if (!existsSync(file)) throw new Error(`破坏性迁移前备份失败：${file} 没有生成，已中止迁移（不删表）`)
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

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const current = readVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(current, SCHEMA_VERSION)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export function openWorkbenchDb(config: WorkbenchDbConfig = {}): DatabaseSync {
  const dbPath = config.dbPath ?? join(config.dataDir ?? dirname(defaultDbPath()), 'workbench.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    backupBeforeDestructiveMigrations(db, dbPath)
    migrate(db)
  } catch (error) {
    // 迁移失败必须先把连接关掉：否则句柄泄漏，Windows 上文件被占用，
    // 用户连"删库重来"或备份都做不了（降级路径同样会走到这里）。
    try { db.close() } catch { /* 关不掉也不能掩盖原始错误 */ }
    throw error
  }
  return db
}
