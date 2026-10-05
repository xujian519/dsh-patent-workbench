/**
 * 案卷目录扫描（「扫描导入」的第一步）：把一个工作根目录树扫成**候选清单**。
 *
 * ## 这一层只做「发现」，不做「认定」
 *
 * 目录名不是台账：实测 `/Users/xujian/工作` 下 986 个目录里只有约 22 个自带申请号。
 * 分档（high / mid / rest）是**排序手段**，不是判定 —— 两条**实测确认**的误判
 * 写进 `test/matterImportScan.test.mjs` 做回归锚点：
 *
 * - `09_临时文件/张怀普申请文件及通知/张怀普2024.9/20260108151427，复审` —— 目录名里的
 *   14 位**时间戳**不是申请号（本模块用严格 12 位边界把它挡在 high 之外）；
 * - `01_专利申请` 是**业务分类目录**（其下直接放了 `_matter-log.md`），仍会进 high ——
 *   这类只能靠人勾选时看路径，规则救不了。
 *
 * 所以三档**全部返回**给界面（rest 只是默认折叠），勾选与字段补全由人来做。
 *
 * ## 只读、不读文件内容
 *
 * 中置信只看**文件名**，不打开任何文件 —— 扫描因此是纯 `readdir`，没有解析攻击面，
 * 也不会误触用户的草稿或大文件。本模块**从不写盘**（测试用 `readdirSync` 前后比对钉住）。
 *
 * ## 目录名只剥「确定是元数据」的三类
 *
 * 序号前缀 / 日期 / 申请号。其余一律保留 —— 试着把「第一次审查意见」也当成后缀剥掉
 * 就是在猜发明名称，猜错比留个待改的长名字更糟。
 */
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** 分档：high = 自带案卷线索，mid = 目下有案卷类文件，rest = 其余（默认折叠）。 */
export type MatterImportTier = 'high' | 'mid' | 'rest'

export interface MatterImportCandidate {
  /** 相对扫描根的路径（`/` 分隔，跨平台一致，给人看）。 */
  relPath: string
  /** 绝对路径，直接作为 `workspacePath` 预填。 */
  path: string
  /** 目录名（末段）。 */
  name: string
  tier: MatterImportTier
  /** 命中的线索，中文、逐条可读（界面直接显示，不翻译）。 */
  evidence: string[]
  /** 预填案号（空串 = 没提取到；界面里必填，未填不允许勾选）。 */
  caseNumber: string
  /** 预填发明名称（剥离元数据后的目录名；剥空了则回退原目录名）。 */
  title: string
  /** 预填申请号（与 caseNumber 同源；提取不到为空串）。 */
  applicationNo: string
  /** 预填案型（按顶层业务目录猜，是**默认值不是判定**，界面可逐条改）。 */
  matterType: string
}

export interface MatterImportScan {
  root: string
  scanned: {
    /** 是否因超限被截断 —— 截断了就必须说出来，静默截断会被读成「就这么多」。 */
    truncated: boolean
    /** 被跳过的符号链接目录（不下钻，防环）。 */
    skippedSymlinks: string[]
  }
  tiers: { high: number; mid: number; rest: number }
  candidates: MatterImportCandidate[]
}

export interface ScanOptions {
  /** 最大深度（相对根的子目录层数），缺省 6。 */
  maxDepth?: number
  /** 最多扫多少个目录（= 候选上限），缺省 20000。 */
  maxDirs?: number
}

/**
 * 缺省最大深度 5。
 *
 * 实测真实案卷最深在**第 4 层**（`01_专利申请/滨州张敏/实用新型/2026-UM-002-兽用中药智能熬制设备`），
 * 而第 6–8 层几乎全是工具产物（某转换工具的 `data/cases/<uuid>/source/…` 树在第 6 层就有
 * 1698 个目录）。深度超限时置 `truncated` 明说，用户看得见「还有更深的没扫」。
 */
export const DEFAULT_SCAN_DEPTH = 5
export const DEFAULT_SCAN_DIRS = 20000

/**
 * 按**目录名**跳过的工具目录。
 *
 * 实测 `/Users/xujian/工作` 下有 156 个 `node_modules` 与 8 个 `__pycache__` ——
 * 它们能凭空贡献几千个候选，把真实案卷淹没。只放**确定与案卷无关**的名字：
 * 用户的 `_工作档案`、`_公共` 这类下划线目录是**真实资产**（`_工作档案` 里就有
 * `_matter-log.md`），不能一刀切。
 */
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__'])

/** 案卷日志固定文件名（与 `api/routes/matters.ts` 的 `MATTER_LOG_FILENAME` 同值）。 */
const MATTER_LOG_FILENAME = '_matter-log.md'

/**
 * 申请号形态：**精确 12 位**（20 开头）+ 可选校验位。
 *
 * 前后都不许再有数字 —— 实测踩过：`20260108151427`（14 位**时间戳**）会被宽松的
 * `20\d{10,}` 当成申请号。加边界后它落回应属的档位。
 *
 * 校验位是 `[0-9X]` 而**不只是数字**：实测用户数据里有 `202611244033.X` 与
 * `202311060998.X` —— 写死 `\d` 会让这几条的申请号落成 null（首次落库时真踩到了）。
 */
