/**
 * H4 收口（2026-10-03）：给「容器不再承载视图」钉上界，防止拆分成果自己涨回来。
 *
 * 为什么需要它：H4 拆的是**行数**，而行数会自己长回来 —— 以后有人把某个视图的 JSX 连着
 * state 一起搬回 `WorkbenchApp`，没有任何测试会红。把上界写成断言之后，"再塞一个视图进来"
 * 就是一次可失败的检查，而不是一次 code review 的运气。
 *
 * ## 口径必须与 plan §1 的命令**逐字一致**
 *
 * ```
 * awk '/^function WorkbenchApp/,/^}/' src/client/index.tsx | grep -oE 'useState[<(]' | wc -l
 * ```
 *
 * 即：本体 = 从 `^function WorkbenchApp` 那行起到**第一个以 `}` 开头**的行（含）；
 * hook 数 = 本体里 `useState[<(]` 的**出现次数**（不是行数）。对不上就会变成两个数各说各话。
 *
 * ## 上界怎么取的
 *
 * 「H4-8 完成时的实测值 + 约 2% 余量」：留余量是为了让**小改动**不必来改测试，
 * 又窄到"再搬一个视图回来"一定超。要放宽上界，得先在 `docs/tasks/h4-split-workbench-app/`
 * 里写清为什么（那是这份预算的唯一账本）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 行数与 `wc -l` 同一口径（结尾那个换行不算一行）。 */
function lineCount(text) {
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** 本体 = `^function WorkbenchApp` 起到第一个 `^}`（含）—— 与 plan §1 的 awk 范围等价。 */
function workbenchAppBody(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('function WorkbenchApp'))
  assert.notEqual(start, -1, 'index.tsx 里找不到 WorkbenchApp')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('}'))
  assert.notEqual(end, -1, 'WorkbenchApp 找不到收尾的 `}`')
  return lines.slice(start, end + 1)
}

const occurrences = (text, pattern) => (text.match(pattern) ?? []).length
const BODY = workbenchAppBody(INDEX).join('\n')

test('H4-9：index.tsx 总行数不超上界（拆分成果不许自己涨回来）', () => {
  const lines = lineCount(INDEX)
  assert.ok(lines <= 4900, `index.tsx 已经 ${lines} 行（上界 4900）—— 有东西回流进容器了`)
  // 反向保护：如果有人把文件**整个搬空**（拆分过头、容器变成空壳），也要来改这个数。
  assert.ok(lines >= 4000, `index.tsx 只剩 ${lines} 行 —— 容器被拆空了？先确认不是误删`)
})

test('H4-9：WorkbenchApp 自己画的 JSX ≤ 650 行，本体 ≤ 3450 行', () => {
  const body = workbenchAppBody(INDEX)
  /**
   * 本体的顶层 `return (`（缩进恰好 2 空格）之后就是它自己画的 JSX。
   * 拆之前这一段约 1408 行；现在只剩外壳 + 顶栏 + 标签页 + 几个内联浮层。
   * 这两条是**两个方向**的预算：JSX 超了 = 视图画法回了容器；本体超了 = 逻辑/状态段膨胀。
   */
  const markers = body.filter((line) => /^ {2}return \($/.test(line))
  assert.equal(markers.length, 1, `WorkbenchApp 本体的顶层 return 应恰好一处，实际 ${markers.length} 处`)
  const jsxLines = body.length - body.findIndex((line) => /^ {2}return \($/.test(line))
  assert.ok(jsxLines <= 650, `WorkbenchApp 自己画的 JSX 已 ${jsxLines} 行（上界 650）—— 视图画法又回容器了`)
  assert.ok(body.length <= 3450, `WorkbenchApp 本体已 ${body.length} 行（上界 3450）`)
})

test('H4-9：WorkbenchApp 内 useState / useMemo / useEffect / useRef 不超上界', () => {
  /**
   * §3 的规则是"只有可以随视图卸载一起丢的 state 才允许搬进视图"，所以 H4 全程
   * **0 个 state 搬走**（105 → 105）。这条断言不是"要求变少"，而是"不许变多"：
   * 容器里 state 变多，通常意味着某个视图的逻辑又回了家。
   */
  const budget = { useState: 105, useMemo: 16, useEffect: 20, useRef: 8 }
  for (const [hook, limit] of Object.entries(budget)) {
    const hit = occurrences(BODY, new RegExp(`${hook}[<(]`, 'g'))
    assert.ok(hit <= limit, `WorkbenchApp 内 ${hook} 已 ${hit} 处（上界 ${limit}）`)
  }
})

test('H4-9：容器自己画的 DOM 只剩外壳（`className=` 上界）', () => {
  /**
   * 粗口径，但正对目标：`className=` 出现在容器里，就意味着"这里有一块视图画法"。
   * 拆完只剩 `wb-app` / `wb-h` / `wb-segmented` / `wb-panel-host` / `ToastHost` 这些外壳。
   */
  const hit = occurrences(BODY, /className=/g)
  assert.ok(hit <= 40, `WorkbenchApp 里还有 ${hit} 处 className=（上界 40）—— 视图画法又回来了`)
})

test('H4-9：拆出去的 16 个视图 / 弹窗仍各由容器挂载**一处**', () => {
  /**
   * 「单函数不再承载 5 个视图的 JSX」的可核实版本：每个视图/弹窗在容器里**恰好**出现一次。
   * 0 处 = 接线断了（视图再也渲染不出来）；2 处 = 同一个视图有两处挂载（重复渲染 / 两条数据来源，
   * 本仓的头号 bug 类别）。确实需要第二个入口时（历史上 `WorkspacePicker` 就有三个），
   * 来这里加数字并写清理由。
   */
  const components = [
    'CalendarView', 'TodayView', 'KnowledgeView', 'KnowledgeDetailPane', 'MatterPane', 'TasksView', 'TaskDetailPane',
    'QuickEntryModal', 'MatterDraftModal', 'NoticeDraftModal', 'ReminderModal', 'DuplicatePromptModal',
    'PromptModal', 'NewTaskModal', 'EditTaskModal', 'PendingModal',
  ]
  for (const name of components) {
    const hit = occurrences(INDEX, new RegExp(`<${name}\\b`, 'g'))
    assert.equal(hit, 1, `容器里 <${name} 出现 ${hit} 次（应为 1 次）`)
    assert.match(INDEX, new RegExp(`import \\{[^}]*\\b${name}\\b`), `${name} 必须从组件目录 import 进来`)
  }
})
