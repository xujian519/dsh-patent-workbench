/**
 * H4-4 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-knowledge.mjs` 现打包）。
 *
 * ## 这个脚手架比前几个"真"在哪
 *
 * 左栏与右栏的组件都用**真实 props** 渲染，而且容器这一侧用的是**生产代码本身**：
 * - `useKnowledgeView()`（真 hook：筛选 state、列表派生、落盘与对账两个 effect）；
 * - `buildKnowledgePayload()`（真函数：草稿 → 载荷）。
 * 所以"搜/筛/排序/分页 + 表单提交的载荷"这一整条链在浏览器里是**逐字跑生产实现**的，
 * 只有"把意图变成请求"的那几个回调在这里退化成记录（那是容器测试的事）。
 *
 * ## 它模仿 `index.tsx` 的结构
 *
 * 左栏（`.wb-nav` 位）与右栏（`.wb-detail` 位）是两个兄弟容器 —— 与产品里一样，
 * 因为这两个组件本来就盖不住同一块 DOM（见 `KnowledgeDetailPane.tsx` 文件头）。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KnowledgeView } from '../../../src/client/components/views/KnowledgeView.js'
import { KnowledgeDetailPane } from '../../../src/client/components/views/KnowledgeDetailPane.js'
import { buildKnowledgePayload, useKnowledgeView, type KnowledgeDraft } from '../../../src/client/knowledgeView.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { MatterView } from '../../../src/client/components/MattersView.js'
import type { Dict, KnowledgeEntry } from '../../../src/client/viewTypes.js'

function dict(kind: string, code: string, name: string, color: string): Dict {
  return { kind, code, name, config: { color } }
}
const DICTS: Dict[] = [
  dict('knowledge_kind', 'lesson', '经验教训', '#e0645c'),
  dict('knowledge_kind', 'note', '笔记', '#4f8ef7'),
  dict('knowledge_kind', 'decision', '决策', '#8a9aa8'),
]
const knowledgeDicts = DICTS
const dictOf = (kind: string): Dict[] => DICTS.filter((d) => d.kind === kind)

/**
 * 12 条：跨 3 个分类（各 4 条）、够翻页（默认每页 10）、够搜索/标签筛选。
 *
 * ⚠️ 两个刻意的构造，为了让断言可复现：
 * 1. `updatedAt` **全都一样** → 按时间排序时全是并列（JS 排序稳定 = 输入顺序），
 *    而且时间分组只会有一组 —— 于是"排序键换成标题"时行顺序的变化是可预期的；
 * 2. 标题用 **ASCII 字母**（`经验 A`…`经验 L`）而不是中文：中文排序要走 ICU 排序规则，
 *    在断言里写死"先 A 还是先 B"就变成测浏览器实现，而不是测我们的接线。
 */
const LETTERS = ['C', 'A', 'D', 'B', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']
const ENTRIES: KnowledgeEntry[] = LETTERS.map((letter, i) => ({
  id: `k${String(i + 1).padStart(2, '0')}`,
  title: `经验 ${letter}`,
  contentMd: `正文 ${letter} 的要点`,
  kindCode: i % 3 === 0 ? 'lesson' : i % 3 === 1 ? 'note' : 'decision',
  tags: i % 2 === 0 ? ['检索'] : ['答复'],
  sourceTaskId: i === 0 ? 't1' : null,
  sourceSessionId: null,
  sourceReviewId: null,
  matterId: i === 0 ? 'm1' : null,
  fileLink: i === 0 ? 'file:///tmp/检索笔记.md' : null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
}))

const MATTERS: MatterView[] = [{
  id: 'm1', caseNumber: '2026-INV-001', title: '某方法', clientId: null, matterType: 'invention',
  patentKind: null, stageCode: 'drafting', applicationNo: null, publicationNo: null, patentNo: null,
  filingDate: null, priorityDate: null, claimsPriority: 0, isPctNationalPhase: false, ipc: null, techField: null,
}] as unknown as MatterView[]

const calls: Array<{ name: string; args: unknown[] }> = []
const record = (name: string) => (...args: unknown[]): void => { calls.push({ name, args }) }

function Harness(): JSX.Element {
  const [entries, setEntries] = useState<KnowledgeEntry[]>(ENTRIES)
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null)
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  /** 生产 hook：筛选 state + 列表派生 + 落盘/对账两个 effect 全是真的。 */
  const knowledge = useKnowledgeView({ knowledgeEntries: entries, knowledgeDicts })

  const beginNew = (): void => {
    setEditId(null)
    setDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', matterId: '', fileLink: '' })
  }
  const beginEdit = (): void => {
    if (selected === null) return
    setEditId(selected.id)
    setDraft({
      title: selected.title, contentMd: selected.contentMd, kindCode: selected.kindCode, tags: selected.tags.join(', '),
      sourceTaskId: selected.sourceTaskId ?? '', sourceReviewId: selected.sourceReviewId ?? '',
      matterId: selected.matterId ?? '', fileLink: selected.fileLink ?? '',
    })
  }

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      filters: () => knowledge.knowledgeFilters,
      page: () => ({ page: knowledge.knowledgePage.page, total: knowledge.knowledgePage.total, pageCount: knowledge.knowledgePage.pageCount }),
      draft: () => draft,
      editId: () => editId,
      setEntriesEmpty: (empty: boolean) => setEntries(empty ? [] : ENTRIES),
      /** 与产品同一函数：让"表单 → 载荷"这条链在浏览器里跑真实现。 */
      payloadOf: (d: KnowledgeDraft) => buildKnowledgePayload(d),
      storageAvailable: () => {
        try { localStorage.setItem('__h4_probe', '1'); return localStorage.getItem('__h4_probe') === '1' } catch { return false }
      },
    }
  })

  return (
    <div className="wb-body" style={{ display: 'flex', height: '100vh' }}>
      <div className="wb-nav" style={{ width: '58%', overflow: 'auto' }}>
        <KnowledgeView
          entries={entries}
          dicts={knowledgeDicts}
          page={knowledge.knowledgePage}
          filters={knowledge.knowledgeFilters}
          selectedId={selected?.id}
          busy={false}
          onChange={knowledge.updateKnowledgeFilters}
          onNew={beginNew}
          onOpenEntry={(id) => {
            const entry = entries.find((e) => e.id === id)
            if (entry === undefined) return
            calls.push({ name: 'openEntry', args: [id] })
            setDraft(null)
            setEditId(null)
            setSelected(entry)
          }}
          onSummarizeDoc={record('summarizeDoc')}
        />
      </div>
      <div className="wb-detail" style={{ width: '42%', overflow: 'auto' }}>
        <KnowledgeDetailPane
          draft={draft}
          editing={editId !== null}
          selected={selected}
          dictOf={dictOf}
          matters={MATTERS}
          taskTitleOf={(taskId) => taskId === 't1' ? '某案的权利要求改写' : taskId}
          onDraftChange={(patch) => setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))}
          onSubmit={() => {
            if (draft === null) return
            calls.push({ name: 'submit', args: [{ editing: editId !== null, payload: buildKnowledgePayload(draft) }] })
            setDraft(null)
            setEditId(null)
          }}
          onCancel={() => { setDraft(null); setEditId(null) }}
          onEdit={beginEdit}
          onDelete={() => { calls.push({ name: 'delete', args: [selected?.id ?? null] }); setSelected(null) }}
          onOpenFile={record('openFile')}
          onOpenTask={record('openTask')}
        />
      </div>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = WORKBENCH_CSS
document.head.appendChild(style)
const host = document.createElement('div')
host.id = 'root'
document.body.appendChild(host)
createRoot(host).render(<Harness />)