const APPLICATION_NO = /(?<!\d)(20\d{10})(?:\.[0-9X])?(?!\d)/
/**
 * 同一个形态的**全局版**，只用于清理目录名。
 *
 * 它比提取版多匹配**校验位后缀**（`202522146475.8` 整段删掉）：只删 12 位主体会
 * 在原地留下一个孤零零的 `.8`，清理结果变成 `8-第一次审查意见-山东中匠`。
 */
const APPLICATION_NO_GLOBAL = new RegExp(APPLICATION_NO.source, 'g')

/**
 * 内部案号前缀：`2026-UM-002-` / `2025-UM-11-`（用户自己的案号体系，见案卷实体记忆）。
 * 只认**开头**且形态严格，避免误伤正常名称里的连字符。
 */
const LEADING_INTERNAL_CASE_NO = /^\d{4}-[A-Z]{2,4}-\d{2,4}\s*[-_ ]?/

/**
 * 中置信线索词：文件名里出现任一即算「这个目录在办专利事务」。
 *
 * `答复` 是实测补的 —— 用户的在办事务大量以「答复」命名（`01_待答复` / `02_已答复` /
 * `三次答复内容`），漏了它会让一大批正在办的事务落到 rest 档。
 */
const DOC_HINTS = ['交底', '说明书', '权利要求', '审查意见', '通知书', '申请文件', '检索报告', '受理', '复审', '无效', '附图', '答复']

/** 前导序号：`01_` / `02-` / `3.`（用户目录里三种写法都有）。 */
const LEADING_ORDINAL = /^\d{1,3}\s*[_\-.、]\s*/
/** 日期 token：`2026.3.11` / `2026-03-11` / `2026年3月11日`（不做无分隔的 `20260311`，那会误伤申请号）。 */
const DATE_TOKEN = /(^|[_\-\s])(20\d{2}[.\-年]\d{1,2}([.\-月]\d{1,2})?日?)(?=$|[_\-\s])/g
/** 清理后残留在两端的元数据分隔符。 */
const EDGE_SEPARATORS = /^[\s_\-.、]+|[\s_\-.、]+$/g

/**
 * 从一段文本里提取申请号（**只取 12 位主体**，不带校验位后缀）。
 *
 * 取主体而不带 `.X` 是有意的：`caseNumber` 是人用来对案子的编号，12 位主体已经唯一；
 * 而 `applicationNo` 也存同一形态，避免同一个号在有/无校验位两种写法下分裂成两条。
 */
export function extractApplicationNo(text: string): string | null {
  const matched = APPLICATION_NO.exec(text)
  return matched === null ? null : matched[1]
}

/**
 * 整串是不是一个申请号（12 位 + 可选校验位）。
 *
 * 与 `extractApplicationNo` 的分工：那个是「从一堆文本里**捞出**号」（返回 12 位主体，
 * 用于案号预填）；这个是「这**整串**本身就是个号吗」—— 落库时用它决定要不要同时写
 * `applicationNo`，且**保留校验位**（申请号的规范写法是 `202520556678.1`，剥掉点号
 * 会让人对不上官方文件）。
 */
export function isApplicationNoShaped(text: string): boolean {
  return new RegExp(`^(?:${APPLICATION_NO.source})$`).test(text)
}

/**
 * 目录名 → 发明名称预填。
 *
 * 只剥三类**确定是元数据**的东西（申请号、日期、序号前缀），其余原样保留。
 * 剥到最后什么都不剩时**回退原目录名** —— `title` 是必填，给个待改的长名字
 * 好过给空串（空串会让整条无法导入，而用户看不出为什么）。
 */
export function cleanTitleFromDirName(dirName: string): string {
  let out = dirName.replace(APPLICATION_NO_GLOBAL, '')
  out = out.replace(LEADING_INTERNAL_CASE_NO, '')
  out = out.replace(DATE_TOKEN, '$1')
  out = out.replace(LEADING_ORDINAL, '')
  out = out.replace(EDGE_SEPARATORS, '')
  return out === '' ? dirName : out
}

/**
 * 分档判定：只看**目录自己的名字**与**该目录自己直接包含的文件名**。
 *
 * ## 为什么不用整条相对路径（实测踩过）
 *
 * 用相对路径判定时，`04_审查意见/02_已答复/202311356097.5/附图/` 会因为祖先目录名里
 * 有申请号而**继承**成 high —— 实测真实目录树里这样多出 55 条候选（78 vs 23），
 * 同一个案子在多个层级各占一条，用户勾选后第二条必撞 `case_number` 的 UNIQUE 约束。
 *
 * 一个案号对应一个目录：认**末段**。案子内部的子目录（`答复/`、`检索/`）不是独立案卷。
 *
 * `fileNames` 必须是**这个目录自己的**（不是父目录的）—— 传错会让所有目录都按
 * 父目录的内容判档。
 */
