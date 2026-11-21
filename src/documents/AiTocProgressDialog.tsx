import type { AiTocProgress } from './use-ai-toc-extraction'
import css from './ai-toc-progress.module.css'
import { tx } from '../engine/locale'

type Props = {
  progress: AiTocProgress | null
  selectedCount: number
  error?: string | null
  onClose: () => void       // hide dialog, keep the operation running
  onCancel: () => void      // abort the whole operation
  onRetry?: () => void      // re-run with the SAME selected pages
}

export function AiTocProgressDialog({ progress, selectedCount, error, onClose, onCancel, onRetry }: Props) {
  // A label describing the current work, derived from the real phase.
  const stepLabel = (() => {
    if (!progress) return tx('正在启动目录识别…', 'Starting outline detection…')
    switch (progress.phase) {
      case 'rendering': return tx('已完成目录页 OCR ', 'Outline pages processed by OCR: ') + progress.completed + ' / ' + progress.total
      case 'structuring': return tx('正在统一识别标题、层级和印刷页码…', 'Identifying titles, hierarchy, and printed page labels…')
      case 'mapping': return tx('正在建立 PDF 页码映射', 'Mapping PDF page numbers')
      case 'done': return tx('目录识别完成，正在打开检查目录…', 'Detection complete. Opening review…')
      default: return tx('正在识别目录…', 'Detecting outline…')
    }
  })()

  const steps: { key: string; label: string }[] = [
    { key: 'rendering', label: tx('目录页 OCR', 'Run outline-page OCR') },
    { key: 'structuring', label: tx('统一识别目录', 'Analyze the complete outline') },
    { key: 'mapping', label: tx('建立页码映射', 'Map page numbers') },
  ]
  const activeIdx = error ? 3 : (progress ? stepIndex(progress.phase) : -1)

  return (
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={tx('目录识别', 'Outline detection')}>
      <div className={css.box} data-testid="ai-toc-progress">
        <div className={css.header}>
          <span className={css.title}>{error ? tx('目录识别失败', 'Outline detection failed') : tx('AI 正在识别目录', 'AI is detecting the outline')}</span>
          {!error && <button type="button" className={css.close} data-testid="ai-toc-progress-hide" aria-label={tx('隐藏', 'Hide')} onClick={onClose}>×</button>}
        </div>
        {error ? (
          <div className={css.errBody}>
            <div className={css.errText} data-testid="ai-toc-progress-error">{error}</div>
            <div className={css.btns}>
              <button type="button" className={css.btn} data-testid="ai-toc-progress-close" onClick={onClose}>{tx('关闭', 'Close')}</button>
              {onRetry && <button type="button" className={css.btnPrimary} data-testid="ai-toc-progress-retry" onClick={onRetry}>{tx('重新识别', 'Try again')}</button>}
            </div>
          </div>
        ) : (
          <div className={css.body}>
            <div className={css.stepLabel} role="status" aria-live="polite" data-testid="ai-toc-progress-step">{stepLabel}</div>
            <div className={css.steps}>
              {steps.map((s, i) => {
                const state = i === activeIdx ? 'active' : i < activeIdx ? 'done' : 'todo'
                return <div key={s.key} className={css.step + (state === 'done' ? ' ' + css.done : state === 'active' ? ' ' + css.active : '')} data-testid={'ai-toc-progress-step-' + s.key} data-state={state}>
                  <span className={css.dot}>{state === 'done' ? '✓' : state === 'active' ? '●' : '○'}</span>
                  <span>{s.label}</span>
                </div>
              })}
            </div>
            <div className={css.hint}>{tx(`所选 ${selectedCount} 页 OCR 完成后，合并文字提交一次。`, `After OCR, the text of all ${selectedCount} selected pages is sent together in one model request.`)}</div>
            <div className={css.footer}>
              <button type="button" className={css.btn} data-testid="ai-toc-progress-cancel" onClick={onCancel}>{tx('取消识别', 'Cancel detection')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function stepIndex(phase: AiTocProgress['phase']): number {
  switch (phase) {
    case 'rendering': return 0
    case 'structuring': return 1
    case 'mapping': return 2
    default: return 2
  }
}
