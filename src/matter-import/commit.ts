/**
 * 案卷「扫描导入」的落库层。
 *
 * ## 台账只收索引
 *
 * 写入的是案号、名称、案型、申请号、`workspace_path`，以及一小段 `extra.source`
 * （从哪次扫描来、相对路径、时间）。交底书 / 说明书 / `_matter-log.md` 的正文
 * **不进库**。请求里若带了正文类字段，该条进 `failed`，不会塞进 `extra`。
 *
 * ## 一条失败不拖垮整批，但绝不静默
 *
 * 逐条 `try/catch`，失败的那条**带中文原因**进 `failed`（沿用 `db/repo/drafts.ts`
 * 的契约：「任何一项没写进去，都必须出现在 problems 里」）。
 *
 * ## 整批一个事务
 *
 * 中途崩了不会留下半批数据。单条失败只影响它自己：`createMatter` 是**先校验后 INSERT**，
 * 抛错时一行都没落。
 *
 * ## 案号已在库里 → 更新目录，不另建一条
 *
 * 台账是文件夹索引。同一案号再扫一次，是把 `workspace_path` 刷新成这次扫到的目录
 * （名称等手改过的字段不动）。路径没变则记 `unchanged`，不写库。
 * **同一批里**同一案号出现两次仍进 `failed`：两条不同目录抢一个案号，索引无法替人决定。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMatter, getMatterByCaseNumber, updateMatter } from '../db/repo.js'
import { withTransaction } from '../db/repo/shared.js'
import { isApplicationNoShaped } from './scan.js'

/** 单批最多导入多少条（`readJsonBody` 的上限之外，再挡一道体积→条数的换算）。 */
export const MAX_IMPORT_ITEMS = 1000

export interface MatterImportCommitFailure {
  /** 在本次 items 里的下标（0 起）—— 让用户对得回界面上的那一行。 */
  index: number
  caseNumber: string
  title: string
  /** 中文原因，直接显示（来自 `createMatter` 的校验或仓储层的唯一约束）。 */
  reason: string
}

export interface MatterImportCommitResult {
  created: number
  /** 案号已在库里，且这次的目录和库里的不同：只刷新了 `workspace_path`。 */
  updated: number
  /** 案号已在库里，目录也没变：没写库。 */
  unchanged: number
  failed: MatterImportCommitFailure[]
  matters: Array<{ id: string; caseNumber: string; title: string; workspacePath: string | null }>
}

/**
 * 请求体里这些键表示「把案卷正文一并交上来」。
 * 扫描导入不接收它们：正文留在案卷文件夹，台账只留路径。
 */
const MATTER_BODY_KEYS = ['content', 'contentMd', 'content_md', 'body', 'text', 'fullText', 'documentText'] as const

function rejectMatterBodyFields(record: Record<string, unknown>): void {
  for (const key of MATTER_BODY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      throw new Error(`扫描导入只登记目录索引，不接收案卷正文（字段 ${key}）。正文留在案卷文件夹里。`)
    }
  }
}

/** 比较用：统一分隔符、去掉尾斜杠。大小写保留（Linux 上大小写是不同目录）。 */
function sameWorkspacePath(stored: string | null, incoming: string): boolean {
  if (stored === null) return false
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm(stored) === norm(incoming)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把界面确认过的一批候选写进库。
 *
 * @param rawItems 界面回传的 item 数组；每项至少要有 `caseNumber` 与 `title`，
 *                 其余（`path` / `matterType` / `relPath` / `applicationNo`）可选。
 */
export function commitMatterImport(db: DatabaseSync, rawItems: unknown): MatterImportCommitResult {
  if (!Array.isArray(rawItems)) throw new Error('items 必须是数组')
  if (rawItems.length === 0) throw new Error('没有要导入的案卷（items 为空）')
  if (rawItems.length > MAX_IMPORT_ITEMS) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_ITEMS} 条（本次 ${rawItems.length} 条）：请分批导入`)
  }

  const matters: MatterImportCommitResult['matters'] = []
  const failed: MatterImportCommitFailure[] = []
  const seenCaseNumbers = new Set<string>()
  let created = 0
  let updated = 0
  let unchanged = 0
  const importedAt = new Date().toISOString()

  withTransaction(db, () => {
    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index]
      const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const caseNumber = text(record.caseNumber)
      const title = text(record.title)
      const matterType = text(record.matterType) === '' ? 'other' : text(record.matterType)
      const workspacePath = text(record.path)
      const relPath = text(record.relPath)
      try {
        rejectMatterBodyFields(record)
        if (caseNumber !== '' && seenCaseNumbers.has(caseNumber)) {
          throw new Error(`案号「${caseNumber}」已存在（本批重复）：同一批里两条目录不能共用一个案号`)
        }
        const existing = caseNumber === '' ? undefined : getMatterByCaseNumber(db, caseNumber)
        if (existing !== undefined) {
          if (title === '') throw new Error('发明名称不能为空')
          if (workspacePath === '') {
            throw new Error(`案号「${caseNumber}」已存在，这次没有案卷目录，不能更新索引`)
          }
          if (sameWorkspacePath(existing.workspacePath, workspacePath)) {
            unchanged += 1
          } else {
            /**
             * 只刷新目录指针和扫描痕迹。标题、案型等是人在台账里改过的索引字段，
             * 再扫一次不拿目录名覆盖它们。
             */
            const matter = updateMatter(db, existing.id, {
              workspacePath,
              extra: {
                ...existing.extra,
                source: { kind: 'scan-import', relPath, importedAt },
              },
            })
            updated += 1
            matters.push({ id: matter.id, caseNumber: matter.caseNumber, title: matter.title, workspacePath: matter.workspacePath })
          }
          seenCaseNumbers.add(caseNumber)
          continue
        }
        const matter = createMatter(db, {
          caseNumber,
          title,
          matterType,
          /**
           * `applicationNo` 从案号**反推**，而不是照抄界面回传的字段：用户可能把案号
           * 改成自己的内部编号（如 `2026-UM-002`），那时申请号根本不是案号。
           *
           * **保留校验位**：申请号的规范写法是 `202520556678.1`，用 `extractApplicationNo`
           * （它返回 12 位主体，为的是预填时不被有/无点号两种写法分裂）会把 `.1` 丢掉，
           * 用户拿着去对官方文件就对不上了。
           */
          applicationNo: isApplicationNoShaped(caseNumber) ? caseNumber : null,
          workspacePath: workspacePath === '' ? null : workspacePath,
          extra: {
            source: {
              kind: 'scan-import',
              relPath,
              importedAt,
            },
          },
        })
        created += 1
        if (caseNumber !== '') seenCaseNumbers.add(caseNumber)
        matters.push({ id: matter.id, caseNumber: matter.caseNumber, title: matter.title, workspacePath: matter.workspacePath })
      } catch (error) {
        failed.push({
          index,
          caseNumber,
          title,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, { immediate: true })

  return { created, updated, unchanged, failed, matters }
}
