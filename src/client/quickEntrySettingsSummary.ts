/**
 * 快速录入「会话设置」折叠摘要（纯展示）。
 *
 * 展开后的选择器仍读容器里的同一份值；这里只把那份值收成一行，
 * 不参与提交，也不另存一份工作区 / 技能 / 角色 / 模型。
 */
import { CLEAR_SELECTION_LABEL } from './modelCapability.js'
import type { PersonaSelection } from './personaPicker.js'
import type { QuickModelSelection } from './viewTypes.js'

export interface QuickEntrySettingsSummaryInput {
  /** 用户动过工作区之后，选择器来源文案会盖成「手动指定」。摘要跟这一行，不另算来源。 */
  workspaceTouched: boolean
  /** 容器已经算好的来源文案（`quickWorkspaceSourceLabel`）。 */
  workspaceSourceLabel: string
  skillCount: number
  persona: PersonaSelection
  modelSelection: QuickModelSelection | null
}

/** 角色在摘要里的短标签。展开后的选择器仍用完整文案。 */
export function quickEntryPersonaLabel(selection: PersonaSelection): string {
  switch (selection.mode) {
    case 'inherit':
      return '未指定'
    case 'none':
      return '无角色'
    case 'persona':
      return selection.personaId.trim() === '' ? '已选角色' : selection.personaId
    default: {
      const unreachable: never = selection
      return unreachable
    }
  }
}

/** 模型摘要与选择器在「目录还没加载」时的回退文案同一套。 */
export function quickEntryModelLabel(selection: QuickModelSelection | null): string {
  if (selection === null) return CLEAR_SELECTION_LABEL
  return selection.effortLabel === undefined ? selection.label : `${selection.label} · ${selection.effortLabel}`
}

/** `工作区来源 · 技能数 · 角色 · 模型` */
export function quickEntrySettingsSummary(input: QuickEntrySettingsSummaryInput): string {
  const workspace = input.workspaceTouched ? '手动指定' : input.workspaceSourceLabel
  const persona = quickEntryPersonaLabel(input.persona)
  const model = quickEntryModelLabel(input.modelSelection)
  return `${workspace} · ${input.skillCount} 个技能 · ${persona} · ${model}`
}
