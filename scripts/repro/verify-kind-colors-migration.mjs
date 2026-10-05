/**
 * 迁移 16 的颜色回填在**真实库副本**上的验证（绝不碰线上库；迁移 16 本身是冻结的历史迁移，这里顺带把后续迁移一起跑完，确认版本能推进到最新）。
 *
 * 断言：知识库类型被回填颜色、已有颜色不被动、字段不被覆盖、其他字典不受影响、
 * 版本号推进到最新、重复跑幂等。
 *
 * 用法：node scripts/repro/verify-kind-colors-migration.mjs
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, snapshotDatabase } from '../../lib/db/database.js'
import { SCHEMA_VERSION } from '../../lib/db/schema.js'

// ⚠️ 原来只认 USERPROFILE（Windows）——在 macOS 上它会变成相对路径，于是脚本**永远 SKIP**。
// 同目录其他 repro 脚本的写法是 `USERPROFILE ?? HOME`，这里对齐。
const LIVE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(LIVE)) { console.error('SKIP: 找不到线上库 ' + LIVE); process.exit(2) }

const work = join(tmpdir(), 'wb-migration-check')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const copy = join(work, 'workbench-copy.db')
// 用一致快照当副本：原来只拷主文件（同目录其他脚本都会连 -wal/-shm 一起拷），
// 在 WAL 未截断时副本会缺最近事务、甚至打不开——而这是个**迁移**验证脚本。
const source = new DatabaseSync(LIVE, { readOnly: true })
snapshotDatabase(source, copy)
source.close()

const db = new DatabaseSync(copy)

const readKind = (kind) => db.prepare('SELECT code, config FROM dictionaries WHERE kind = ? ORDER BY sort_order').all(kind)
const version = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

const before = version()
/**
 * ⚠️ **前提已过期时的响亮跳过**（2026-10-05 实测暴露）。
 *
 * 本脚本的判据建立在"副本停在 v15，`migrate()` 会把迁移 16 再跑一遍"之上。
 * 而线上库现在已经在 18/23 了 —— 迁移 16 是**冻结的历史迁移**，不会再跑，
 * 于是脚本种下的"脏 config / 用户自配色"根本没有机会被迁移处理：
 * 下面第 71 行的 `JSON.parse(r.config)` 会直接对 `not-json` 抛 SyntaxError。
 *
 * 换句话说：这个脚本只有"活库 < 16"时才成立。与其抛一个看不懂的栈，
 * 不如说清"我为什么验不了"（同 `SKIP: 找不到线上库` 的约定，退出码 2）。
 */
if (before >= 16) {
  console.error(
    `SKIP: 线上库已经是 v${before}（>= 16），迁移 16 不会重跑，本脚本的判据不成立。\n`
    + '  要验迁移 16，应当**自建一个 v15 夹具**（按 `test/progressDb.test.mjs` 的 `openLegacyDb(15)` 口径），\n'
    + '  而不是指望线上库还停在 15。这是已知的过期脚本，见 docs/issues/2026-10-05-深度审计.md §7。',
  )
  process.exit(2)
}
console.log(`副本版本：${before} → 目标 ${SCHEMA_VERSION}\n`)
console.log('迁移前 knowledge_kind：', JSON.stringify(readKind('knowledge_kind')))
console.log('')

// 造两个"用户已经自己配过"的场景，验证不会被覆盖
db.prepare("UPDATE dictionaries SET config = ? WHERE kind = 'knowledge_kind' AND code = 'note'").run(JSON.stringify({ color: '#123456', 自定义: '保留我' }))
// 造一个"停用 + 改过名"的行，颜色仍应被补上
db.prepare("UPDATE dictionaries SET active = 0, name = '我改过的名字' WHERE kind = 'knowledge_kind' AND code = 'decision'").run()
// 造一行脏 config（不是合法 JSON）——不该把迁移搞崩
db.prepare("UPDATE dictionaries SET config = 'not-json' WHERE kind = 'knowledge_kind' AND code = 'snippet'").run()

migrate(db, copy)

const after = version()
check('版本推进到最新', after === SCHEMA_VERSION, `${before} → ${after}（目标 ${SCHEMA_VERSION}）`)

const knowledge = Object.fromEntries(readKind('knowledge_kind').map((r) => {
  // 脏 config 是**脚本自己种下的场景**（见上）：解析不了就如实标成 null 交给断言去判，
  // 而不是让脚本自己在 JSON.parse 上崩掉 —— 那会把"被测行为不符合预期"伪装成"脚本坏了"。
  try { return [r.code, JSON.parse(r.config)] } catch { return [r.code, { __unparsable: r.config }] }
}))

/**
 * ⚠️ 阶段 5 把知识库出厂分类从 4 类扩到 10 类（决策 5.2.2），所以这里**不能写死 4 个 code** ——
 * 判据是"**每一条出厂分类都带颜色**"（缺色会让 Tab 圆点与徽标统一落灰，
 * 迁移 16 修过一次的同一类问题）。改法：按数据自身遍历，而不是列举。
 */
const colorless = Object.entries(knowledge).filter(([, v]) => typeof v.color !== 'string' || !v.color.startsWith('#')).map(([code]) => code)
check('知识库类型全部有颜色', Object.keys(knowledge).length >= 4 && colorless.length === 0, `共 ${Object.keys(knowledge).length} 类，缺色：${JSON.stringify(colorless)}`)
check('用户自己配过的颜色**不被覆盖**', knowledge.note.color === '#123456', `note=${knowledge.note.color}`)
check('用户在同一 config 里的其他字段被保留', knowledge.note['自定义'] === '保留我', JSON.stringify(knowledge.note))
check('停用/改名的行也补上颜色', knowledge.decision.color === '#8B7BE8', JSON.stringify(knowledge.decision))
check('脏 config（非法 JSON）不崩，且补上颜色', typeof knowledge.snippet.color === 'string', JSON.stringify(knowledge.snippet))
check('补的颜色互不相同（能区分类型）', new Set(['note', 'lesson', 'decision', 'snippet'].map((c) => knowledge[c].color)).size === 4, JSON.stringify(['note', 'lesson', 'decision', 'snippet'].map((c) => knowledge[c].color)))

// 其他字典不该被动到
const typeColors = db.prepare("SELECT code, config FROM dictionaries WHERE kind = 'type'").all().map((r) => JSON.parse(r.config).color)
check('任务类型字典未受影响', typeColors.every((c) => typeof c === 'string'), JSON.stringify(typeColors))

// 幂等：再跑一次不应改变任何东西
const snapshot = JSON.stringify(db.prepare('SELECT kind, code, config FROM dictionaries ORDER BY kind, code').all())
migrate(db, copy)
check('重复跑幂等（再跑一次内容不变）', JSON.stringify(db.prepare('SELECT kind, code, config FROM dictionaries ORDER BY kind, code').all()) === snapshot)

db.close()
rmSync(work, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`迁移 16 颜色回填验证（真实库副本）：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
