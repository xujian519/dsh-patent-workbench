/**
 * 任务树"一次构建 + 派生视图"（审计 §4.4 / v1.17.0）。
 *
 * 改动前一次渲染把同一棵树建 6 遍：
 * `index.tsx` 里 `visibleTaskTree` 与 `taskTypeTabs` 各建一遍（**入参完全相同**），
 * `dayPanelModel.ts` 里逾期 / 未排期 / 已完成各建一遍（也完全相同，都是 `buildTaskTree(tasks)`），
 * 而 `countTasksByType` 内部还对 9 个类型码 + all 各走一遍整树。
 *
 * 这一份测试钉两件事：
 *
 * 1. **口径不变**：单次遍历版的 `countTasksByType` 与"每个类型码各走一遍"的旧实现
 *    逐字段相等（随机树属性测试 + 口径固定用例）；
 * 2. **不许再建回去**：容器里 `buildTaskTree` / `countTasksByType` 各恰好一处，
 *    `dayPanelModel` 里恰好两处（计划树一份、无顺序树一份），三棵派生树共用同一份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EMPTY_TASK_FILTER, buildTaskTree, countTaskTreeBy, countTasksByType, filterTaskTree, matchesTaskFilter,
} from '../lib/client/taskFilterSort.js'

const INDEX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const DAY_PANEL = readFileSync(new URL('../src/client/dayPanelModel.ts', import.meta.url), 'utf8')

/**
 * 剥注释后再数（`test/reminderWiring.test.mjs` 的同一做法）。
 *
 * 这两份源码的注释里**逐字写着被优化掉的调用形状**（`buildTaskTree(tasks)` 强调"改动前建了三遍"），
 * 不剥就会把"解释"当成"实现" —— 本轮真踩过：容器里数出 2 处、dayPanelModel 数出 3 处，
 * 其中各有一处来自自己的注释。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

const TYPES = ['patent_case', 'code_impl', 'feature_opt', 'personal', 'training']

const task = (id, overrides = {}) => ({
  id,
  parentId: null,
  title: '',
  description: '',
  statusCode: 'todo',
  priorityCode: 'p2',
  typeCode: 'feature_opt',
  dueAt: null,
  completedAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

/** 旧实现（改动前逐字）：每个类型码各走一遍整树。保留在这里做等价性对照。 */
function legacyCountsByType(roots, filter, typeCodes) {
  const withoutType = { ...filter, typeCodes: [] }
  const byType = {}
  for (const code of typeCodes) {
    byType[code] = countTaskTreeBy(roots, (t) => matchesTaskFilter(t, withoutType) && t.typeCode === code)
  }
  return { byType, all: countTaskTreeBy(roots, (t) => matchesTaskFilter(t, withoutType)) }
}

