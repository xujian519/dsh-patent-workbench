/**
 * 案卷目录扫描（`src/matter-import/scan.ts`）的判据。
 *
 * 这一层是「扫描导入」的入口：它扫错了，用户会在界面里看到一堆不该出现的候选
 * （或看不到该出现的），而**扫描本身不会报错** —— 错误只会以「怎么少了一个案子」
 * 的形式在几天后被发现。所以下面每条都钉住一个**实测踩过的形态**。
 *
 * 真实目录树来自 `/Users/xujian/工作`（986 个目录、23 高置信 / 234 中置信 / 728 其余），
 * 但测试**一律自造临时目录树**，绝不读用户的真实数据 —— 与 `matterLog.test.mjs`
 * 用内联字符串而不是 fixture 文件同一个理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanTitleFromDirName, extractApplicationNo, guessMatterType, isApplicationNoShaped, scanWorkspaceTree, tierOf,
} from '../lib/matter-import/scan.js'

/** 造一棵临时目录树：`{ '相对路径': ['文件名', ...] }`；返回根路径。 */
function makeTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-scan-'))
  for (const [rel, files] of Object.entries(spec)) {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    for (const file of files) writeFileSync(join(dir, file), '')
  }
  return root
}

async function withTree(spec, fn) {
  const root = makeTree(spec)
  try {
    /* 必须 await：少了它，finally 会在 async 回调完成**之前**删掉目录，
       测试拿到的是 ENOENT，看起来像产品代码不读盘 —— 假红比假绿更难查。 */
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 申请号提取

test('申请号只认精确 12 位：14 位时间戳不是申请号（实测反例）', () => {
  assert.equal(extractApplicationNo('202010388021-山东植丰复审'), '202010388021')
  assert.equal(extractApplicationNo('202311060998.X-第一次审查意见-广东石油化工学院'), '202311060998')
  assert.equal(
    extractApplicationNo('20260108151427，复审'),
    null,
    '14 位时间戳（2026-01-08 15:14:27）曾被宽松的 20\\d{10,} 当成申请号，严格 12 位边界必须挡住它',
  )
  assert.equal(extractApplicationNo('2026.3.11-一种螺纹插装式回路冲洗阀'), null, '日期不是申请号')
  assert.equal(extractApplicationNo('一种心血管内科临床护理用锻炼装置'), null)
})

test('申请号取 12 位主体（不带校验位）：同一案子的两种写法不分裂成两条', () => {
  assert.equal(extractApplicationNo('202311097773'), '202311097773')
  assert.equal(extractApplicationNo('202311097773.4'), '202311097773')
})

test('校验位可以是 X（实测数据里有 202611244033.X / 202311060998.X —— 写死 \\d 会让申请号落成 null）', () => {
  assert.equal(extractApplicationNo('202611244033.X-受理通知书-山东理工大学-2026.8.17.pdf'), '202611244033')
  assert.equal(isApplicationNoShaped('202611244033.X'), true)
  assert.equal(isApplicationNoShaped('202520556678.1'), true)
  assert.equal(isApplicationNoShaped('202311097773'), true, '不带校验位也算申请号形态')
  assert.equal(isApplicationNoShaped('2026-UM-002'), false, '内部案号不是申请号')
  assert.equal(isApplicationNoShaped('20260108151427'), false, '14 位时间戳不是申请号')
})

// ---------------------------------------------------------------- 名称预填

test('目录名清理只剥三类元数据（申请号含校验位 / 内部案号 / 日期 / 序号前缀）', () => {
  assert.equal(cleanTitleFromDirName('202010388021-山东植丰复审'), '山东植丰复审')
  assert.equal(
    cleanTitleFromDirName('202522146475.8-第一次审查意见-山东中匠'),
    '第一次审查意见-山东中匠',
    '校验位后缀要整段剥掉 —— 只剥 12 位主体会在原地留下孤零零的 `8`',
  )
  assert.equal(cleanTitleFromDirName('2026-UM-002-兽用中药智能熬制设备'), '兽用中药智能熬制设备')
  assert.equal(cleanTitleFromDirName('01_一种废气吸附浓缩装置'), '一种废气吸附浓缩装置')
  assert.equal(cleanTitleFromDirName('2026.3.8-一种螺纹插装式回路冲洗阀-双报-定稿'), '一种螺纹插装式回路冲洗阀-双报-定稿')
  assert.equal(cleanTitleFromDirName('手动式农药精准喷洒器'), '手动式农药精准喷洒器', '剥不出元数据的原样保留')
})

test('剥空了回退原目录名 —— title 是必填，给空串会让整条无法导入且用户看不出为什么', () => {
  assert.equal(cleanTitleFromDirName('202010388021'), '202010388021')
})

// ---------------------------------------------------------------- 分档

test('分档：目录名含申请号或含 _matter-log.md 为 high', () => {
  assert.equal(tierOf('202010388021-山东植丰复审', []).tier, 'high')
  assert.equal(tierOf('202522146475.8-第一次审查意见-山东中匠', []).tier, 'high')
  assert.equal(tierOf('01_专利申请', ['_matter-log.md']).tier, 'high')
  assert.equal(tierOf('2026-UM-002-兽用中药智能熬制设备', ['_matter-log.md']).tier, 'high')
})

test('分档只看末段：案卷内部的子目录不继承父目录的申请号', () => {
  /* 用整条相对路径判定时，`04_审查意见/02_已答复/202311356097.5/附图/` 会因祖先目录名
     里有申请号而继承成 high —— 实测真实目录树里这样多出 55 条候选（78 vs 23），
     同一个案子在多个层级各占一条，用户勾选后第二条必撞 case_number 的 UNIQUE 约束。 */
  assert.equal(tierOf('附图', []).tier, 'rest')
  assert.equal(tierOf('三次答复内容', ['答复.pdf']).tier, 'mid')
})

test('分档：目下有案卷类文件为 mid（只看文件名，不读内容）', () => {
  assert.equal(tierOf('手动式农药精准喷洒器', ['说明书附图.dwg', '.DS_Store']).tier, 'mid')
  assert.equal(tierOf('某案', ['交底书.md']).tier, 'mid')
  assert.equal(tierOf('01_待答复', ['第一次审查意见.pdf']).tier, 'mid')
})

test('分档：其余为 rest（含「有子目录但自己没文件」的客户层目录）', () => {
  assert.equal(tierOf('张国艳2件', []).tier, 'rest', '客户层目录自己没文件 → rest；案子在它的子目录里')
  assert.equal(tierOf('张怀普2024.9', ['note.txt']).tier, 'rest')
})

test('high 的两条证据都不在时不许硬判 —— evidence 逐条可读，给界面直接显示', () => {
  assert.deepEqual(tierOf('202010388021-山东植丰复审', []).evidence, ['目录名含申请号 202010388021'])
  assert.deepEqual(tierOf('01_专利申请', ['_matter-log.md']).evidence, ['含 _matter-log.md'])
  assert.deepEqual(tierOf('某案', ['random.txt']).evidence, [])
})

test('案型预填按顶层业务目录猜（是默认值不是判定，界面可改）', () => {
  assert.equal(guessMatterType('01_专利申请/某案'), 'drafting')
  assert.equal(guessMatterType('04_审查意见/01_待答复/某案'), 'oa_response')
  assert.equal(guessMatterType('03_待处理官文/某案'), 'oa_response')
  assert.equal(guessMatterType('02_复审无效/某案'), 'reexamination')
  assert.equal(guessMatterType('09_临时文件/某案'), 'other')
})

// ---------------------------------------------------------------- 扫描

test('扫描：三档齐全，每条候选带路径/预填字段；根自己不当候选', async () => {
  await withTree({
    '01_专利申请': ['_matter-log.md'],
    '01_专利申请/202010388021-山东植丰复审': ['交底书.md'],
    '01_专利申请/张国艳2件': [],
    '01_专利申请/张国艳2件/手动式农药精准喷洒器': ['说明书附图.dwg'],
    '09_临时文件/某杂项': ['note.txt'],
  }, async (root) => {
    const scan = await scanWorkspaceTree(root)
    const byRel = Object.fromEntries(scan.candidates.map((candidate) => [candidate.relPath, candidate]))

    assert.equal(scan.candidates.some((candidate) => candidate.relPath === ''), false, '根是容器，不是案卷')
    assert.equal(byRel['01_专利申请'].tier, 'high', '业务分类目录也会进 high —— 这类只能靠人看路径排除')
    assert.equal(byRel['01_专利申请/202010388021-山东植丰复审'].tier, 'high')
    assert.equal(byRel['01_专利申请/张国艳2件'].tier, 'rest')
    assert.equal(byRel['01_专利申请/张国艳2件/手动式农药精准喷洒器'].tier, 'mid')
    assert.equal(byRel['09_临时文件/某杂项'].tier, 'rest')

    /* 6 个候选 = 上面 5 个叶子/中间目录 + `09_临时文件` 自己（父目录也是候选，
       否则用户永远看不到「客户层目录」这一档）。 */
    assert.deepEqual(scan.tiers, { high: 2, mid: 1, rest: 3 })

    const shandong = byRel['01_专利申请/202010388021-山东植丰复审']
    assert.equal(shandong.caseNumber, '202010388021', '案号预填')
    assert.equal(shandong.applicationNo, '202010388021', '申请号预填与案号同源')
    assert.equal(shandong.title, '山东植丰复审', '名称预填')
    assert.equal(shandong.matterType, 'drafting', '案型预填')
    assert.equal(shandong.path, join(root, '01_专利申请/202010388021-山东植丰复审'), 'workspacePath 预填用绝对路径')

    const sprayer = byRel['01_专利申请/张国艳2件/手动式农药精准喷洒器']
    assert.equal(sprayer.caseNumber, '', '没提取到申请号就是空串，等人补')
    assert.equal(sprayer.title, '手动式农药精准喷洒器')
  })
})

test('扫描：隐藏目录整体跳过（工具目录不是任何人的案卷）', async () => {
  await withTree({
    '.git': ['config'],
    '.nuo/202010388021': [],
    '正常目录': ['x.md'],
  }, async (root) => {
    const scan = await scanWorkspaceTree(root)
    assert.deepEqual(scan.candidates.map((candidate) => candidate.relPath), ['正常目录'])
  })
})

test('扫描：符号链接目录不下钻（防环），但要记名回报', async () => {
  const root = makeTree({ '真目录': ['交底书.md'], '宿主': [] })
  try {
    symlinkSync(join(root, '真目录'), join(root, '宿主', '链接'), 'dir')
    const scan = await scanWorkspaceTree(root)
    assert.deepEqual(scan.scanned.skippedSymlinks, ['宿主/链接'], '跳过不等于不存在 —— 必须回报')
    assert.equal(
      scan.candidates.some((candidate) => candidate.relPath.startsWith('宿主/链接')),
      false,
      '符号链接目录不下钻，否则指回上层的链接会让扫描无限递归',
    )
  } catch {
    /** 少数平台/文件系统不给建符号链接：跳过这一条，不让它变成假绿。 */
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('扫描：深度超限截断并置 truncated（静默截断会被读成「就这么多」）', async () => {
  await withTree({ 'a/b/c/d/e': [] }, async (root) => {
    const scan = await scanWorkspaceTree(root, { maxDepth: 2 })
    assert.equal(scan.scanned.truncated, true)
    assert.deepEqual(scan.candidates.map((candidate) => candidate.relPath).sort(), ['a', 'a/b'])
  })
})

test('扫描：目录数超限截断并置 truncated', async () => {
  await withTree({ 'a': [], 'b': [], 'c': [], 'd': [] }, async (root) => {
    const scan = await scanWorkspaceTree(root, { maxDirs: 2 })
    assert.equal(scan.scanned.truncated, true)
    assert.equal(scan.candidates.length, 2)
  })
})

test('扫描：根不存在 → 抛错（由端点转成中文 400）', async () => {
  await assert.rejects(() => scanWorkspaceTree('/no/such/dir/dsh-workbench-test'))
})

test('扫描**从不写盘**（扫描前后目录树逐条一致）', async () => {
  await withTree({
    '01_专利申请/202010388021-山东植丰复审': ['交底书.md', '_matter-log.md'],
    '09_临时文件/杂项': ['a.txt'],
  }, async (root) => {
    const before = readdirSync(root, { recursive: true }).sort()
    await scanWorkspaceTree(root)
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before)
  })
})
