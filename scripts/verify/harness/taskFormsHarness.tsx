/**
 * H4-8（第 3 批）真浏览器验证脚手架：新建任务 / 编辑任务两张表单。
 *
 * ## 这个脚手架比"把组件喂几个 props"更实的地方
 *
 * - 字典取自 `src/db/seed.ts` 的出厂值（type 9 / status 6 / priority 4 / ai_policy 3），
 *   驱动因此可以逐字比对选项文案与默认选中项（`client_meeting` / `p2` / `todo`）。
 * - 编辑草稿**逐字照抄容器的 `beginEditTask`**，含 `toLocalInput(task.dueAt)` 这个
 *   生产函数现算的时区口径 —— 驱动不手写 "2026-10-04T17:30"。
 * - 新建表单是**非受控**的：`onSubmit` 里真的读一遍 `FormData` 并把它暴露给驱动，
 *   所以"hidden 的 workspacePath 能进 FormData"是实测的，而不是看着 JSX 猜的。
 *
 * 退化成记录器的只有"意图 → 请求"：`createTask`（POST）、`saveEditDraft`（PATCH）、
 * `openDirPicker('form'|'edit')`（打开目录浏览弹窗）。三者都记录了**事件能否被 preventDefault**
 * —— 表单必须拦住浏览器默认提交，否则整页跳走。
 */
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditTaskModal, type EditTaskDraft } from '../../../src/client/components/dialogs/EditTaskModal.js'
import { NewTaskModal } from '../../../src/client/components/dialogs/NewTaskModal.js'
import { toLocalInput } from '../../../src/client/format.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { Dict } from '../../../src/client/viewTypes.js'
import type { WorkspaceCandidate } from '../../../src/client/workspacePicker.js'

/** 出厂字典（`src/db/seed.ts`），只截取驱动要逐字比对的那几组。 */
function dict(kind: string, code: string, name: string): Dict {
  return { kind, code, name, config: {} }
}
const DICTS: Dict[] = [
  dict('type', 'client_meeting', '客户交流'), dict('type', 'code_impl', '代码实现'),
  dict('type', 'feature_opt', '功能优化'), dict('type', 'solution_design', '方案设计'),
  dict('type', 'boss_request', '老板要求'), dict('type', 'team_mgmt', '团队管理'),
  dict('type', 'project_delivery', '项目交付'), dict('type', 'personal', '个人生活'),
  dict('type', 'training', '培训学习'),
  dict('status', 'backlog', '待规划'), dict('status', 'todo', '待办'), dict('status', 'doing', '进行中'),
  dict('status', 'blocked', '被阻塞'), dict('status', 'done', '已完成'), dict('status', 'cancelled', '已取消'),
  dict('priority', 'p0', '紧急'), dict('priority', 'p1', '高'), dict('priority', 'p2', '普通'), dict('priority', 'p3', '低'),
  dict('ai_policy', 'none', '不允许'), dict('ai_policy', 'consult', '可咨询'), dict('ai_policy', 'execute', '可执行'),
]
const dictOf = (kind: string): Dict[] => DICTS.filter((d) => d.kind === kind)

/** 与生产同口径的默认耗时（`DEFAULT_PLAN_MINUTES`），只用于比对占位/说明文案。 */
const DEFAULT_ESTIMATE_MINUTES = 30

const WORKSPACE_CANDIDATES: WorkspaceCandidate[] = [
  { path: '/Users/xujian/projects/matters/2025-UM-118', source: 'recent' },
  { path: '/Users/xujian/projects/default', source: 'default' },
]

/** 复刻容器 `createTask` 的第一步：从 FormData 取字段（受控的 hidden 也要能取到）。 */
function formDataOf(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form)
  const out: Record<string, string> = {}
  for (const key of ['title', 'type', 'priority', 'status', 'due', 'estimatedMinutes', 'workspacePath', 'description']) {
    out[key] = String(data.get(key) ?? '')
  }
  out.allDay = String(data.get('allDay') !== null)
  return out
}

/** 库里的一条任务（编辑态用；字段取真库里的形状）。 */
const TASK = {
  id: 't-1', title: '答复第一次审查意见', description: '**要点**：独权缺少必要技术特征。',
  typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'consult',
  dueAt: '2026-10-04T09:30:00.000Z', workspacePath: '/Users/xujian/projects/matters/2025-UM-118',
  parentId: 't-2', estimatedMinutes: 90, allDay: false,
}

