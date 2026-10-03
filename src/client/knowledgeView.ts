/**
 * 知识库的「筛选状态 + 列表派生」（H4-4）：状态由**容器**调用本 hook 持有，
 * 视图只拿到算好的结果与一个改筛选的入口。
 *
 * ## 为什么用 hook 而不是"搬进视图组件"
 *
 * 知识库的 Tab / 排序 / 每页条数是**验收项要求"刷新后保持"**的状态，而且切到别的页签
 * 再切回来也不该重置。视图会随 `{view === 'knowledge' && …}` 卸载，把状态搬进去就会被重置
 * —— 所以照 `calendarView.ts#useCalendarView` 的办法：**state 仍在容器实例里**（hook 是容器调的），
 * 视图只读结果（H4 plan §3 那条规则）。
 *
 * ## 判定都不在这里
 *
 * 列表的过滤/排序/分组/分页全在 `listPresentation.ts#buildListPage`（纯函数，可单测）；
 * 分类语义在 `KnowledgeList.tsx#selectedKind`；分类合法性收口在 `reconcileKnowledgeKinds`。
 * 本模块只做三件事：读回存下来的筛选、把它们喂给判定、把改动的筛选写回去。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_SORT_DIR, buildListPage, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem,
  type ContentItem, type ListPage,
} from './listPresentation.js'
import {
  EMPTY_KNOWLEDGE_FILTERS, reconcileKnowledgeKinds, selectedKind, type KnowledgeFilters,
} from './components/KnowledgeList.js'
import type { Dict, KnowledgeEntry } from './viewTypes.js'

/** 知识库列表状态的本地存储键（Tab 与排序要在刷新后保持，见验收项）。 */
const KNOWLEDGE_FILTER_STORAGE_KEY = 'dsh.patent-workbench.knowledgeList'

/**
 * 读回知识库列表状态。
 *
 * 存储里的值**一律不可信**（分类可能被删、排序键可能改过、JSON 可能被手改）。
 * ⚠️ 分类的合法性**必须拿到字典后才能判**（字典是异步来的），所以这里只做"形状"归一化，
 * 真正"这个分类还在不在"由下面的 effect 用 `reconcileKnowledgeKinds` 收口 —— 否则删过分类的用户
 * 下次打开会看到**空列表且没有任何 Tab 高亮**（v1.15.2 复审 F3）。
 * localStorage 不可用（隐私模式）时静默降级为默认值。
 */
function readKnowledgeFilters(): KnowledgeFilters {
  try {
    const raw = localStorage.getItem(KNOWLEDGE_FILTER_STORAGE_KEY)
    if (raw === null) return EMPTY_KNOWLEDGE_FILTERS
    const saved = JSON.parse(raw) as Record<string, unknown>
    const kinds = Array.isArray(saved.kinds) && saved.kinds.every((k) => typeof k === 'string') && saved.kinds.length > 0
      ? saved.kinds as string[]
      : ['all']
    const tags = Array.isArray(saved.tags) ? saved.tags.filter((t): t is string => typeof t === 'string') : []
    const sortKey = normalizeSortKey(saved.sortKey)
    return {
      keyword: '',
      kinds,
      tags,
      sortKey,
      sortDir: saved.sortDir === undefined ? DEFAULT_SORT_DIR : normalizeSortDir(saved.sortDir),
      page: 0,
      pageSize: normalizePageSize(saved.pageSize),
    }
  } catch {
    return EMPTY_KNOWLEDGE_FILTERS
  }
}

/** 只写"要在刷新后保持"的字段：关键词与页码是瞬时意图，不落盘。 */
function writeKnowledgeFilters(filters: KnowledgeFilters): void {
  try {
    localStorage.setItem(KNOWLEDGE_FILTER_STORAGE_KEY, JSON.stringify({
      kinds: filters.kinds,
      tags: filters.tags,
      sortKey: filters.sortKey,
      sortDir: filters.sortDir,
      pageSize: filters.pageSize,
    }))
  } catch { /* localStorage 不可用时静默降级：状态只在本次会话内有效 */ }
}

/** 知识草稿（容器持有；视图只按补丁改字段）。所有字段都是**字符串**：表单里没有 null。 */
export interface KnowledgeDraft {
  title: string
  contentMd: string
  kindCode: string
  tags: string
  sourceTaskId: string
  sourceReviewId: string
  matterId: string
  fileLink: string
}

/** 发往服务端的知识载荷（空串已归一成 null；`tags` 已切分）。 */
export interface KnowledgePayload {
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceTaskId: string | null
  sourceReviewId: string | null
  matterId: string | null
  fileLink: string | null
}

