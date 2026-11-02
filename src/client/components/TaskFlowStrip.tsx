/**
 * 任务闭环条：澄清 → 执行 → 验收 → 复盘。
 *
 * 纯展示。阶段、文案、禁用都来自 `taskFlowSteps()`；
 * 点击只把既有动作交回详情页（执行 / 复盘 → `onStartAI`，验收 → 原来的确认链）。
 */
import type { TaskFlowAction, TaskFlowStepView } from '../taskFlowStage.js'

export interface TaskFlowStripProps {
  steps: readonly TaskFlowStepView[]
  onExecute: () => void
  onAccept: () => void
  onReview: () => void
}

function runAction(action: TaskFlowAction, props: TaskFlowStripProps): void {
  switch (action) {
    case 'execute':
      props.onExecute()
      return
    case 'accept':
      props.onAccept()
      return
    case 'review':
      props.onReview()
      return
    default: {
      const unreachable: never = action
      return unreachable
    }
  }
}

export function TaskFlowStrip({ steps, onExecute, onAccept, onReview }: TaskFlowStripProps): JSX.Element {
  const handlers: TaskFlowStripProps = { steps, onExecute, onAccept, onReview }
  return (
    <nav className="wb-task-flow" aria-label="任务闭环">
      <ol>
        {steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            className={step.current ? 'current' : step.done ? 'done' : 'upcoming'}
            aria-current={step.current ? 'step' : undefined}
          >
            {step.action === null ? (
              <span title={step.title}>{step.text}</span>
            ) : (
              <button
                type="button"
                className={step.current ? 'wb-btn primary' : 'wb-btn'}
                disabled={step.disabled}
                title={step.title}
                onClick={() => {
                  if (step.action !== null) runAction(step.action, handlers)
                }}
              >
                {step.text}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
