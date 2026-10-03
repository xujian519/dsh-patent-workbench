/**
 * 知识库左栏（H4-4）：工具条 + 列表 + 分页，以及在它们之间共用的两个入口。
 *
 * ## 边界
 *
 * - **传进来的**：条目、字典、算好的当前页（`page`）、筛选状态、选中 id，以及四个入口
 *   （改筛选 / 新建 / 打开某条 / AI 总结本地文档）。
 * - **留在这里的**：只有"怎么排这三块"。**没有一处 `useState`** —— 筛选状态由容器调
 *   `knowledgeView.ts#useKnowledgeView` 持有（切页签卸载不重置，见 H4 plan §3）。
 * - **右栏不在这里**：左栏与右栏是 `.wb-body` 下的**两个兄弟容器**（`.wb-nav` / `.wb-detail`），
 *   一个组件盖不住两块 DOM，所以知识详情的另一半在 `KnowledgeDetailPane.tsx`。
 *
 * ## 判定都不在这里
 *
 * 过滤/排序/分组/分页在 `listPresentation.ts`；分类语义在 `KnowledgeList.tsx#selectedKind`；
 * Tab 拼装在 `kindTabs()`。本组件只把结果画出来 + 转发点击。
 */
import { Icon } from '../Icon.js'
import { KnowledgeList, KnowledgePager, KnowledgeToolbar, kindTabs, type KnowledgeFilters } from '../KnowledgeList.js'
import type { ContentItem, ListPage } from '../../listPresentation.js'
import type { Dict, KnowledgeEntry } from '../../viewTypes.js'

export interface KnowledgeViewProps {
  entries: readonly KnowledgeEntry[]
  /** `knowledge_kind` 字典。 */
  dicts: readonly Dict[]
  /** 算好的当前页（过滤 + 排序 + 分组 + 分页）。 */
  page: ListPage<ContentItem>
  filters: KnowledgeFilters
  /** 选中条目的 id（列表据此高亮）。 */
  selectedId: string | undefined
  busy: boolean
  /** 唯一改筛选入口（容器转给 `useKnowledgeView` 的那个）。 */
  onChange: (patch: Partial<KnowledgeFilters>) => void
  /** 「新建知识」：容器摊开一份空草稿（草稿形状只有容器知道）。 */
  onNew: () => void
  /** 打开某条（传 id；条目由容器在自己的全量列表里查）。 */
  onOpenEntry: (id: string) => void
  /** 「AI 总结本地文档」：打开文件选择弹窗（容器接线）。 */
  onSummarizeDoc: () => void
}

export function KnowledgeView({
  entries, dicts, page, filters, selectedId, busy, onChange, onNew, onOpenEntry, onSummarizeDoc,
}: KnowledgeViewProps): JSX.Element {
  return (
    <>
      {/* 本地文档三件套已收进弹窗（LocalDocModal）；工具栏只留一个按钮，和「新建」「清空筛选」同一行右对齐 */}
      <KnowledgeToolbar
        filters={filters}
        tabs={kindTabs(dicts, page.tabCounts)}
        tagCounts={page.tagCounts}
        total={page.total}
        onChange={onChange}
        onClear={() => onChange({ keyword: '', kinds: ['all'], tags: [], page: 0 })}
        onCreate={onNew}
        onSummarizeDoc={onSummarizeDoc}
        busy={busy}
      />
      {entries.length === 0 ? (
        <div className="wb-empty" style={{ padding: '28px 18px' }}>
          <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="book" size={30} /></div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有知识条目</div>
          <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>沉淀经验教训、决策和可复用片段；也可以在 AI 复盘后一键写入</div>
          <button className="wb-btn primary" onClick={onNew}>新建知识</button>
        </div>
      ) : (
        <>
          <KnowledgeList
            page={page}
            dicts={dicts}
            selectedId={selectedId}
            onOpen={(item) => onOpenEntry(item.id)}
          />
          <KnowledgePager
            page={page}
            pageSize={filters.pageSize}
            onPage={(next) => onChange({ page: next })}
            onPageSize={(size) => onChange({ pageSize: size, page: 0 })}
          />
        </>
      )}
    </>
  )
}
