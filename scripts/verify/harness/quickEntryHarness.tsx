/**
 * H4-7 的真浏览器验证脚手架（**不入库构建**，由 `scripts/repro/verify-h4-quick-entry.mjs` 现打包）。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * 容器那一侧凡是**纯函数**都用生产实现现算：
 * - 工作区预填与来源：`decideQuickWorkspaceDefault` + `quickWorkspaceSourceLabel`（逐字照抄
 *   容器 `openQuickEntry` 那一行）；
 * - 候选集：`workspaceCandidates`（三个来源 + `recentWorkspaceKey` 去重）；
 * - "不收的文件为什么被拒"：`partitionQuickFiles`（唯一实现）——所以附件轨上的中文原因
 *   是产品文案，不是手搓的。
 *
 * 退化成记录器的只有容器里"意图 → 请求"那几处（真容器会发请求，浏览器里没有服务端）：
 * - `onAddFiles` 里的**文档抽正文**（`POST /quick-attachments/extract-text`）只记名字；
 * - `onBrowse` / `onForget` / `onSubmit` / `onModelLoaded` / `onNotice` 记一条调用；
 * - `onClose` / `onCancel` 复刻容器那两种收尾（**关闭不动附件、取消清空附件**）——
 *   这个差别是真实语义，必须照抄，否则测不出"ESC 会不会顺手把附件删了"。
 *
 * 容器侧状态（输入 / 工作区 / 附件 / 技能 / 角色 / 模型 / busy）在这里用 `useState` 复刻，
 * 因为真容器是 `index.tsx`（跑不起来）。它复刻的是**数据流向**，不是画法。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickEntryModal } from '../../../src/client/components/dialogs/QuickEntryModal.js'
import {
  MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES, partitionQuickFiles,
  type QuickAttachmentDraft, type QuickImageDraft,
} from '../../../src/client/quickAttachments.js'
import { workspaceCandidates } from '../../../src/client/workspacePicker.js'
import {
  decideQuickWorkspaceDefault, quickWorkspaceSourceLabel, type QuickWorkspaceDefaultSource,
} from '../../../src/client/quickWorkspaceDefault.js'
import { INHERIT_PERSONA, type PersonaSelection } from '../../../src/client/personaPicker.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { SkillSummary } from '../../../src/shared/contracts.js'
import type { QuickModelSelection, WorkbenchRuntime } from '../../../src/client/viewTypes.js'

/** 与容器同口径的两条设置（`recent` 非空 → 预填来源是 `last-manual`，于是「不再记住」可见）。 */
const SETTINGS = {
  quickWorkspaceRecent: ['/Users/xujian/projects/demo'],
  defaultWorkspace: '/Users/xujian/projects/work',
}
/** 宿主已注册的工作区（候选集的第一来源）。 */
const OPEN_WORKSPACES = ['/Users/xujian/projects/dsh-patent-workbench']

/** 技能目录夹具（三条，用来验"列表 + 搜索 + 勾选"）。 */
const SKILLS: SkillSummary[] = [
  { name: 'patent-claim-draft', description: '权利要求撰写', whenToUse: '写权利要求时', provider: 'builtin', source: 'builtin', userInvocable: true, modelInvocable: true },
  { name: 'oa-reply', description: '审查意见答复', provider: 'builtin', source: 'builtin', userInvocable: true, modelInvocable: true },
  { name: 'search-report', description: '检索报告', provider: 'user', source: 'user', userInvocable: true, modelInvocable: false },
]

const calls: Array<{ name: string; args: unknown[] }> = []
let seq = 0

