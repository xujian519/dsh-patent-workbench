/**
 * 「打开本地文件」白名单的判定测试（A1 修复，2026-10-05）。
 *
 * ## 这条测试要挡的是什么
 *
 * `POST /api/workbench/knowledge/open-file` 是全仓唯一把用户可控路径交给**本机程序**的入口，
 * 而它的入参来自知识条目的 `fileLink`（可由模型知识草稿 / 导入数据写入）。
 * 修复前判据只有 `stat().isFile()`，而 `.command` / `.sh` / `.exe` / `.lnk` **都是普通文件**
 * —— 于是"点开一条知识里的文档链接"等价于"执行本机任意程序"。
 *
 * 这一层只钉**判定**（纯函数，无 IO、无子进程）：哪些扩展名交给默认程序、哪些降级成定位。
 * 路由那一层（真的挑了哪条腿、有没有执行）在 `test/routes.test.mjs` 里用注入的假实现断言。
 *
 * ## 为什么把"并不执行"写成表格
 *
 * 这类安全判定的 bug 几乎总是"**漏了某个形态**"，而不是"逻辑写反了"。
 * 所以这里把要挡的形态逐条列全（含命名陷阱 `报告.md.command` 与无扩展名的 `deploy`），
 * 加白名单时也不必来改测试：只测"是不是文档类"，不测"白名单里有几条"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENABLE_EXTENSIONS, decideOpenMode, fileExtension, isOpenableDocument,
} from '../lib/shared/openableFile.js'

test('A1：文档类扩展名 → 交给默认程序打开', () => {
  const openable = [
    '/tmp/检索笔记.md', '/tmp/报告.pdf', '/tmp/申请文件.docx', '/tmp/台账.xlsx',
    '/tmp/附图.png', '/tmp/附图.TIFF', '/tmp/fig1.svg', '/tmp/清单.csv',
    '/tmp/说明.html', '/tmp/交底书.txt', '/tmp/归档.zip', '/tmp/录音.mp3',
  ]
  for (const path of openable) {
    assert.equal(decideOpenMode(path).mode, 'open', `${path} 应该可以直接打开`)
    assert.equal(isOpenableDocument(path), true)
  }
})

test('A1：会在本机执行东西的扩展名 → 一律降级为"在文件管理器中定位"', () => {
  /**
   * 这些是三个平台上"双击即执行"的形态。黑名单永远追不上平台新花样，
   * 所以判据是**不在白名单里就降级**（fail-closed）—— 这一条就是它的护栏。
   */
  const mustReveal = [
    '/tmp/evil.command', '/tmp/evil.sh', '/tmp/evil.bash', '/tmp/evil.zsh',
    '/tmp/evil.bat', '/tmp/evil.cmd', '/tmp/evil.ps1', '/tmp/evil.exe',
    '/tmp/evil.scr', '/tmp/evil.jar', '/tmp/evil.msi', '/tmp/evil.pkg',
    '/tmp/evil.dmg', '/tmp/evil.lnk', '/tmp/evil.url', '/tmp/evil.workflow',
    '/tmp/evil.terminal', '/tmp/evil.appref-ms', '/tmp/evil.vbs', '/tmp/evil.jse',
    '/tmp/evil.wsf', '/tmp/evil.hta', '/tmp/evil.scf', '/tmp/evil.desktop',
    '/tmp/evil.py', '/tmp/evil.deb', '/tmp/evil.rpm',
  ]
  for (const path of mustReveal) {
    const decision = decideOpenMode(path)
    assert.equal(decision.mode, 'reveal', `${path} 绝不能交给默认程序打开`)
    assert.equal(decision.reason, 'not-openable')
  }
})

test('A1：命名陷阱 —— 只看最后一段扩展名（与三个平台的关联规则一致）', () => {
  // `.md.command` 会被系统当命令执行，必须降级。
  assert.equal(decideOpenMode('/tmp/报告.md.command').mode, 'reveal')
  assert.equal(decideOpenMode('/tmp/报告.pdf.exe').mode, 'reveal')
  // 反过来，末段是文档 = 系统确实按文档打开（纯文本不构成执行）。
  assert.equal(decideOpenMode('/tmp/报告.command.md').mode, 'open')
})

test('A1：无扩展名 / 点文件 / 结尾点 → 降级（`deploy` 这类脚本正是这个形态）', () => {
  for (const path of ['/tmp/deploy', '/tmp/Makefile', '/tmp/.env', '/tmp/report.', '/tmp/..', '/tmp/', '']) {
    const decision = decideOpenMode(path)
    assert.equal(decision.mode, 'reveal', `${JSON.stringify(path)} 应该降级`)
    assert.equal(decision.reason, 'no-extension')
  }
})

test('A1：fileExtension 与 node:path.extname 同口径（点文件不算扩展名）', () => {
  assert.equal(fileExtension('/a/b/c.MD'), 'md')
  assert.equal(fileExtension('D:\\报告\\腿.Inner.DOCX'), 'docx')
  assert.equal(fileExtension('/a/b/.env'), '')
  assert.equal(fileExtension('/a/b/noext'), '')
  assert.equal(fileExtension('/a/b/'), '')
})

test('A1：白名单本身自查 —— 不许混进点、大写或重复项', () => {
  for (const ext of OPENABLE_EXTENSIONS) {
    assert.match(ext, /^[a-z0-9]+$/, `白名单条目 ${JSON.stringify(ext)} 必须是纯小写字母数字（不含点）`)
  }
  assert.equal(new Set(OPENABLE_EXTENSIONS).size, OPENABLE_EXTENSIONS.length, '白名单里有重复条目')
})
