/**
 * 知识详情（H4-4）：右栏在 `view === 'knowledge'` 时的全部内容 —— 新建/编辑表单、
 * 条目卡（含标签、案卷、本地文件、关联任务、正文），以及"还没选条目"的占位。
 *
 * ## 为什么与左栏分成两个组件
 *
 * 左栏（`.wb-nav`）与右栏（`.wb-detail`）是 `.wb-body` 下的**两个兄弟容器**，
 * 一个组件盖不住两块 DOM —— 硬合成一个就要改布局与样式，而 H4 的非目标写着"样式一行不动"。
 * 于是这一对就是"知识视图"的两半：`KnowledgeView.tsx`（左）+ 本文件（右）。
 *
 * ## 视图只发意图，写动作留在容器
 *
 * 保存 / 删除 / 打开文件 / 打开关联任务都是回调解意图；草稿（`draft`）由容器持有与更新
 * （`onDraftChange(补丁)`），所以表单的 payload 拼装（标签切分、空串归一成 null、POST 还是 PATCH）
 * 全在容器一处完成 —— 视图不认识端点，也不认识"新建"与"编辑"的区别（那是 `editing`）。
 */
import { Icon } from '../Icon.js'
import { Badge } from '../TaskList.js'
import { MarkdownText } from '../MarkdownText.js'
import type { MatterView } from '../MattersView.js'
import { recentTaskOptions, type KnowledgeDraft, type TaskOption } from '../../knowledgeView.js'
import { itemHasLinkedTask, itemHasLocalFile } from '../../listPresentation.js'
import type { Dict, KnowledgeEntry } from '../../viewTypes.js'

export interface KnowledgeDetailPaneProps {
  /** 正在编辑/新建的草稿；非 null 时整个右栏让给表单。 */
  draft: KnowledgeDraft | null
  /** 保存时走 PATCH（true）还是 POST（false）；只用来决定标题文案。 */
  editing: boolean
  selected: KnowledgeEntry | null
  /** 字典码 → 词条（`knowledge_kind` 的徽标与分类下拉都用它）。 */
  dictOf: (kind: string) => Dict[]
  /** 可归入的案卷（下拉选项）。 */
  matters: readonly MatterView[]
  /** 关联任务的显示名（容器查好；查不到时返回 id 本身）。 */
  taskTitleOf: (taskId: string) => string
  onDraftChange: (patch: Partial<KnowledgeDraft>) => void
  onSubmit: () => void
  /** 「取消」：容器丢掉草稿（新建与编辑同一套）。 */
  onCancel: () => void
  /** 「编辑」：容器按当前条目摊一份草稿。 */
  onEdit: () => void
  /** 「删除」（容器负责确认弹窗与善后）。 */
  onDelete: () => void
  onOpenFile: (link: string) => void
  onOpenTask: (taskId: string) => void
  /**
   * 容器里已经有的任务（按更新时间取近期若干条做成下拉）。
   * 不传 = 只有 id 输入框，不做全库搜索。
   */
  recentTasks?: readonly TaskOption[]
}

function KnowledgeRelationStrip({ selected, matters, taskTitleOf, onOpenFile, onOpenTask }: {
  selected: KnowledgeEntry
  matters: readonly MatterView[]
  taskTitleOf: (taskId: string) => string
  onOpenFile: (link: string) => void
  onOpenTask: (taskId: string) => void
}): JSX.Element | null {
  const showMatter = (selected.matterId ?? '') !== ''
  const taskId = itemHasLinkedTask(selected) ? selected.sourceTaskId : null
  const fileLink = itemHasLocalFile(selected) ? selected.fileLink : null
  if (!showMatter && taskId === null && fileLink === null) return null
  const caseNumber = showMatter
    ? (matters.find((matter) => matter.id === selected.matterId)?.caseNumber ?? '（已删除的案卷）')
    : ''
  return (
    <div className="wb-kb-rel" data-kb-rel-strip>
      {showMatter && <span data-kb-rel="matter">案卷：{caseNumber}</span>}
      {taskId !== null && (
        <button type="button" className="wb-btn" data-kb-open-task={taskId} onClick={() => onOpenTask(taskId)}>
          关联任务：{taskTitleOf(taskId)}
        </button>
      )}
      {fileLink !== null && (
        <>
          <span className="wb-file-chip" data-kb-rel="file"><Icon name="file" size={12} /><code>{fileLink}</code></span>
          <button type="button" className="wb-btn" data-kb-open-file onClick={() => onOpenFile(fileLink)}><Icon name="file" />打开文件</button>
        </>
      )}
    </div>
  )
}

