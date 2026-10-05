/**
 * 宿主路径判据的测试（A3 闸门，2026-10-05）。
 *
 * `isAbsoluteNativePath` 是**唯一**的"这个路径能不能直接拿去 `mkdirSync`"判据，
 * 现在守着三个调用点：`POST /workspaces/ensure`（HTTP 端点）、
 * `/workbench` 命令建任务资料夹、以及将来的任何写盘入口。
 *
 * 之所以要有这张表：这类判据的 bug 几乎总是"某个平台形态漏判"——
 * 漏判 = 静默建到别处（相对路径落 cwd、`~/x` 建出名叫 `~` 的目录、
 * macOS 上 `D:\Code` 建出名叫 `D:\Code` 的单层目录）。所以正反两面都逐形态列全。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsoluteNativePath } from '../lib/shared/hostPath.js'

test('A3：绝对路径的三个平台形态都认', () => {
  const absolute = [
    '/', '/Users/me/DSHWorkspace', '/mnt/d/DSHWorkspace/任务-x',
    'D:\\DSHWorkspace', 'D:/DSHWorkspace', 'C:\\', 'd:\\code\\x',
    '\\\\server\\share\\dir', '//server/share/dir',
    '  /Users/me/有空格 目录/  ', // 前后空白由判据自己 trim
  ]
  for (const path of absolute) {
    assert.equal(isAbsoluteNativePath(path), true, `${JSON.stringify(path)} 应当判为绝对路径`)
  }
})

test('A3：相对路径 / `~` / 裸盘符 —— 一律不认（这些正是会静默建到别处的形态）', () => {
  const notAbsolute = [
    '', '   ',
    'relative/dir', './dir', '../dir', 'dir',
    '~', '~/Documents/x', '~user/x',
    'D:', 'C:',            // 裸盘符是"盘内相对路径"，不是绝对路径
    '\\foo',               // 只有根分隔符：挂在当前盘，语义取决于 cwd
  ]
  for (const path of notAbsolute) {
    assert.equal(isAbsoluteNativePath(path), false, `${JSON.stringify(path)} 绝不能判为绝对路径`)
  }
  // `undefined` / `null` 也不能因为"没报错"而被当成合法路径放过去。
  assert.equal(isAbsoluteNativePath(undefined), false)
  assert.equal(isAbsoluteNativePath(null), false)
})
