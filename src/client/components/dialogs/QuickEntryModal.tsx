/**
 * 快速录入弹窗（H4-7）：一句话输入 + 附件轨 + 工作区 / 技能 / 角色 / 模型四组选择 + 底部两个动作。
 *
 * ## 边界（plan §3）
 *
 * - **传进来的**：筛不掉的当前值，以及"要不要显示某个出口"的**判定结果**
 *   （工作区来源文案 / 「不再记住」是否可见）。**没有一处 `useState`** —— 输入 / 工作区 /
 *   附件 / 技能 / 角色 / 模型全都住在容器，各有理由：
 *   · 工作区预填由 `openQuickEntry` 一次性判定，而它有**行为级测试**逐字抽出来跑
 *     （`quickIntakeDefaultWiring.test.mjs`），搬走就没法测；
 *   · 附件刻意**跨开关保留**（容器不在打开时清空它），搬进来会在关闭时凭空多一次清空；
 *   · 模型选择与共享提示词弹窗**共用同一份 state**（`promptModelSelection`），
 *     搬进来就会变成"这个入口选完、那个入口还是旧的"。
 *   所以一个 state 都不搬。
 * - **留在这里的**：只有"怎么画这一块"。唯一自有的是隐藏文件输入的 `ref`（纯 UI 接线，
 *   容器一次都没读过它）。
 * - **不发请求**：附件解析上传、目录浏览、技能目录、模型目录都只是回调解意图。
 *
 * ## 判定不在这里
 *
 * 「不收的文件为什么被拒」在 `partitionQuickFiles`；工作区默认值与来源在
 * `quickWorkspaceDefault.ts`；角色是否沿用会话在 `personaPicker.ts`；模型能不能收图在
 * `modelCapability.ts`。这里只把判定结果画出来。
 */
import { useRef } from 'react'
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import { ModelPicker } from '../ModelPicker.js'
import { PersonaPicker } from '../PersonaPicker.js'
import { SkillPicker } from '../SkillPicker.js'
import { WorkspacePicker } from '../WorkspacePicker.js'
import {
  isQuickImageDraft, MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES, type QuickAttachmentDraft,
} from '../../quickAttachments.js'
import type { SkillSummary } from '../../../shared/contracts.js'
import type { PersonaSelection } from '../../personaPicker.js'
import type { WorkspaceCandidate } from '../../workspacePicker.js'
import type { QuickModelSelection, WorkbenchRuntime } from '../../viewTypes.js'

export interface QuickEntryModalProps {
  // ---- 一句话 + 附件 ----
  text: string
  onText: (text: string) => void
  attachments: readonly QuickAttachmentDraft[]
  /** 最后一条"为什么不收 / 为什么失败"的中文原因；`null` = 没有要说的。 */
  attachmentNotice: string | null
  /** 粘贴 / 拖入 / 文件选择三条入口都走这里。 */
  onAddFiles: (files: readonly File[]) => void
  onRemoveAttachment: (id: string) => void
  // ---- 工作区 ----
  workspace: string
  workspaceTouched: boolean
  /** 来源文案（"上次手动选择 / 系统默认 / 未设置"），由判定给出。 */
  workspaceSourceLabel: string
  workspaceCandidates: readonly WorkspaceCandidate[]
  /** 未设置默认工作区时的占位提示。 */
  workspacePlaceholder: string
  /** 是否显示「不再记住」出口（判定给出：上次手动选择且用户没动过）。 */
  showForget: boolean
  onWorkspaceChange: (path: string) => void
  onBrowse: () => void
  onForget: () => void
  followFolder: boolean
  onFollowFolder: (next: boolean) => void
  // ---- 技能 ----
  skillCatalog: readonly SkillSummary[]
  skillsLoading: boolean
  skillsAvailable: boolean
  skillProblem: string
  selectedSkills: readonly string[]
  onToggleSkill: (name: string) => void
  onRetrySkills: () => void
  // ---- 角色 ----
  persona: PersonaSelection
  onPersonaChange: (next: PersonaSelection) => void
  // ---- 模型 ----
  runtime: WorkbenchRuntime
  modelSelection: QuickModelSelection | null
  onModelChange: (selection: QuickModelSelection | null) => void
  modelModalityTable: ReadonlyMap<string, readonly string[] | null>
  onModelLoaded: () => void
  // ---- 底部动作与共用出口 ----
  busy: boolean
  /** 三个选择器读列表 / 目录失败时的可读中文原因（父级负责显示，不静默）。 */
  onError: (message: string) => void
  onNotice: (message: string) => void
  /** ESC / 遮罩 / 标题栏 ×：**不**动附件（与「取消」按钮的区别保留）。 */
  onClose: () => void
  /** 「取消」：清掉附件再关闭。 */
  onCancel: () => void
  /** 「创建澄清会话」：记工作区 + 起澄清会话。 */
  onSubmit: () => void
}

