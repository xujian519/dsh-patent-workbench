/**
 * 案卷域 Agent 工具（阶段 5）。
 *
 * ## 目前只有一个：`workbench_link_knowledge_matter`
 *
 * 它做的是**归属**这件事：把一条知识条目归入某个案卷（或移出）。
 *
 * ## 为什么不自动推断归属
 *
 * 会话工作目录能认"我在哪个案卷目录里"（`repo/matters.ts#findMatterIdByWorkspacePath`，
 * 召回用它做"本案卷优先"），但**目录不是归属声明**：一个案子目录里也可能沉淀
 * 与本案无关的通用经验（"这份 PDF 怎么转文本"），自动归入会让案卷知识区越用越脏，
 * 而用户看不出是哪一条被谁偷偷改过。所以：
 *
 * - **写归属** = 显式动作（这个工具，或界面上的「归入案卷」下拉）；
 * - **读排序** = 目录判定（召回候选集的"本案卷优先"）。
 *
 * ## 与 `workbench_submit_knowledge` 的分工
 *
 * 那个是"沉淀新知识"（写内容、要用户确认草稿）；这个是"把已存在的条目标到案卷上"
 * （改一个外键，不改内容）。两者都不互相替代。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { getKnowledge, updateKnowledge } from './db/repo/knowledge.js'
import { getMatter, getMatterByCaseNumber } from './db/repo/matters.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * `workbench_link_knowledge_matter`：把知识条目归入/移出案卷。
 *
 * 用**案号**而不是 `matter_id` 当入参：案号是人（和模型）看得懂、抄得准的那个；
 * uuid 只能从别处复制。两个都给时以 `matter_id` 为准（界面走的就是它）。
 *
 * 失败一律给可读中文原因（案号不存在 / 条目不存在 / 案卷不存在），**绝不静默改 NULL**
 * —— 逐条见各分支的返回。
 */
export function linkKnowledgeMatterTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_link_knowledge_matter',
    description:
      '把一条工作台知识条目**归入某个案卷**（或移出案卷）。这是**归属**动作：只改"这条属于哪个案子"，不改知识内容。'
      + '什么时候用：你刚沉淀了一条与某个案子强相关的经验（答复策略 / 审查尺度 / 检索经验 / 客户偏好…）时，把它归到那个案卷下；'
      + '案卷下的知识在该案子的会话里会被**优先召回**（本任务 > 本案卷 > 全库）。'
      + '需要 `knowledge_id`（知识条目的完整 uuid，从检索结果或界面上抄）与 `case_number`（案号，如 2026-UM-002）。'
      + '要取消归属就传 `unlink: true`（此时不用给案号）。'
      + '只改归属、不改内容，所以**不需要用户确认**；但要点名说清你把哪条归到了哪个案子。',
    parameters: {
      knowledge_id: { type: 'string', required: true, description: '知识条目 id（完整 uuid）' },
      case_number: { type: 'string', description: '案号，如 2026-UM-002（`unlink: true` 时可省略）' },
      matter_id: { type: 'string', description: '案卷 id（uuid）；与 case_number 同时给出时以本项为准' },
      unlink: { type: 'boolean', description: 'true = 取消归属（移出案卷），无需给案号' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>) {
      const knowledgeId = str(args.knowledge_id)
      if (knowledgeId === undefined) return '错误：knowledge_id 必填（知识条目的完整 uuid；可先从检索结果里抄 [id]）'
      const entry = getKnowledge(db, knowledgeId)
      if (entry === undefined) return `错误：没有这条知识条目：${knowledgeId}`
      const label = `知识 [${entry.id}]「${entry.title}」`

      if (args.unlink === true) {
        const previous = entry.matterId
        if (previous === null) return `${label}本来就没有归入任何案卷（无需改动）。`
        const before = getMatter(db, previous)
        updateKnowledge(db, entry.id, { matterId: null })
        return `${label}已移出案卷「${before?.caseNumber ?? previous}」，不再受"本案卷优先"影响（内容与来源一点没变）。`
      }

      const matterId = str(args.matter_id)
      const caseNumber = str(args.case_number)
      if (matterId === undefined && caseNumber === undefined) {
        return '错误：要么给 case_number（案号，如 2026-UM-002），要么给 matter_id；只想取消归属请传 unlink: true。'
      }
      const matter = matterId !== undefined ? getMatter(db, matterId) : getMatterByCaseNumber(db, caseNumber!)
      if (matter === undefined) {
        const wanted = matterId ?? caseNumber
        return `错误：没有这个案卷：${wanted}。可先列案卷确认案号（案号 = matters.case_number，不是申请号/公开号）。`
      }
      if (entry.matterId === matter.id) return `${label}已经归在案卷「${matter.caseNumber}」下（无需改动）。`

      updateKnowledge(db, entry.id, { matterId: matter.id })
      const moved = entry.matterId === null ? '' : '（原先归在别的案卷下，已改归本卷）'
      return `${label}已归入案卷「${matter.caseNumber} · ${matter.title}」${moved}。`
        + '此后在该案卷目录下的会话里，它会被优先召回（本任务 > 本案卷 > 全库）；内容与来源未改动。'
    },
  })
}