export function KnowledgeDetailPane(props: KnowledgeDetailPaneProps): JSX.Element {
  const { draft, editing, selected, dictOf, matters, taskTitleOf, onDraftChange, onSubmit, onCancel, onEdit, onDelete, onOpenFile, onOpenTask, recentTasks = [] } = props

  if (draft !== null) {
    const taskChoices = recentTaskOptions(recentTasks, draft.sourceTaskId)
    const pickedTaskId = taskChoices.some((task) => task.id === draft.sourceTaskId.trim()) ? draft.sourceTaskId.trim() : ''
    return (
      <form className="wb-form" onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}>
        <h4 className="full" style={{ margin: 0 }}>{editing ? '编辑知识条目' : '新建知识条目'}</h4>
        <label className="full">标题<input value={draft.title} onChange={(e) => onDraftChange({ title: e.target.value })} placeholder="可检索的标题" /></label>
        <label>分类<select value={draft.kindCode} onChange={(e) => onDraftChange({ kindCode: e.target.value })}>{dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>标签<input value={draft.tags} onChange={(e) => onDraftChange({ tags: e.target.value })} placeholder="用逗号/空格分隔，如 TTS, 踩坑" /></label>
        {/**
          * 归入案卷（阶段 5）：与「关联任务 id」是**两件事** ——
          * 关联任务是"这条经验是哪次干活沉淀的"（溯源），归入案卷是"它属于哪个案子"（归属）。
          * 归入后，该案卷目录下的会话会优先召回它（本任务 > 本案卷 > 全库）。
          */}
        <label>归入案卷（可选）<select value={draft.matterId} onChange={(e) => onDraftChange({ matterId: e.target.value })}><option value="">（不归入）</option>{matters.map((m) => <option key={m.id} value={m.id}>{m.caseNumber}{m.title === '' ? '' : ` · ${m.title}`}</option>)}</select></label>
        <label className="full">本地文件链接（可选）<input value={draft.fileLink} onChange={(e) => onDraftChange({ fileLink: e.target.value })} placeholder="file:// 或绝对路径，如 D:\docs\方案.md、/mnt/d/docs/方案.md" /></label>
        <label className="full">关联任务 id（可选）
          <input value={draft.sourceTaskId} onChange={(e) => onDraftChange({ sourceTaskId: e.target.value })} placeholder="留空表示不关联" />
          {taskChoices.length > 0 && (
            <select
              data-kb-recent-task
              aria-label="从近期任务填入关联任务 id"
              value={pickedTaskId}
              onChange={(e) => onDraftChange({ sourceTaskId: e.target.value })}
            >
              <option value="">近期任务…</option>
              {taskChoices.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
          )}
        </label>
        <p className="wb-hint full" data-kb-task-help>可选。填写任务 id，保存后可在详情打开。</p>
        <label className="full">正文（Markdown）<textarea rows={12} value={draft.contentMd} onChange={(e) => onDraftChange({ contentMd: e.target.value })} /></label>
        <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={onCancel}>取消</button></div>
      </form>
    )
  }

  if (selected !== null) {
    return (
      <div className="wb-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h4 style={{ flex: 1, margin: 0 }}>{selected.title}</h4>
          <button className="wb-btn" onClick={onEdit}><Icon name="edit" />编辑</button>
          <button className="wb-btn" onClick={onDelete}><Icon name="trash" />删除</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          <Badge dict={dictOf('knowledge_kind')} code={selected.kindCode} />
          {selected.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
        </div>
        {/**
          * 关系条：案卷 / 关联任务 / 本地文件。缺哪段就不画哪段。
          * 案卷仍用 `?? ''`：旧服务端响应里没有 `matterId`（`undefined`）时不能渲染成「已删除」。
          */}
        <KnowledgeRelationStrip
          selected={selected}
          matters={matters}
          taskTitleOf={taskTitleOf}
          onOpenFile={onOpenFile}
          onOpenTask={onOpenTask}
        />
        <MarkdownText text={selected.contentMd} />
      </div>
    )
  }

  return <div className="wb-empty">← 从左侧选择或新建知识条目</div>
}