/** 逐字照抄容器的 `beginEditTask`。 */
function editDraftOf(task: typeof TASK): EditTaskDraft {
  return {
    title: task.title, description: task.description, typeCode: task.typeCode, priorityCode: task.priorityCode,
    statusCode: task.statusCode, aiPolicyCode: task.aiPolicyCode, dueLocal: toLocalInput(task.dueAt),
    workspacePath: task.workspacePath ?? '', parentId: task.parentId ?? '',
    estimatedMinutes: task.estimatedMinutes === null ? '' : String(task.estimatedMinutes), allDay: task.allDay,
  }
}

/**
 * 逐字照抄容器 `reparentCandidates` 的**形状**（id / title / depth，已排除自身与后代）——
 * 这里给三层缩进，好验证 `\u00a0` 的层级真的是按 depth 算出来的。
 */
const REPARENT_CANDIDATES = [
  { id: 't-2', title: '父任务', depth: 0 },
  { id: 't-3', title: '子任务', depth: 1 },
  { id: 't-4', title: '孙任务', depth: 2 },
]

const calls: Array<{ name: string; args: unknown[] }> = []

function Harness(): JSX.Element {
  const [which, setWhich] = useState<'new' | 'edit' | null>(null)
  const [busy, setBusy] = useState(false)
  /** 与容器同名同义：新建表单的工作区受控值（表单纯非受控，只有它受控）。 */
  const [formWorkspace, setFormWorkspace] = useState('')
  const [editDraft, setEditDraft] = useState<EditTaskDraft | null>(null)

  const show = useCallback((target: string | null): void => {
    if (target === 'new') { setFormWorkspace(''); setWhich('new'); return }
    if (target === 'edit') { setEditDraft(editDraftOf(TASK)); setWhich('edit'); return }
    setWhich(null)
  }, [])

  /** 每次渲染后重挂一遍，保证 `applyWorkspaceDir` 里的 `which` 是当前值（与别的脚手架同一写法）。 */
  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      show,
      setBusy,
      /** 模拟「浏览…」选完目录后的写回（容器 `applyWorkspaceDir` 的 form / edit 两支）。 */
      applyWorkspaceDir: (path: string) => {
        if (which === 'new') setFormWorkspace(path)
        if (which === 'edit') setEditDraft((prev) => (prev === null ? prev : { ...prev, workspacePath: path }))
      },
      defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES,
      task: TASK,
      state: () => ({ which, busy, formWorkspace, editDraft }),
    }
  })

  return (
    <div className="wb-body" style={{ height: '100vh' }}>
      {which === 'new' && (
        <NewTaskModal
          typeOptions={dictOf('type')}
          priorityOptions={dictOf('priority')}
          statusOptions={dictOf('status')}
          defaultEstimateMinutes={DEFAULT_ESTIMATE_MINUTES}
          workspace={formWorkspace}
          onWorkspaceChange={setFormWorkspace}
          workspaceCandidates={WORKSPACE_CANDIDATES}
          workspacePlaceholder="/Users/xujian/projects/default"
          busy={busy}
          onBrowse={() => calls.push({ name: 'browse', args: ['form'] })}
          onClose={() => { calls.push({ name: 'newClose', args: [] }); setWhich(null) }}
          onSubmit={(event) => {
            // 容器 `createTask` 的第一件事就是 preventDefault；这里记录"拦得住吗" + FormData 实际取到什么。
            event.preventDefault()
            calls.push({
              name: 'newSubmit',
              args: [{ cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, form: formDataOf(event.currentTarget) }],
            })
          }}
        />
      )}
      {which === 'edit' && editDraft !== null && (
        <EditTaskModal
          draft={editDraft}
          onChange={(next) => setEditDraft(next)}
          typeOptions={dictOf('type')}
          priorityOptions={dictOf('priority')}
          statusOptions={dictOf('status')}
          aiPolicyOptions={dictOf('ai_policy')}
          defaultEstimateMinutes={DEFAULT_ESTIMATE_MINUTES}
          workspaceCandidates={WORKSPACE_CANDIDATES}
          workspacePlaceholder="/Users/xujian/projects/default"
          parentCandidates={REPARENT_CANDIDATES}
          busy={busy}
          onBrowse={() => calls.push({ name: 'browse', args: ['edit'] })}
          onClose={() => { calls.push({ name: 'editClose', args: [] }); setEditDraft(null); setWhich(null) }}
          onSave={() => calls.push({ name: 'editSave', args: [editDraft] })}
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