/**
 * 草稿 → 载荷（**唯一实现**）。
 *
 * 原先这段内联在详情表单的 `onSubmit` 里（`index.tsx` 跑不起来 = 测不到），H4-4 顺手搬进
 * 纯模块：标签按逗号/井号/空白切分、去空、**最多 20 个**，文本 trim，空串归一成 `null`
 * （服务端把 `''` 当"有值"，会把"没填"存成空字符串）。
 */
export function buildKnowledgePayload(draft: KnowledgeDraft): KnowledgePayload {
  const tags = draft.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
  return {
    title: draft.title.trim(),
    contentMd: draft.contentMd,
    kindCode: draft.kindCode,
    tags,
    sourceTaskId: draft.sourceTaskId.trim() === '' ? null : draft.sourceTaskId.trim(),
    sourceReviewId: draft.sourceReviewId.trim() === '' ? null : draft.sourceReviewId.trim(),
    matterId: draft.matterId === '' ? null : draft.matterId,
    fileLink: draft.fileLink.trim() === '' ? null : draft.fileLink.trim(),
  }
}

export interface KnowledgeViewInput {
  knowledgeEntries: readonly KnowledgeEntry[]
  /** `knowledge_kind` 字典（容器用 `dictOf('knowledge_kind')` 取好）。 */
  knowledgeDicts: readonly Dict[]
}

export interface KnowledgeViewState {
  /** 当前筛选（视图直接喂给工具条与列表）。 */
  knowledgeFilters: KnowledgeFilters
  /** 唯一改筛选入口：只改状态，落盘交给本 hook 的 effect。 */
  updateKnowledgeFilters: (patch: Partial<KnowledgeFilters>) => void
  /** 当前页（过滤 + 排序 + 分组 + 分页都算完了）。 */
  knowledgePage: ListPage<ContentItem>
}

export function useKnowledgeView({ knowledgeEntries, knowledgeDicts }: KnowledgeViewInput): KnowledgeViewState {
  const [knowledgeFilters, setKnowledgeFilters] = useState<KnowledgeFilters>(() => readKnowledgeFilters())

  /**
   * 把「条目 + 筛选状态」交给 `listPresentation.ts` 判定，视图只渲染结果。
   * `now` 每次渲染现取：时间分组（今天/本周/…）本来就要跟着现实时间走，
   * 而"判定输入是显式快照"这条约束要求它是显式传进去的，不是在判定模块里读 `Date.now()`。
   */
  const knowledgePage = useMemo(() => buildListPage({
    items: knowledgeEntries.map(toContentItem),
    query: {
      tab: selectedKind(knowledgeFilters),
      keyword: knowledgeFilters.keyword,
      tags: knowledgeFilters.tags,
      sortKey: knowledgeFilters.sortKey,
      sortDir: knowledgeFilters.sortDir,
      page: knowledgeFilters.page,
      pageSize: knowledgeFilters.pageSize,
    },
    now: Date.now(),
    tabOf: (entry) => entry.kindCode,
    tabCodes: knowledgeDicts.map((d) => d.code),
  }), [knowledgeEntries, knowledgeFilters, knowledgeDicts])

  /** 唯一的筛选状态入口：改状态。落盘交给下面的 effect —— **不在 setState 更新函数里写存储**。 */
  const updateKnowledgeFilters = useCallback((patch: Partial<KnowledgeFilters>) => {
    setKnowledgeFilters((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * 持久化：只在筛选状态真的变化时写。
   *
   * 不写在 `setKnowledgeFilters` 的更新函数里是有原因的：那个函数是**渲染期计算**，
   * React 可以重复调用它（并发渲染 / StrictMode 双调用），副作用放进去就会被执行多次。
   * 放 effect 里既幂等也符合"副作用只在 effect 里"这条项目硬约束。
   */
  useEffect(() => {
    writeKnowledgeFilters(knowledgeFilters)
  }, [knowledgeFilters])

  /**
   * 字典到了之后校正一次存下来的分类（删过分类的用户不该看到"空列表 + 无 Tab 高亮"）。
   * 字典是异步来的，所以这件事只能在 effect 里做，不能在读 localStorage 时做。
   */
  useEffect(() => {
    const fixed = reconcileKnowledgeKinds(knowledgeFilters, knowledgeDicts.map((d) => d.code))
    if (fixed !== null) setKnowledgeFilters(fixed)
  }, [knowledgeFilters, knowledgeDicts])

  return { knowledgeFilters, updateKnowledgeFilters, knowledgePage }
}
