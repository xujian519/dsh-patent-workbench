/**
 * H4-8 的真浏览器验证脚手架（共享提示词弹窗 `PromptModal`）。
 *
 * ## 复刻的是容器哪一段
 *
 * `askUserPrompt(title)`：每次打开都 `setPromptModal({title, value:''})` + 清空技能选择 +
 * 把角色复位成「未指定」+ 拉一次技能目录；`confirmPrompt` / `cancelPrompt` 负责 resolve 那个 Promise。
 * 这三个都在这里用 `useState` 复刻（真容器是 `index.tsx`，跑不起来），
 * 而 `onConfirm` 记录的是**容器 resolve 出去的载荷形状**（text / skills / persona）——
 * 所以"弹窗的产物怎么交给 `startAISession`"这条契约在浏览器里是可见的。
 *
 * 退化成记录器的只有请求：`loadSkills` / 模型目录（脚手架里没有服务端）。
 * 角色库读不到是**故意**的 —— 那条降级路径本来就要验（就地给原因 + 重试）。
 */
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PromptModal } from '../../../src/client/components/dialogs/PromptModal.js'
import { INHERIT_PERSONA, type PersonaSelection } from '../../../src/client/personaPicker.js'
import { WORKBENCH_CSS } from '../../../src/client/styles.js'
import type { SkillSummary } from '../../../src/shared/contracts.js'
import type { QuickModelSelection, WorkbenchRuntime } from '../../../src/client/viewTypes.js'

/** 技能目录夹具（三条：用来看"列表 / 搜索 / 勾选"）。 */
const SKILLS: SkillSummary[] = [
  { name: 'patent-claim-draft', description: '权利要求撰写', whenToUse: '写权利要求时', provider: 'builtin', source: 'builtin', userInvocable: true, modelInvocable: true },
  { name: 'oa-reply', description: '审查意见答复', provider: 'builtin', source: 'builtin', userInvocable: true, modelInvocable: true },
  { name: 'search-report', description: '检索报告', provider: 'user', source: 'user', userInvocable: true, modelInvocable: false },
]

const calls: Array<{ name: string; args: unknown[] }> = []

function Harness(): JSX.Element {
  const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)
  const [persona, setPersona] = useState<PersonaSelection>(INHERIT_PERSONA)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [skillProblem, setSkillProblem] = useState('')
  const [skillsAvailable, setSkillsAvailable] = useState(true)
  const [modelSelection, setModelSelection] = useState<QuickModelSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 复刻 `askUserPrompt(title)` 的打开语义（含三处复位）。 */
  const open = useCallback((title: string): void => {
    setPromptModal({ title, value: '' })
    setSelectedSkills([])
    setPersona(INHERIT_PERSONA)
    calls.push({ name: 'loadSkills', args: [] })
  }, [])

  useEffect(() => {
    ;(globalThis as unknown as { __h4: unknown }).__h4 = {
      calls: () => calls.slice(),
      open,
      setBusy,
      /** 演示"宿主没有 skills 服务 / 目录读不到"的降级形态。 */
      setSkillsUnavailable: (problem: string) => { setSkillsAvailable(false); setSkillProblem(problem) },
      state: () => ({ promptModal, persona, selectedSkills, modelSelection, busy, error }),
    }
  })

  return (
    <div className="wb-body" style={{ height: '100vh' }}>
      {promptModal !== null && (
        <PromptModal
          title={promptModal.title}
          value={promptModal.value}
          onValue={(value) => setPromptModal((prev) => prev === null ? prev : { ...prev, value })}
          skillCatalog={SKILLS}
          skillsLoading={false}
          skillsAvailable={skillsAvailable}
          skillProblem={skillProblem}
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
          onCancel={() => { calls.push({ name: 'cancel', args: [] }); setPromptModal(null) }}
          onConfirm={() => {
            // 复刻 `confirmPrompt()`：把弹窗里的三样东西 resolve 给 startAISession。
            calls.push({
              name: 'confirm',
              args: [{
                text: promptModal.value,
                skills: [...selectedSkills],
                persona,
              }],
            })
            setPromptModal(null)
          }}
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