/** 确定性伪随机（不用 Math.random，失败可复现）。 */
function makeRandom(seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function randomTasks(random, count) {
  const ids = []
  const tasks = []
  for (let i = 0; i < count; i += 1) {
    const id = `t${i}`
    // 三成概率挂到前面某个任务下（形成多层树），其余为根
    const parent = i > 0 && random() < 0.3 ? ids[Math.floor(random() * ids.length)] : null
    tasks.push(task(id, {
      parentId: parent,
      title: random() < 0.4 ? `含关键词-${i % 3}` : `普通-${i}`,
      description: random() < 0.3 ? '描述里也有关键词' : '',
      statusCode: random() < 0.3 ? 'doing' : random() < 0.2 ? 'done' : 'todo',
      priorityCode: random() < 0.3 ? 'p1' : 'p2',
      typeCode: TYPES[Math.floor(random() * TYPES.length)],
      createdAt: `2024-01-0${1 + (i % 9)}T00:00:00.000Z`,
    }))
    ids.push(id)
  }
  return tasks
}

test('countTasksByType：与"每个类型码各走一遍"的旧实现逐字段相等（200 组随机树）', () => {
  const random = makeRandom(20261005)
  for (let round = 0; round < 200; round += 1) {
    const tasks = randomTasks(random, 1 + Math.floor(random() * 40))
    const tree = buildTaskTree(tasks)
    const filter = {
      ...EMPTY_TASK_FILTER,
      keyword: random() < 0.5 ? '关键词' : '',
      statusCodes: random() < 0.4 ? ['todo', 'doing'] : [],
      priorityCodes: random() < 0.3 ? ['p1'] : [],
      // ⚠️ typeCodes 故意非空：口径要求"排除类型维度自身"
      typeCodes: random() < 0.6 ? [TYPES[Math.floor(random() * TYPES.length)]] : [],
    }
    const codes = TYPES.slice(0, 1 + Math.floor(random() * TYPES.length))
    assert.deepEqual(
      countTasksByType(tree, filter, codes),
      legacyCountsByType(tree, filter, codes),
      `第 ${round} 轮不等价（filter=${JSON.stringify(filter)} codes=${codes.join(',')}）`,
    )
  }
})

test('countTasksByType 口径：排除类型维度自身、按行计数（含子任务）、未命中的码留 0', () => {
  const parent = task('p', { title: '父', typeCode: 'patent_case' })
  const child = task('c', { parentId: 'p', title: '子', typeCode: 'code_impl' })
  const other = task('o', { title: '另一个根', typeCode: 'code_impl' })
  const outside = task('x', { title: '不在 codes 里的类型', typeCode: 'zzz_unknown' })
  const tree = buildTaskTree([parent, child, other, outside])

  const withTypeFilter = { ...EMPTY_TASK_FILTER, typeCodes: ['code_impl'] }
  const counts = countTasksByType(tree, withTypeFilter, ['patent_case', 'code_impl'])
  // 类型筛选只影响列表，不影响徽标：两个码都照常计数
  assert.deepEqual(counts, { byType: { patent_case: 1, code_impl: 2 }, all: 4 })
  // 未命中（且不在 codes 里）的类型不单独成桶，但**计入 all**
  assert.equal(counts.byType.zzz_unknown, undefined)
  assert.equal(counts.all, 4, 'all 是"切到全部能看到几条" = 每一行都算，含 child 与 outside')

  const zeroed = countTasksByType(tree, EMPTY_TASK_FILTER, ['training', 'personal'])
  assert.deepEqual(zeroed, { byType: { training: 0, personal: 0 }, all: 4 }, '没命中的码必须是 0 而不是缺 key')
})

test('countTasksByType 口径：父链上下文节点不计入（与 countTaskTreeBy 同一口径）', () => {
  const parent = task('p', { title: '父' })
  const hit = task('c', { parentId: 'p', title: '含关键词 子' })
  const tree = buildTaskTree([parent, hit])
  const filter = { ...EMPTY_TASK_FILTER, keyword: '关键词' }
  assert.equal(countTaskTreeBy(tree, (t) => matchesTaskFilter(t, filter)), 1, '只有命中的那一条算')
  assert.equal(countTasksByType(tree, filter, [parent.typeCode, hit.typeCode]).all, 1)
})

test('countTaskTreeBy 语义未被单次遍历改造改变（父链不计入、子任务计入）', () => {
  const grand = task('g')
  const parent = task('p', { parentId: 'g' })
  const child = task('c', { parentId: 'p' })
  const tree = buildTaskTree([grand, parent, child])
  assert.equal(countTaskTreeBy(tree, () => true), 3)
  assert.equal(countTaskTreeBy(tree, (t) => t.id === 'c'), 1)
  assert.equal(countTaskTreeBy([], () => true), 0)
})

test('接线：容器里 buildTaskTree / countTasksByType 各恰好一处（不许各建各的）', () => {
  const lines = INDEX.split('\n')
  const start = lines.findIndex((line) => line.startsWith('function WorkbenchApp'))
  assert.notEqual(start, -1)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('}'))
  const body = stripComments(lines.slice(start, end + 1).join('\n'))
  assert.equal((body.match(/buildTaskTree\(/g) ?? []).length, 1, 'WorkbenchApp 里只许建一次树（列表树与类型徽标共用）')
  assert.equal((body.match(/countTasksByType\(/g) ?? []).length, 1)
})

test('接线：dayPanelModel 只建两棵树，三棵派生树共用同一份无顺序树', () => {
  const code = stripComments(DAY_PANEL)
  assert.equal((code.match(/buildTaskTree\(/g) ?? []).length, 2, '一份带 planOrder 的计划树 + 一份无顺序树')
  assert.match(code, /const plainTree = useMemo\(\(\) => buildTaskTree\(tasks\), \[tasks\]\)/)
  assert.equal((code.match(/filterTaskTree\(plainTree,/g) ?? []).length, 3, '逾期 / 未排期 / 已完成三棵派生树共用 plainTree')
})