export function tierOf(dirName: string, fileNames: readonly string[]): { tier: MatterImportTier; evidence: string[] } {
  const evidence: string[] = []
  const applicationNo = extractApplicationNo(dirName)
  if (applicationNo !== null) evidence.push(`目录名含申请号 ${applicationNo}`)
  if (fileNames.includes(MATTER_LOG_FILENAME)) evidence.push(`含 ${MATTER_LOG_FILENAME}`)
  if (evidence.length > 0) return { tier: 'high', evidence }

  const hits = DOC_HINTS.filter((hint) => fileNames.some((name) => name.includes(hint)))
  if (hits.length > 0) return { tier: 'mid', evidence: [`含案卷类文件（${hits.join('、')}）`] }

  return { tier: 'rest', evidence: [] }
}

/**
 * 顶层业务目录 → 案型预填。
 *
 * 用**关键词包含**而不是精确目录名：用户重命名（`04_审查意见` → `04_审查意见答复`）
 * 不该让预填失效。这是**默认值**，界面上每条都能改。
 */
export function guessMatterType(relPath: string): string {
  const top = relPath.split('/')[0] ?? ''
  if (top.includes('复审') || top.includes('无效')) return 'reexamination'
  if (top.includes('审查意见') || top.includes('官文')) return 'oa_response'
  if (top.includes('专利申请')) return 'drafting'
  return 'other'
}

/** 隐藏目录（`.git` / `.nuo` / `.opencode` 之类工具目录）整体跳过：它们不是任何人的案卷。 */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/**
 * 扫描一棵目录树，返回全部候选（三档都在）。
 *
 * 纪律：
 * - **每个目录只读一次**，用它自己的文件名判定它自己（根只作容器，不判定）；
 * - **符号链接目录不下钻**（防环），但要**记名回报** —— 跳过不等于不存在；
 * - 深度/数量超限**截断并置 `truncated`**，不静默；
 * - 读不了的单个目录跳过但**不中断整棵树**（一个坏目录不该毁掉整次扫描）；
 * - 根不存在/不是目录 → 抛错（由端点转成中文 400）。
 *
 * 广度优先：先浅后深，截断时保住最有价值的上层目录。
 */
export async function scanWorkspaceTree(root: string, options: ScanOptions = {}): Promise<MatterImportScan> {
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH
  const maxDirs = options.maxDirs ?? DEFAULT_SCAN_DIRS

  /**
   * 根先单独校验、**当场抛错**：不存在的根如果走下面的 `catch { continue }`，
   * 会安静地返回一份空清单 —— 用户在界面上把路径打错一个字，看到的是
   * 「扫到 0 个案卷」而不是「这个目录不存在」，只会以为自己的案卷都没了。
   * 单个子目录读不了才是「跳过」，根读不了是「你给错了路径」。
   */
  const rootInfo = await stat(root).catch(() => undefined)
  if (rootInfo === undefined) throw new Error(`目录不存在：${root}`)
  if (!rootInfo.isDirectory()) throw new Error(`不是目录：${root}`)

  const candidates: MatterImportCandidate[] = []
  const skippedSymlinks: string[] = []
  let truncated = false

  let frontier: Array<{ path: string; relPath: string; depth: number }> = [{ path: root, relPath: '', depth: 0 }]
  while (frontier.length > 0 && !truncated) {
    const next: typeof frontier = []
    for (const current of frontier) {
      let entries: Dirent[]
      try {
        entries = await readdir(current.path, { withFileTypes: true })
      } catch {
        continue
      }
      const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)

      /** 根是用户选的容器，不当候选。 */
      if (current.relPath !== '') {
        if (candidates.length >= maxDirs) { truncated = true; break }
        const name = current.relPath.slice(current.relPath.lastIndexOf('/') + 1)
        const applicationNo = extractApplicationNo(name)
        const judged = tierOf(name, fileNames)
        candidates.push({
          relPath: current.relPath,
          path: current.path,
          name,
          tier: judged.tier,
          evidence: judged.evidence,
          caseNumber: applicationNo ?? '',
          title: cleanTitleFromDirName(name),
          applicationNo: applicationNo ?? '',
          matterType: guessMatterType(current.relPath),
        })
      }

      for (const entry of entries) {
        if (isHidden(entry.name) || SKIP_DIR_NAMES.has(entry.name)) continue
        /* 符号链接先于 isDirectory 判定：符号链接指向的目录不该下钻（防环）。 */
        if (entry.isSymbolicLink()) {
          skippedSymlinks.push(current.relPath === '' ? entry.name : `${current.relPath}/${entry.name}`)
          continue
        }
        if (!entry.isDirectory()) continue
        if (current.depth >= maxDepth) { truncated = true; continue }
        next.push({
          path: join(current.path, entry.name),
          relPath: current.relPath === '' ? entry.name : `${current.relPath}/${entry.name}`,
          depth: current.depth + 1,
        })
      }
    }
    frontier = next
  }

  return {
    root,
    scanned: { truncated, skippedSymlinks },
    tiers: {
      high: candidates.filter((candidate) => candidate.tier === 'high').length,
      mid: candidates.filter((candidate) => candidate.tier === 'mid').length,
      rest: candidates.filter((candidate) => candidate.tier === 'rest').length,
    },
    candidates,
  }
}
