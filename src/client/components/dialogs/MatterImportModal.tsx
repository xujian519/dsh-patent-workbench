/**
 * 「扫描导入案卷」弹窗 —— **纯画法，零 `useState`**（状态住 `useMatterImport` hook，
 * 沿用 `MatterDraftModal.tsx` 立的规矩：弹窗只画与发意图，不发请求、不做判定）。
 *
 * ## 三步
 *
 * `pick`（填扫描根）→ `review`（核对候选与勾选）→ `done`（回执）。
 *
 * ## 为什么候选要分档 + 折叠
 *
 * 实测真实工作目录一次扫出 **983 个候选**，一次全渲染会卡，人也不可能逐条读完。
 * 分成高/中/其余三档、其余档默认折叠，是为了让人先看「自带申请号或日志」的那 37 条。
 * **折叠不等于排除** —— 三档都能展开、都能勾选（分档是启发式，实测有业务分类目录
 * 混进高置信，也有真案卷落进「其余」）。
 *
 * ## 勾选默认值
 *
 * 高置信默认勾选（它自带线索），中/其余默认不勾 —— 且顶部实时显示
 * 「已勾选 N 条 · 可导入 M 条」，缺案号的那些会单独说出来。
 */
import { Icon } from '../Icon.js'
import { Modal } from '../Modal.js'
import { matchesQuery } from '../../matterImportApi.js'
import type {
  MatterImportCandidate, MatterImportCommitResult, MatterImportRow, MatterImportRows,
  MatterImportScanResult, MatterImportTier,
} from '../../matterImportApi.js'
import type { MatterImportStep } from '../../useMatterImport.js'
import type { Dict } from '../../viewTypes.js'

const TIERS: Array<{ key: MatterImportTier; label: string; hint: string }> = [
  { key: 'high', label: '高置信', hint: '目录名含申请号，或含 _matter-log.md' },
  { key: 'mid', label: '中置信', hint: '目录里有交底书 / 说明书 / 审查意见一类文件' },
  { key: 'rest', label: '其余', hint: '没有识别到线索 —— 折叠着，但同样可以勾选' },
]

export interface MatterImportModalProps {
  step: MatterImportStep
  root: string
  busy: boolean
  error: string
  scan: MatterImportScanResult | null
  rows: MatterImportRows
  query: string
  result: MatterImportCommitResult | null
  summary: { checked: number; importable: number; incomplete: number }
  matterTypeOptions: readonly Dict[]
  onRootChange: (value: string) => void
  onQueryChange: (value: string) => void
  onScan: () => void
  onCommit: () => void
  onBack: () => void
  onToggleRow: (relPath: string) => void
  onSetTier: (relPaths: readonly string[], checked: boolean) => void
  onPatchRow: (relPath: string, patch: Partial<MatterImportRow>) => void
  onClose: () => void
}

function footerFor(props: MatterImportModalProps): JSX.Element {
  if (props.step === 'pick') {
    return (
      <>
        <span className="wb-field-note">扫描只读目录结构，不打开文件、不改动你的目录</span>
        <button className="wb-btn" type="button" onClick={props.onClose}>取消</button>
        <button className="wb-btn primary" type="button" disabled={props.busy} onClick={props.onScan}>
          <Icon name="folder" />{props.busy ? '扫描中…' : '开始扫描'}
        </button>
      </>
    )
  }
  if (props.step === 'review') {
    return (
      <>
        <span className="wb-field-note">
          已勾选 {props.summary.checked} 条 · 可导入 {props.summary.importable} 条
          {props.summary.incomplete > 0 ? `（另有 ${props.summary.incomplete} 条缺案号或名称，不会导入）` : ''}
        </span>
        <button className="wb-btn" type="button" disabled={props.busy} onClick={props.onBack}>返回</button>
        <button className="wb-btn primary" type="button" disabled={props.busy || props.summary.importable === 0} onClick={props.onCommit}>
          <Icon name="check" />{props.busy ? '导入中…' : `导入 ${props.summary.importable} 条`}
        </button>
      </>
    )
  }
  return (
    <>
      <span className="wb-field-note">导入的案卷已出现在「案件」列表里</span>
      <button className="wb-btn" type="button" onClick={props.onBack}>再扫一次</button>
      <button className="wb-btn primary" type="button" onClick={props.onClose}><Icon name="check" />完成</button>
    </>
  )
}

function PickStep(props: MatterImportModalProps): JSX.Element {
  return (
    <div className="wb-form">
      <label className="full">扫描根目录
        <input
          value={props.root}
          onChange={(event) => props.onRootChange(event.target.value)}
          placeholder="~/工作"
          data-matter-import-root
        />
      </label>
      <p className="wb-field-note">
        扫描这棵目录树，把每个子目录列成候选。目录名里的申请号会自动填进「案号」，
        其余字段可以逐条改 —— 目录名不是台账，多数案号要你自己补。
      </p>
    </div>
  )
}

