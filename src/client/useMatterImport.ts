/**
 * 「扫描导入」的容器状态（自定义 hook）。
 *
 * ## 为什么状态在这里而不在弹窗里
 *
 * 沿用 `MatterDraftModal.tsx` 立的规矩：**弹窗只画，状态住容器**。容器是
 * `index.tsx`（它要在一处持有表单草稿，因为提交时要从整份草稿拼载荷），
 * 而这个功能的九份状态（开没开、哪一步、扫到了什么、用户勾了什么、结果如何）
 * 塞进 `index.tsx` 会让那个三千行的组件再长两百行 —— 所以抽成 hook，
 * `index.tsx` 里一行 `const matterImport = useMatterImport({...})` 即可。
 *
 * ## 三步而不是两步
 *
 * `pick`（填根目录）→ `review`（核对与勾选）→ `done`（回执）。`done` 单独一步是
 * 因为有**失败也要看见**：983 条里可能有一条案号撞车，回执必须逐条列出原因，
 * 而不是弹个「导入完成」把失败吞掉。
 */
import { useCallback, useState } from 'react'
import { api } from './api.js'
import {
  DEFAULT_SCAN_ROOT, importableItems, initialRows, matterCommitUrl, matterScanUrl, selectionSummary,
  type MatterImportCommitResult, type MatterImportRow, type MatterImportRows, type MatterImportScanResult,
} from './matterImportApi.js'

export type MatterImportStep = 'pick' | 'review' | 'done'

export interface MatterImportController {
  open: boolean
  step: MatterImportStep
  root: string
  busy: boolean
  error: string
  scan: MatterImportScanResult | null
  rows: MatterImportRows
  query: string
  result: MatterImportCommitResult | null
  /** 勾选/可导入/缺字段三个数（界面顶部实时显示）。 */
  summary: { checked: number; importable: number; incomplete: number }
  openImport: () => void
  closeImport: () => void
  setRoot: (value: string) => void
  setQuery: (value: string) => void
  runScan: () => void
  runCommit: () => void
  /** 换一步（回执页「再扫一次」用）。 */
  backToPick: () => void
  toggleRow: (relPath: string) => void
  /** 整档全选 / 全不选（983 条逐条点不现实）。 */
  setTierChecked: (relPaths: readonly string[], checked: boolean) => void
  patchRow: (relPath: string, patch: Partial<MatterImportRow>) => void
}

export function useMatterImport(deps: {
  /** 落库成功后：容器刷新案卷列表（导入的案卷要立刻出现在列表里）。 */
  onImported: (created: number) => void | Promise<void>
}): MatterImportController {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<MatterImportStep>('pick')
  const [root, setRoot] = useState(DEFAULT_SCAN_ROOT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scan, setScan] = useState<MatterImportScanResult | null>(null)
  const [rows, setRows] = useState<MatterImportRows>({})
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<MatterImportCommitResult | null>(null)

  const openImport = useCallback(() => {
    setOpen(true)
    setStep('pick')
    setError('')
    setResult(null)
  }, [])

  const closeImport = useCallback(() => {
    setOpen(false)
    setStep('pick')
    setScan(null)
    setRows({})
    setQuery('')
    setResult(null)
    setError('')
  }, [])

  const backToPick = useCallback(() => {
    setStep('pick')
    setResult(null)
    setError('')
  }, [])

  const runScan = useCallback(() => {
    void (async () => {
      setBusy(true)
      setError('')
      try {
        const res = await api<MatterImportScanResult>(matterScanUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root }),
        })
        setScan(res)
        setRows(initialRows(res.candidates))
        setQuery('')
        setStep('review')
      } catch (e) {
        /* 扫不动就把原因留在弹窗里（路径打错是最常见的一种），不要关掉弹窗让人重来。 */
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }, [root])

  const toggleRow = useCallback((relPath: string) => {
    setRows((prev) => {
      const row = prev[relPath]
      if (row === undefined) return prev
      return { ...prev, [relPath]: { ...row, checked: !row.checked } }
    })
  }, [])

  const setTierChecked = useCallback((relPaths: readonly string[], checked: boolean) => {
    setRows((prev) => {
      const next = { ...prev }
      for (const relPath of relPaths) {
        const row = next[relPath]
        if (row !== undefined) next[relPath] = { ...row, checked }
      }
      return next
    })
  }, [])

  const patchRow = useCallback((relPath: string, patch: Partial<MatterImportRow>) => {
    setRows((prev) => {
      const row = prev[relPath]
      if (row === undefined) return prev
      return { ...prev, [relPath]: { ...row, ...patch } }
    })
  }, [])

  const runCommit = useCallback(() => {
    void (async () => {
      if (scan === null) return
      const items = importableItems(scan.candidates, rows)
      if (items.length === 0) {
        setError('没有可导入的案卷 —— 请至少勾选一条，并填好它的案号与发明名称。')
        return
      }
      setBusy(true)
      setError('')
      try {
        const res = await api<MatterImportCommitResult>(matterCommitUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items }),
        })
        setResult(res)
        setStep('done')
        await deps.onImported(res.created)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }, [scan, rows, deps])

  return {
    open, step, root, busy, error, scan, rows, query, result,
    summary: selectionSummary(scan?.candidates ?? [], rows),
    openImport, closeImport, setRoot, setQuery, runScan, runCommit, backToPick, toggleRow, setTierChecked, patchRow,
  }
}
