/**
 * 「扫描导入」的客户端请求形状 —— **纯函数，无 React、无 DOM**（可 `node --test` 直测）。
 *
 * ## 为什么单独一个模块
 *
 * 路由字面量只允许出现在**一处**（这里）：`index.tsx` 里再拼一遍字符串，将来改路径
 * 必漏一处。同一手法在列目录那条路上已有先例（`localDirBrowser.ts#LOCAL_DIR_ROUTE`，
 * 由 `test/workspacePickerWiring.test.mjs` 的源码扫描钉住）。
 *
 * ## 行状态与候选分开
 *
 * 候选是**服务端扫描的事实**（路径、线索、预填值），行状态是**用户在界面上的意图**
 * （勾没勾、字段改成了什么）。两者分开的好处：重新扫描一次不会把用户的编辑搅混，
 * 而「哪些能导入」这个判定也只有一处（`importableItems`）。
 */

/** 服务端前缀（与 `api/matterImportRoute.ts#MATTER_IMPORT_PREFIX` 同值）。 */
export const MATTER_IMPORT_ROUTE = '/api/workbench/matter-import'

/** 扫描根预填值：用户的实际工作目录。可改（界面里是普通输入框）。 */
export const DEFAULT_SCAN_ROOT = '~/工作'

export type MatterImportTier = 'high' | 'mid' | 'rest'

export interface MatterImportCandidate {
  relPath: string
  path: string
  name: string
  tier: MatterImportTier
  evidence: string[]
  caseNumber: string
  title: string
  applicationNo: string
  matterType: string
}

export interface MatterImportScanResult {
  ok: boolean
  root: string
  scanned: { truncated: boolean; skippedSymlinks: string[] }
  tiers: { high: number; mid: number; rest: number }
  candidates: MatterImportCandidate[]
}

export interface MatterImportRow {
  checked: boolean
  caseNumber: string
  title: string
  matterType: string
}

export interface MatterImportCommitResult {
  ok: boolean
  created: number
  failed: Array<{ index: number; caseNumber: string; title: string; reason: string }>
  matters: Array<{ id: string; caseNumber: string; title: string; workspacePath: string | null }>
}

export type MatterImportRows = Record<string, MatterImportRow>

export function matterScanUrl(): string {
  return `${MATTER_IMPORT_ROUTE}/scan`
}

export function matterCommitUrl(): string {
  return `${MATTER_IMPORT_ROUTE}/commit`
}

/**
 * 扫描结果 → 初始行状态。
 *
 * **高置信默认勾选**（它自带申请号或 `_matter-log.md`，是明确线索），中/其余**默认不勾**
 * —— 分档是启发式（业务分类目录也会进高置信），默认全勾等于把「机器猜的」当成
 * 「用户要的」；默认全不勾又让 37 条真线索白扫。折中在这里，且界面顶部会明说
 * 「已预勾选 N 条，请核对」。
 */
export function initialRows(candidates: readonly MatterImportCandidate[]): MatterImportRows {
  const rows: MatterImportRows = {}
  for (const candidate of candidates) {
    rows[candidate.relPath] = {
      checked: candidate.tier === 'high',
      caseNumber: candidate.caseNumber,
      title: candidate.title,
      matterType: candidate.matterType,
    }
  }
  return rows
}

/** 能不能导入：勾选 + 案号与名称都非空（`title` 与 `caseNumber` 在库上都是必填）。 */
export function rowIsImportable(row: MatterImportRow | undefined): boolean {
  return row !== undefined && row.checked && row.caseNumber.trim() !== '' && row.title.trim() !== ''
}

/** 勾选的行 → 提交载荷（只有这一处把行状态翻译成请求体）。 */
export function importableItems(
  candidates: readonly MatterImportCandidate[],
  rows: MatterImportRows,
): Array<{ relPath: string; path: string; caseNumber: string; title: string; matterType: string }> {
  return candidates
    .filter((candidate) => rowIsImportable(rows[candidate.relPath]))
    .map((candidate) => {
      const row = rows[candidate.relPath]
      return {
        relPath: candidate.relPath,
        path: candidate.path,
        caseNumber: row.caseNumber.trim(),
        title: row.title.trim(),
        matterType: row.matterType,
      }
    })
}

export interface MatterImportSummary {
  /** 勾选了多少条。 */
  checked: number
  /** 其中字段齐、能真正落库的。 */
  importable: number
  /** 勾了但缺案号或名称的 —— 界面要说出来，否则用户以为点了「导入 10 条」而实际只进 7 条。 */
  incomplete: number
}

export function selectionSummary(candidates: readonly MatterImportCandidate[], rows: MatterImportRows): MatterImportSummary {
  let checked = 0
  let importable = 0
  for (const candidate of candidates) {
    const row = rows[candidate.relPath]
    if (row?.checked !== true) continue
    checked += 1
    if (rowIsImportable(row)) importable += 1
  }
  return { checked, importable, incomplete: checked - importable }
}

/** 搜索过滤：路径、目录名、案号、名称都可搜（用户找的可能是其中任何一个）。 */
export function matchesQuery(candidate: MatterImportCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return [candidate.relPath, candidate.name, candidate.caseNumber, candidate.title]
    .some((field) => field.toLowerCase().includes(needle))
}