function CandidateRow({ candidate, row, matterTypeOptions, onToggleRow, onPatchRow }: {
  candidate: MatterImportCandidate
  row: MatterImportRow | undefined
  matterTypeOptions: readonly Dict[]
  onToggleRow: (relPath: string) => void
  onPatchRow: (relPath: string, patch: Partial<MatterImportRow>) => void
}): JSX.Element {
  return (
    <div className="wb-import-row" data-matter-import-row={candidate.relPath}>
      <input
        type="checkbox"
        checked={row?.checked ?? false}
        onChange={() => onToggleRow(candidate.relPath)}
        aria-label={`选择 ${candidate.relPath}`}
      />
      <div className="wb-import-fields">
        <input
          value={row?.caseNumber ?? ''}
          onChange={(event) => onPatchRow(candidate.relPath, { caseNumber: event.target.value })}
          placeholder="案号（必填）"
        />
        <input
          value={row?.title ?? ''}
          onChange={(event) => onPatchRow(candidate.relPath, { title: event.target.value })}
          placeholder="发明名称（必填）"
        />
        <select
          value={row?.matterType ?? 'other'}
          onChange={(event) => onPatchRow(candidate.relPath, { matterType: event.target.value })}
        >
          {matterTypeOptions.map((dict) => <option key={dict.code} value={dict.code}>{dict.name}</option>)}
        </select>
      </div>
      <div className="wb-import-meta">
        <span className="wb-import-path" title={candidate.path}>{candidate.relPath}</span>
        {candidate.evidence.map((item) => <span className="wb-import-badge" key={item}>{item}</span>)}
      </div>
    </div>
  )
}

function TierSection(props: MatterImportModalProps & { tier: typeof TIERS[number]; list: readonly MatterImportCandidate[] }): JSX.Element {
  const { tier, list } = props
  const relPaths = list.map((candidate) => candidate.relPath)
  return (
    <details className="wb-import-tier" open={tier.key !== 'rest'}>
      <summary>
        <span className="wb-import-tier-label">{tier.label}（{list.length}）</span>
        <span className="wb-field-note">{tier.hint}</span>
        <button
          className="wb-btn" type="button"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); props.onSetTier(relPaths, true) }}
        >全选</button>
        <button
          className="wb-btn" type="button"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); props.onSetTier(relPaths, false) }}
        >全不选</button>
      </summary>
      <div className="wb-import-rows">
        {list.length === 0
          ? <div className="wb-empty">这一档没有候选。</div>
          : list.map((candidate) => (
            <CandidateRow
              key={candidate.relPath}
              candidate={candidate}
              row={props.rows[candidate.relPath]}
              matterTypeOptions={props.matterTypeOptions}
              onToggleRow={props.onToggleRow}
              onPatchRow={props.onPatchRow}
            />
          ))}
      </div>
    </details>
  )
}

function ReviewStep(props: MatterImportModalProps & { scan: MatterImportScanResult }): JSX.Element {
  const { scan } = props
  const visible = scan.candidates.filter((candidate) => matchesQuery(candidate, props.query))
  return (
    <>
      <div className="wb-import-summary">
        扫到 <b>{scan.candidates.length}</b> 个目录（高置信 {scan.tiers.high} · 中置信 {scan.tiers.mid} · 其余 {scan.tiers.rest}）
      </div>
      {scan.scanned.truncated
        ? <div className="wb-field-note">目录太深或太多，本次扫描<b>已截断</b> —— 更深的目录没有出现在下面。</div>
        : null}
      {scan.scanned.skippedSymlinks.length > 0
        ? <div className="wb-field-note">跳过了 {scan.scanned.skippedSymlinks.length} 个符号链接目录（防环）。</div>
        : null}
      <input
        className="wb-import-search"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        placeholder="搜索路径 / 案号 / 名称"
        data-matter-import-search
      />
      {TIERS.map((tier) => (
        <TierSection
          {...props}
          key={tier.key}
          tier={tier}
          list={visible.filter((candidate) => candidate.tier === tier.key)}
        />
      ))}
    </>
  )
}

function DoneStep({ result }: { result: MatterImportCommitResult }): JSX.Element {
  return (
    <>
      <div className="wb-import-summary">
        已建 <b>{result.created}</b> 个案卷
        {result.failed.length > 0 ? `，${result.failed.length} 条没建出来` : ''}
      </div>
      {result.failed.length > 0
        ? (
          <div className="wb-import-failed">
            <div className="wb-field-note">下面这些<b>没建出来</b>，原因逐条给出（改完可以再扫一次重试）：</div>
            {result.failed.map((failure) => (
              <div className="wb-import-failed-row" key={failure.index}>
                <b>{failure.caseNumber === '' ? '（无案号）' : failure.caseNumber}</b>
                {' · '}{failure.title === '' ? '（无名称）' : failure.title}
                {' —— '}{failure.reason}
              </div>
            ))}
          </div>
        )
        : null}
    </>
  )
}

export function MatterImportModal(props: MatterImportModalProps): JSX.Element {
  const title = props.step === 'pick' ? '扫描导入案卷' : props.step === 'review' ? '核对候选' : '导入结果'
  return (
    <Modal title={<><Icon name="folder" />{title}</>} size="lg" onClose={props.onClose} footer={footerFor(props)}>
      {props.step === 'pick' ? <PickStep {...props} /> : null}
      {props.step === 'review' && props.scan !== null ? <ReviewStep {...props} scan={props.scan} /> : null}
      {props.step === 'done' && props.result !== null
        ? <DoneStep result={props.result} />
        : null}
      {props.error === '' ? null : <div className="wb-doc-error">{props.error}</div>}
    </Modal>
  )
}