export function QuickEntryModal({
  text, onText, attachments, attachmentNotice, onAddFiles, onRemoveAttachment,
  workspace, workspaceTouched, workspaceSourceLabel, workspaceCandidates, workspacePlaceholder,
  showForget, onWorkspaceChange, onBrowse, onForget, followFolder, onFollowFolder,
  skillCatalog, skillsLoading, skillsAvailable, skillProblem, selectedSkills, onToggleSkill, onRetrySkills,
  persona, onPersonaChange,
  runtime, modelSelection, onModelChange, modelModalityTable, onModelLoaded,
  busy, onError, onNotice, onClose, onCancel, onSubmit,
}: QuickEntryModalProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  return (
    <Modal
      title={<><Icon name="sparkles" />快速录入</>}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">会跳转到官方会话区，由 AI 澄清后生成任务草稿</span>
          <button className="wb-btn" onClick={onCancel}>取消</button>
          <button
            className="wb-btn primary"
            disabled={busy || (text.trim() === '' && attachments.length === 0)}
            onClick={onSubmit}
          >
            创建澄清会话
          </button>
        </>
      )}
    >
      <label className="wb-field">
        <span>一句话描述任务</span>
        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length > 0) {
              e.preventDefault()
              onAddFiles(files)
            }
          }}
          placeholder="一句话描述任务，例如：周五 10:30 接待重要客户；也可以粘贴或拖入图片、PDF、DOCX"
        />
      </label>

      {/* ---------------- 附件（v1.15.1） ----------------
          拖入 / 粘贴 / 选择三种入口都走 onAddFiles；
          不收的文件会在下面用 `wb-quick-attach-note` 给出**逐条中文原因**（不静默丢弃）。 */}
      <div
        className="wb-field"
        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault() }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files)
          if (files.length === 0) return
          e.preventDefault()
          onAddFiles(files)
        }}
      >
        <span>
          附件
          <span className="wb-field-note">
            图片最多 {MAX_QUICK_IMAGES} 张 · PDF/DOCX 最多 {MAX_QUICK_DOCUMENTS} 份 · 单份 ≤ 5MB
          </span>
        </span>
        {attachments.length > 0 && (
          <div className="wb-quick-attach-rail" aria-label="快速录入附件">
            {attachments.map((item) => (
              <div className="wb-quick-attach-item" key={item.id} title={isQuickImageDraft(item) ? (item.file.name || '图片') : item.name}>
                {isQuickImageDraft(item)
                  ? <img src={item.previewUrl} alt={item.file.name || '图片'} />
                  : <Icon name="file" size={18} />}
                <span className="wb-quick-attach-name">
                  {isQuickImageDraft(item) ? (item.file.name || '图片') : `${item.name}${item.truncated ? '（已截断）' : ''}`}
                </span>
                <button type="button" className="wb-quick-attach-remove" onClick={() => onRemoveAttachment(item.id)} aria-label="移除附件">×</button>
              </div>
            ))}
          </div>
        )}
        {attachmentNotice !== null && <div className="wb-quick-attach-note">{attachmentNotice}</div>}
        <div className="wb-quick-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files !== null) onAddFiles(Array.from(e.currentTarget.files))
              e.currentTarget.value = ''
            }}
          />
          <button type="button" className="wb-btn" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <Icon name="image" />添加附件
          </button>
          <ModelPicker
            runtime={runtime}
            value={modelSelection}
            onChange={onModelChange}
            modalityTable={modelModalityTable}
            disabled={busy}
            onError={onError}
            onLoaded={onModelLoaded}
          />
        </div>
      </div>

      {/* ---------------- 工作区选择（v1.14.0；2026-10-01 上移到技能/角色之前） ----------------
          说明文字一律用 <div className="wb-hint"> 而不是 <p>/<label>：
          `.wb-hint` 自带 margin，而 `.wb-field` 的标签是 display:block、
          里面的 <input> 是行内元素 —— 把提示塞进 <label> 会被输入框的基线顶开重叠
          （2026-09-12 用户实测："提示文字被上方输入框遮挡"）。

          用户要求（2026-10-01 第二张截图）：把这一组**移到技能/角色选择之上**，
          并压缩高度。原来的顺序是「技能 → 角色 → 工作区」，
          现在改成「工作区 → 技能 → 角色」。
          注意：三项都只是**本次会话的输入**，彼此没有依赖关系，
          所以移动顺序不改变任何判定（判定仍全在纯模块里）。 */}
      {/**
        * 「AI 会话工作区」——批次2 #2：三个入口共用 `WorkspacePicker`。
        *
        * 两种选法（用户原始诉求）：**已有工作区下拉** + **「浏览…」文件夹弹框**；手打路径照旧。
        * 候选集只剩一处实现（`workspaceCandidates`，容器传进来），
        * 原先现场拼的那行 `new Set([...recent, ...openWorkspacePaths, default])` 已删 ——
        * 它的去重口径与全项目的 `recentWorkspaceKey` 不一致。
        *
        * 「不再记住」保留原条件（只有默认值来自"上次手动选择"且用户没动过时才显示，
        * 由容器的 `showForget` 给出）：它是**唯一**的"清掉上次手动选择"出口，
        * 删了会让"设置里的默认工作区"永远不生效（v1.15.2 修过的缺陷）。
        */}
      <WorkspacePicker
        value={workspace}
        touched={workspaceTouched}
        sourceLabel={workspaceSourceLabel}
        candidates={workspaceCandidates}
        disabled={busy}
        placeholder={workspacePlaceholder}
        onChange={onWorkspaceChange}
        onBrowse={onBrowse}
        showForget={showForget}
        onForget={onForget}
      />
      {workspace.trim() !== '' && (
        <label className="wb-inline-check">
          <input
            type="checkbox"
            checked={followFolder}
            onChange={(e) => onFollowFolder(e.target.checked)}
          />
          <span>在该工作区下建任务资料夹（`&lt;任务ID&gt;-&lt;标题片段&gt;`；不勾 = 直接用它本身）</span>
        </label>
      )}
      {/**
        * ⚠️ 这里原本还有两行长提示（"默认值取「上次手动选择的目录」…路径不存在时会明确报错" /
        * "AI 会先澄清必要信息（一次一个主题，最多 5 轮）…"）。用户要求删除：它们各占一行，
        * 而两条语义都已有去处 ——
        *   · 默认值来源：就在上面的字段名后面（`wb-field-note` 的"上次手动选择 / 系统默认"，由判定给出）；
        *   · 路径报错：真出错时以红色错误行就地显示（不静默换目录，这一点没变）；
        *   · 澄清轮数：弹窗按钮文案与澄清流程本身已经说明，不必事前占高度。
        */}

      {/* ---------------- 技能选择（2026-10-01 补上） ----------------
          用户反馈："快速录入弹框页面无法选择 SKill。"
          与共享提示词弹窗**同一个组件、同一份 selectedSkills**，所以这里选的技能
          会真的进提示词（`startAISession` 的 clarify 分支读的就是 selectedSkills）。 */}
      <SkillPicker
        catalog={skillCatalog}
        loading={skillsLoading}
        available={skillsAvailable}
        problem={skillProblem}
        selected={selectedSkills}
        onToggle={onToggleSkill}
        onRetry={onRetrySkills}
        disabled={busy}
      />

      {/* ---------------- 角色选择（D13-B） ----------------
          与共享提示词弹窗**同一个组件、同一套选择逻辑**（需求 §6.3）。
          这样 10 个 mode 都有角色入口：9 个走提示词弹窗，澄清走这里（快速录入）。 */}
      <PersonaPicker
        value={persona}
        onChange={onPersonaChange}
        disabled={busy}
        onError={onError}
        onNotice={onNotice}
      />

      {/* ---------------- 工作区选择已上移到技能选择之前（2026-10-01） ----------------
          用户要求把「AI 会话工作区」这一组挪到技能/角色上面，所以这里不再重复渲染。
          整组（字段 + 不再记住 + 任务资料夹勾选）只有一处实现，避免两处装配打架。*/}
    </Modal>
  )
}
