/**
 * 案卷「扫描导入」的落库层。
 *
 * ## 一条失败不拖垮整批，但绝不静默
 *
 * 983 个候选里只要有一条案号重复就整批回滚的话，用户会永远导不进来 —— 所以逐条
 * `try/catch`，失败的那条**带中文原因**进 `failed` 一起返回（沿用 `db/repo/drafts.ts`
 * 的契约：「任何一项没建出来，都必须出现在 problems 里」）。
 *
 * ## 整批一个事务
 *
 * 中途崩了不会留下半批数据。单条失败只影响它自己：`createMatter` 是**先校验后 INSERT**，
 * 抛错时一行都没落。
 *
 * ## 幂等靠「案号唯一」
 *
 * 同一批导两次，第二次每一条都会撞 `案号「X」已存在` 进 `failed` 并说明原因 ——
 * 比静默跳过诚实（用户看得见「库里已经有什么」）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createMatter } from '../db/repo.js'
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
  failed: MatterImportCommitFailure[]
  matters: Array<{ id: string; caseNumber: string; title: string; workspacePath: string | null }>
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
  const importedAt = new Date().toISOString()

  withTransaction(db, () => {
    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index]
      const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const caseNumber = text(record.caseNumber)
      const title = text(record.title)
      const matterType = text(record.matterType) === '' ? 'other' : text(record.matterType)
      const workspacePath = text(record.path)
      try {
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
              relPath: text(record.relPath),
              importedAt,
            },
          },
        })
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

  return { created: matters.length, failed, matters }
}