function Harness(): JSX.Element {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<QuickAttachmentDraft[]>([])
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  /**
   * 附件的写穿镜像 ref（与容器同一套构造）：`onAddFiles` 要按"当前已有几张"判上限，
   * 而 React 的 `attachments` 在这个 tick 里还是旧值 —— 所以 ref 与 state 同点赋值。
   */
  const attachmentsRef = useRef<QuickAttachmentDraft[]>([])
  const writeAttachments = (next: QuickAttachmentDraft[]): void => {
    attachmentsRef.current = next
    setAttachments(next)
  }
  /** 预填与来源：调试容器 `openQuickEntry` 同一行判定（`isWsl: false` = 原生 macOS）。 */
  const initial = useMemo(() => decideQuickWorkspaceDefault({
    recent: SETTINGS.quickWorkspaceRecent,
    defaultWorkspace: SETTINGS.defaultWorkspace,
    isWsl: false,
  }), [])
  const [workspace, setWorkspace] = useState(initial.path)
  const [workspaceTouched, setWorkspaceTouched] = useState(false)
  const [workspaceSource] = useState<QuickWorkspaceDefaultSource>(initial.source)
  const [followFolder, setFollowFolder] = useState(true)
  const [persona, setPersona] = useState<PersonaSelection>(INHERIT_PERSONA)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [modelSelection, setModelSelection] = useState<QuickModelSelection | null>(null)
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => workspaceCandidates({
    open: OPEN_WORKSPACES,
    recent: SETTINGS.quickWorkspaceRecent,
    defaultWorkspace: SETTINGS.defaultWorkspace,
  }), [])

  /** 与容器的 `addQuickAttachments` 同构，只有"文档 POST 抽正文"退化成记录。 */
  const onAddFiles = useCallback((files: readonly File[]): void => {
    const partition = partitionQuickFiles(files, attachmentsRef.current)
    const rejectedText = partition.rejected.map((item) => `${item.name}：${item.reason}`).join('；')
    setAttachmentNotice(rejectedText === '' ? null : rejectedText)
    if (partition.images.length > 0) {
      const drafts: QuickImageDraft[] = partition.images.map((file) => {
        seq += 1
        return { id: `img-${seq}`, file: file as File, previewUrl: URL.createObjectURL(file as File) }
      })
      writeAttachments([...attachmentsRef.current, ...drafts])
    }
    // 文档要走服务端抽正文（POST /quick-attachments/extract-text），脚手架里没有服务端 → 只记录意图。
    if (partition.documents.length > 0) calls.push({ name: 'extractDocuments', args: [partition.documents.map((d) => d.name)] })
  }, [])

  const clearAttachments = useCallback((): void => {
    for (const item of attachmentsRef.current) if ('previewUrl' in item) URL.revokeObjectURL(item.previewUrl)
    writeAttachments([])
    setAttachmentNotice(null)
  }, [])

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      state: () => ({
        open, busy, text, workspace, workspaceTouched, workspaceSource, followFolder, persona,
        selectedSkills, modelSelection, error,
        attachmentIds: attachments.map((item) => item.id),
        attachmentNotice,
      }),
      limits: { images: MAX_QUICK_IMAGES, documents: MAX_QUICK_DOCUMENTS },
      setOpen,
      setBusy,
      setText,
    }
  })

  return (
    <div className="wb-body" style={{ height: '100vh' }}>
      {open && (
        <QuickEntryModal
          text={text}
          onText={setText}
          attachments={attachments}
          attachmentNotice={attachmentNotice}
          onAddFiles={onAddFiles}
          onRemoveAttachment={(id) => {
            const target = attachmentsRef.current.find((item) => item.id === id)
            if (target !== undefined && 'previewUrl' in target) URL.revokeObjectURL(target.previewUrl)
            writeAttachments(attachmentsRef.current.filter((item) => item.id !== id))
            setAttachmentNotice(null)
          }}
          workspace={workspace}
          workspaceTouched={workspaceTouched}
          workspaceSourceLabel={quickWorkspaceSourceLabel(workspaceSource)}
          workspaceCandidates={candidates}
          workspacePlaceholder={SETTINGS.defaultWorkspace}
          showForget={workspaceSource === 'last-manual' && !workspaceTouched}
          onWorkspaceChange={(path) => { setWorkspaceTouched(true); setWorkspace(path) }}
          onBrowse={() => calls.push({ name: 'browse', args: [] })}
          onForget={() => calls.push({ name: 'forgetWorkspace', args: [workspace] })}
          followFolder={followFolder}
          onFollowFolder={setFollowFolder}
          skillCatalog={SKILLS}
          skillsLoading={false}
          skillsAvailable
          skillProblem=""
          selectedSkills={selectedSkills}
          onToggleSkill={(name) => setSelectedSkills((prev) => prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name])}
          onRetrySkills={() => calls.push({ name: 'retrySkills', args: [] })}
          persona={persona}
          onPersonaChange={setPersona}
          runtime={{} as WorkbenchRuntime}
          modelSelection={modelSelection}
          onModelChange={setModelSelection}
          modelModalityTable={new Map()}
          onModelLoaded={() => calls.push({ name: 'modelLoaded', args: [] })}
          busy={busy}
          onError={setError}
          onNotice={(message) => calls.push({ name: 'notice', args: [message] })}
          onClose={() => { calls.push({ name: 'close', args: [] }); setOpen(false) }}
          onCancel={() => { calls.push({ name: 'cancel', args: [attachmentsRef.current.length] }); clearAttachments(); setOpen(false) }}
          onSubmit={() => calls.push({ name: 'submit', args: [{ text, workspace, followFolder, persona, attachments: attachmentsRef.current.map((item) => item.id) }] })}
        />
      )}
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
