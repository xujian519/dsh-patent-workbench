/**
 * 内容面敏感信息闸门（T7，2026-10-07 灵枢调研落地）。
 *
 * ## 这道闸是什么
 *
 * `scripts/check-pii.mjs` 是**发布闸门**（扫仓库里有没有不该有的东西），
 * 它管不到**运行时的内容**：AI 把含明文令牌的片段写进草稿 → 用户确认入库 →
 * 导出/发布。`src/shared/contentPolicy.ts` 就是那道运行时的闸，
 * 挂点只有一处（`repo/drafts.ts` 的 `createDraft` / `updateDraft`）。
 *
 * ## 本文件钉四件事
 *
 * 1. **7 条规则各自真的会响**（逐条喂一个该命中的样例）；
 * 2. **误报率**（CP4 要求）—— 13 条**真实业务形态**的合法内容必须全部通过。
 *    语料是照专利工作台的实际内容写的（权利要求、案号、交底书、公式、
 *    讲密钥的说明文字、GitHub 链接…），不是随手编的短串；
 * 3. **落库边界是 fail-closed**：命中即抛，且**一条数据都没落过**
 *    （不是"落了再回滚"）；`updateDraft` 命中时**旧 payload 一字未改**；
 * 4. **两侧不漂移**：`scripts/check-policy-drift.mjs` 的契约（含三种变异）。
 *
 * ## 已知误报（诚实记录，别以为这里是 100% 干净）
 *
 * 第 2 段那 13 条**业务形态**语料当前**全部通过**（0/13）。但闸门不是零误报：
 * **只是提到凭据文件名、并非泄漏**的说明性文字（如"提醒：`.npm_token.txt`
 * 不要提交进仓库"）会被第 7 条「凭据文件名引用」拦下 —— 单独钉在
 * 「已知误报」那个用例里。这是**照抄 `check-pii.mjs` 规则**的必然结果：
 * 那条规则只看"文中出现了这个文件名"，分不出"警告"与"泄漏"。
 * 发布闸门那一侧不痛（有人逐条看），运行时这一侧会硬拦。
 *
 * 处置：**接受并如实记录**，不改规则（用户明确要求"只搬已有规则、不新增、不改写"，
 * 而且改任何一个字都会让 `check-policy-drift.mjs` 红 —— 那是设计如此）。
 * 绕行方式是把话换个说法（"凭据文件不要提交"），不需要新机制。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentPolicyProblem, scanContentPolicy } from '../lib/shared/contentPolicy.js'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createDraft, getDraft, updateDraft } from '../lib/db/repo.js'
import { CREDENTIAL_SUBSET, extractRulePairs, runCheck, splitLiteral } from '../scripts/check-policy-drift.mjs'

/** 每个用例一个临时库；Windows 上必须先关库再删目录，否则 EPERM 会盖掉真正的失败原因。 */
function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-policy-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try {
    seedDictionaries(db)
    fn(db)
  } finally {
    try { db.close() } catch { /* 已经关过就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 库里现在有几条草稿 —— 用来证"拒绝 = 一条都没落过"。 */
const draftCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM task_drafts').get().n

// ─────────────────────────── 1. 七条规则各自真的会响 ───────────────────────────

/**
 * 规则名 → 一个**该被它拦下**的样例。
 *
 * 样例刻意都是通用形态（不含任何真实凭据、不含任何开发者本人的标识）。
 *
 * ⚠️ 样例**必须在运行时拼出来，不能在源码里写成完整字面量**：本文件会被
 * `scripts/check-pii.mjs` 的**面一**（`git ls-files` 全量）扫到，一个完整的
 * `npm_…` / `ghp_…` / `BEGIN … PRIVATE KEY` 字面量会让**发布闸门**当场变红 ——
 * 那是真命中，不是误报，只是命中的是测试夹具。拼出来的字符串在源码文本里
 * 不构成相邻可匹配片段（`npm', '_'` 不是 `npm_`），于是两个闸门都不响。
 * 这一条不是洁癖：本仓 2026-10-01 真的因为源码里的凭据形态字面量被发布闸门拦过。
 */
const seg = (...parts) => parts.join('')
const TRUE_HITS = [
  ['私钥块', seg('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEow…')],
  ['npm token', seg('token: npm', '_', 'a'.repeat(24))],
  ['GitHub token', seg('token: gh', 'p', '_', 'a'.repeat(24))],
  ['OpenAI 风格 key', seg("api_key: 'sk-", 'a'.repeat(24), "'")],
  ['Bearer token 字面量', seg('Authorization: Bearer ', 'a'.repeat(32))],
  ['api_key / secret / password 赋值（合成夹具豁免）', seg("password: '", 'Ab3xY9pQm', "'")],
  ['凭据文件名引用', seg('把令牌放进 .', 'gh_token.txt 再执行脚本')],
]

/** 一整串假令牌：`prefix` + 足够长的随机样字符，用于"内容里带真凭据"的样例。 */
const fakeSecret = (prefix) => seg(prefix, 'a'.repeat(24))

for (const [rule, sample] of TRUE_HITS) {
  test(`真命中：${rule}`, () => {
    const problem = contentPolicyProblem({ text: sample })
    assert.notEqual(problem, null, `「${rule}」的样例没有被拦下 —— 这条规则在运行时闸门里失效了`)
    assert.match(problem, new RegExp(rule.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  })
}

test('命中原文绝不回显（否则闸门自己成了泄漏的搬运工）', () => {
  const secret = fakeSecret('sk-')
  const problem = contentPolicyProblem({ text: `api_key: '${secret}'` })
  assert.notEqual(problem, null)
  assert.ok(!problem.includes(secret), '拒绝原因里出现了凭据原文 —— 它会被写进工具回执/HTTP 响应/任务事件')

  // 命中结构本身也不能带原文：它会被调用方拿去做事件/日志的载荷。
  const hits = scanContentPolicy({ text: `api_key: '${secret}'` })
  assert.ok(hits.length > 0)
  assert.deepEqual(Object.keys(hits[0]).sort(), ['path', 'rule'], '命中对象多了字段 —— 别把命中原文塞进来')
  assert.ok(!JSON.stringify(hits).includes(secret), '命中结构里带上了凭据原文')
})

// ─────────────────────────── 2. 误报率反例（CP4） ───────────────────────────

/**
 * 合法语料的来源：照专利工作台真实会出现的 payload 写。
 * 每一条都是**不该被拦**的东西；任何一条被拦都是误报。
 */
const LEGITIMATE = [
  ['权利要求书正文', '1. 一种用于半导体封装的散热结构，其特征在于，所述散热结构包括基板与设置于所述基板上的至少一个导热柱；所述导热柱的截面为矩形。'],
  ['案号与客户、发明人', '本案申请号 CN202410123456.7，客户为宝宸精密制造有限公司，发明人张伟、李娜。审查意见通知书第 12345 号。'],
  ['技术交底书片段', '本发明涉及一种锂电池隔膜涂布工艺，涂布速度 30 m/min，烘干温度 80℃，涂层厚度 2 μm。'],
  ['数学公式', '根据 $E = mc^2$ 与 $F = \\frac{G m_1 m_2}{r^2}$，可推导出…'],
  ['讲密钥的说明文字', '请到设置面板把 api_key 填进去，不要写进任务描述里。'],
  ['代码片段：空密码', "const config = { password: '' }"],
  ['代码片段：星号占位', "password: '******'"],
  ['代码片段：自述占位符', "api_key: 'your-token-here'"],
  ['GitHub 仓库链接', '参考 https://github.com/xujian519/dsh-patent-workbench 的实现'],
  ['提到 Bearer 的中文句子', '请求头里的 Bearer 字段由宿主注入，插件不接触。'],
  ['提到 BEGIN 的排版说明', '文书正文不要以 BEGIN 或 END 开头。'],
  ['markdown 表格', '| 类型 | 期限 | 依据 |\n|---|---|---|\n| 实审答复 | 4 个月 | 专利法实施细则第 57 条 |'],
  ['中文任务标题与总结', '完成「审查意见答复：对比文件 D1 的公开日核实」，明日跟进客户确认修改方向。'],
]

for (const [label, text] of LEGITIMATE) {
  test(`不误伤：${label}`, () => {
    assert.equal(contentPolicyProblem({ text }), null, `合法内容被拦下了（误报）：${label}`)
  })
}

test('误报率：13 条业务语料全部通过（当前实测 0/13 误报）', () => {
  const hits = LEGITIMATE.filter(([, text]) => contentPolicyProblem({ text }) !== null)
  assert.deepEqual(hits.map(([label]) => label), [], `这 ${hits.length} 条合法语料被误伤`)
})

/**
 * 已知误报，单独钉住它的**当前**行为。
 *
 * 这个用例不是在说"这样对"，而是把"已知会误伤"这件事固定在测试里：
 * 哪天有人把规则改准了，这里会红，改规则的人就会看到上面那段说明、
 * 顺带去改 `scripts/check-pii.mjs`（否则 drift 检查也会红）。
 */
test('已知误报：只是提到凭据文件名的说明文字会被拦（照抄规则的必然结果）', () => {
  const problem = contentPolicyProblem({ text: '提醒：.npm_token.txt 不要提交进仓库。' })
  assert.notEqual(problem, null, '这条如果通过了，说明规则被改准了 —— 请同步 scripts/check-pii.mjs 并更新本文件的说明')
  assert.match(problem, /凭据文件名引用/)
})

// ─────────────────────────── 3. 落库边界 fail-closed ───────────────────────────

test('createDraft：命中即抛，且库里一条草稿都没有', () => {
  withDb((db) => {
    assert.throws(
      () => createDraft(db, {
        kindCode: 'task', sessionId: 'session-ai',
        payload: { title: '正常标题', summary: `api_key: '${fakeSecret('sk-')}'` },
      }),
      /敏感凭据/,
    )
    assert.equal(draftCount(db), 0, '拒绝路径上落了数据 —— 守卫必须是"写之前拦"，不是"写了再回滚"')
  })
})

test('updateDraft：命中即抛，且旧 payload 一字未改', () => {
  withDb((db) => {
    const draft = createDraft(db, { kindCode: 'task', sessionId: 's', payload: { title: '原样' } })
    assert.throws(
      () => updateDraft(db, draft.id, { title: '原样', summary: seg('Bearer ', 'a'.repeat(32)) }),
      /敏感凭据/,
    )
    assert.deepEqual(getDraft(db, draft.id).payload, { title: '原样' })
  })
})

test('扫描递归到嵌套位置（payload.subtasks[0].summary）', () => {
  withDb((db) => {
    assert.throws(
      () => createDraft(db, {
        kindCode: 'subtask_plan', sessionId: 's',
        payload: { subtasks: [{ title: '干净', summary: `令牌是 ${fakeSecret(seg('gh', 'p', '_'))} 形态` }] },
      }),
      /字段 payload\.subtasks\[0\]\.summary/,
    )
    assert.equal(draftCount(db), 0)
  })
})

test('干净内容照常落库（守卫不能顺手把正常路径也堵死）', () => {
  withDb((db) => {
    const draft = createDraft(db, { kindCode: 'task', sessionId: 's', payload: { title: '正常任务' } })
    assert.equal(draftCount(db), 1)
    assert.equal(updateDraft(db, draft.id, { title: '改过的标题' }).payload.title, '改过的标题')
  })
})

test('拒绝原因同时给出规则名与字段路径，且建议的占位符自己过得了闸', () => {
  const problem = contentPolicyProblem({ task: { summary: `api_key: '${fakeSecret('sk-')}'` } })
  assert.notEqual(problem, null)
  assert.match(problem, /OpenAI 风格 key/)
  assert.match(problem, /字段 payload\.task\.summary/)
  /**
   * 自我一致性：消息里推荐的占位符形态**必须自己过得了这道闸**，
   * 否则我们等于把 AI 从一次拒绝引向下一次拒绝。
   */
  assert.equal(contentPolicyProblem({ task: { summary: "api_key: '<placeholder-token>'" } }), null, '消息里推荐的占位符自己过不了闸 —— 那是在把 AI 引向下一次拒绝')

  /**
   * 反面（**钉住一个已知形态，不是在说它合理**）：纯中文占位符**会二次命中**。
   * 第 6 条规则的豁免分支要求值里含 `secret|token|placeholder|example|dummy`
   * 这类**自述词**，而「`<在此填入令牌>`」里一个都没有 —— 所以它照旧被拦。
   * 初版错误消息正是推荐了它，已改成 `'<placeholder-token>'`。这个用例钉住"别改回去"。
   */
  assert.notEqual(contentPolicyProblem({ task: { summary: "api_key: '<在此填入令牌>'" } }), null, '纯中文占位符居然通过了 —— 说明第 6 条规则的豁免分支被放宽了，请同步 check-pii.mjs')
})

// ─────────────────────────── 4. 两闸同口径（防漂移） ───────────────────────────

test('两闸同口径：真实的两份文件当前无漂移', () => {
  const result = runCheck()
  assert.deepEqual(result.problems, [])
  assert.equal(result.exitCode, 0)
})

test('漂移检查能按文本提取出两侧的规则对（`check-pii.mjs` 不用改就能对账）', () => {
  const pairs = extractRulePairs(readFileSync(new URL('../src/shared/contentPolicy.ts', import.meta.url), 'utf8'))
  assert.deepEqual(pairs.map((pair) => pair.name), CREDENTIAL_SUBSET)
})

test('漂移检查：三种变异都能红（改宽 / 私自新增 / 对侧改名）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-drift-'))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    const publishSource = readFileSync(new URL('../scripts/check-pii.mjs', import.meta.url), 'utf8')
    const runtimeSource = readFileSync(new URL('../src/shared/contentPolicy.ts', import.meta.url), 'utf8')
    const write = (rel, text) => writeFileSync(join(root, rel), text)
    const reset = () => { write('scripts/check-pii.mjs', publishSource); write('src/shared/contentPolicy.ts', runtimeSource) }

    // 变异 A：把 src 侧某条正则改宽 → 两侧不等
    reset()
    write('src/shared/contentPolicy.ts', runtimeSource.replace('/Bearer\\s+[A-Za-z0-9_-]{20,}/', '/Bearer\\s+[A-Za-z0-9_-]{8,}/'))
    const a = runCheck({ root })
    assert.equal(a.exitCode, 1)
    assert.ok(a.problems.some((p) => p.includes('两侧不等')), a.problems.join('\n'))

    // 变异 B：src 侧私自新增第 8 条 → 运行时闸门比发布闸门严
    reset()
    write('src/shared/contentPolicy.ts', runtimeSource.replace("  ['凭据文件名引用'", "  ['AWS key', /AKIA[0-9A-Z]{16}/],\n  ['凭据文件名引用'"))
    const b = runCheck({ root })
    assert.equal(b.exitCode, 1)
    assert.ok(b.problems.some((p) => p.includes('AWS key') && p.includes('私自新增')), b.problems.join('\n'))

    // 变异 C：发布闸门那一侧改名 → 子集悄悄缩小
    reset()
    write('scripts/check-pii.mjs', publishSource.replace("['npm token',", "['npm 令牌',"))
    const c = runCheck({ root })
    assert.equal(c.exitCode, 1)
    assert.ok(c.problems.some((p) => p.includes('契约规则「npm token」')), c.problems.join('\n'))

    // 复原后必须回到绿灯（证明上面三次红是变异造成的，不是环境脏）
    reset()
    assert.deepEqual(runCheck({ root }).problems, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('契约名单与两侧文件都在场（名单本身是个可读的清单）', () => {
  assert.equal(CREDENTIAL_SUBSET.length, 7)
  const runtime = extractRulePairs(readFileSync(new URL('../src/shared/contentPolicy.ts', import.meta.url), 'utf8'))
  for (const rule of runtime) {
    assert.ok(CREDENTIAL_SUBSET.includes(rule.name), `运行时闸门里有未声明的规则「${rule.name}」`)
    /**
     * 标志位里不能有 `g`/`y`：这两个会记住 `lastIndex`，同一条内容连着测会"时中时不中"。
     * `i`/`m`/`s`/`u` 无状态、照抄发布闸门，可以有（第 6 条本来就带 `i`）。
     */
    const { flags } = splitLiteral(rule.literal)
    assert.ok(!/[gy]/.test(flags), `「${rule.name}」带了有状态标志位 ${flags} —— 带 g/y 的正则会记住 lastIndex，复用它的扫描会时中时不中`)
  }
})
