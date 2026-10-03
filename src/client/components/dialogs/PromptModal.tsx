/**
 * 共享提示词弹窗（9 个 mode 的补充提示词入口）—— H4-8 从 `index.tsx` 搬出来的**纯画法**。
 *
 * ## 边界（plan §3）
 *
 * - **传进来的**：标题（由容器按 mode 给，`AI_PROMPT_LABELS`）、正在编辑的正文、
 *   三个选择器的当前值与"选项从哪来"、busy。**没有一处 `useState`** ——
 *   `promptModal` / `promptPersona` / `selectedSkills` / 模型选择（与快速录入**同一份** state）
 *   都住容器：这个弹窗的产物要经 `askUserPrompt()` 的 resolve 交给 `startAISession`。
 * - **留在这里的**：只有"怎么画这一块"。
 * - **不发请求**：两个按钮只发 `onCancel` / `onConfirm` 意图（容器的 `cancelPrompt` /
 *   `confirmPrompt` 负责 resolve 那个 Promise）。
 *
 * ## ⚠️ 它不是共用的 `Modal`
 *
 * 这张弹窗用的是自建的 `.wb-modal-mask` / `.wb-modal`（**不 portal、不锁滚动、不抢焦点**），
 * 而不是 `components/Modal.tsx`。H4-8 按纯搬家处理，结构逐字保留 —— 换成 `Modal`
 * 会同时改观感（多出标题栏与关闭按钮）、改层级（portal 到 body）与改行为（锁滚动 / 焦点陷阱），
 * 那是**行为变更**，不在拆分范围内。已记进 `subtasks.md` 作为独立候选。
 */
import { ModelPicker } from '../ModelPicker.js'
import { PersonaPicker } from '../PersonaPicker.js'
import { SkillPicker } from '../SkillPicker.js'
import type { SkillSummary } from '../../../shared/contracts.js'
import type { PersonaSelection } from '../../personaPicker.js'
import type { QuickModelSelection, WorkbenchRuntime } from '../../viewTypes.js'

export interface PromptModalProps {
  /** 弹窗正文里那句"<标题>：可留空…"的标题（容器按 mode 给）。 */
  title: string
  value: string
  onValue: (value: string) => void
  skillCatalog: readonly SkillSummary[]
  skillsLoading: boolean
  skillsAvailable: boolean
  skillProblem: string
  selectedSkills: readonly string[]
  onToggleSkill: (name: string) => void
  onRetrySkills: () => void
  persona: PersonaSelection
  onPersonaChange: (next: PersonaSelection) => void
  runtime: WorkbenchRuntime
  modelSelection: QuickModelSelection | null
  onModelChange: (selection: QuickModelSelection | null) => void
  modelModalityTable: ReadonlyMap<string, readonly string[] | null>
  onModelLoaded: () => void
  busy: boolean
  /** 三个选择器读列表 / 目录失败时的可读中文原因（父级负责显示，不静默）。 */
  onError: (message: string) => void
  onNotice: (message: string) => void
  onCancel: () => void
  onConfirm: () => void
}

export function PromptModal({
  title, value, onValue,
  skillCatalog, skillsLoading, skillsAvailable, skillProblem, selectedSkills, onToggleSkill, onRetrySkills,
  persona, onPersonaChange,
  runtime, modelSelection, onModelChange, modelModalityTable, onModelLoaded,
  busy, onError, onNotice, onCancel, onConfirm,
}: PromptModalProps): JSX.Element {
  return (
    <div className="wb-modal-mask" onClick={onCancel}>
      <div className="wb-modal" style={{ width: 'min(620px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <h4>补充 AI 提示词</h4>
        <p>{title}：可留空，留空则继续使用原有默认提示词；填写后会在默认提示词末尾追加你的补充要求。</p>
        <textarea autoFocus value={value} onChange={(e) => onValue(e.target.value)} placeholder="输入你想追加给 AI 的补充要求…" />
        {/**
          * 角色选择器（D13-B）：与技能选择器**并列**，且都走普通文档流（不遮挡，AX-R07）。
          * 9 个走共享提示词弹窗的 mode 全部经由这里选择角色。
          *
          * 顺序：**角色在前、技能在后**（AX-R07 的判据，也是原实现的顺序）——
          * 两个都是普通文档流里的块，谁在前谁在上；角色是"这次以谁的身份"，先定身份再挑工具。
          */}
        <PersonaPicker
          value={persona}
          onChange={onPersonaChange}
          disabled={busy}
          onError={onError}
          onNotice={onNotice}
        />
        {/**
          * 技能选择器：与角色选择器并列（都走普通文档流）。
          *
          * 抽成 `SkillPicker` 组件之后，**快速录入弹窗挂的是同一个组件** ——
          * 用户反馈的"快速录入不能选 Skill"就是在这里补上的（2026-10-01）。
          */}
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
        {/**
          * 模型选择器（2026-10-01 补上）：与快速录入**同一个组件**。
          *
          * 用户反馈："除了快速录入外，其他调用 AI 的弹框中依旧无法选择 AI 模型。"
          * 原来它只渲染在快速录入里；现在两个弹窗共用一份实现，
          * 选择值经 `askUserPrompt()` 的返回值传到 `startAISession`（并在那里对**所有 mode**生效）。
          */}
        <ModelPicker
          runtime={runtime}
          value={modelSelection}
          onChange={onModelChange}
          modalityTable={modelModalityTable}
          disabled={busy}
          onError={onError}
          onLoaded={onModelLoaded}
        />
        <div className="wb-modal-actions">
          <button className="wb-btn" onClick={onCancel}>取消</button>
          <button className="wb-btn primary" onClick={onConfirm}>开始</button>
        </div>
      </div>
    </div>
  )
}
