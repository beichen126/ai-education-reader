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
      case 'rendering': return tx('正在准备目录页面 ', 'Preparing outline pages ') + (progress.completed + 1) + ' / ' + progress.total
      case 'transcribing': return tx('正在识别目录文字 · 第 ', 'Reading outline text · batch ') + (progress.windowIndex + 1) + ' / ' + progress.windowCount
      case 'structuring': return progress.repair ? tx('正在校正目录层级结构', 'Correcting outline hierarchy') : tx('正在分析整本目录层级', 'Analyzing the full outline hierarchy')
      case 'mapping': return tx('正在建立 PDF 页码映射', 'Mapping PDF page numbers')
      case 'done': return tx('目录识别完成，正在打开检查目录…', 'Detection complete. Opening review…')
      default: return tx('正在识别目录…', 'Detecting outline…')
    }
  })()

  const steps: { key: string; label: string }[] = [
    { key: 'rendering', label: tx('准备目录页面', 'Prepare outline pages') },
    { key: 'transcribing', label: tx('识别目录文字', 'Read outline text') },
    { key: 'structuring', label: tx('分析目录结构', 'Analyze structure') },
    { key: 'mapping', label: tx('建立页码映射', 'Map page numbers') },
  ]
  const activeIdx = error ? 4 : (progress ? stepIndex(progress.phase) : -1)

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
              {steps.map((s, i) => (
                <div key={s.key} className={css.step + (i < activeIdx ? ' ' + css.done : '') + (i === activeIdx ? ' ' + css.active : '')} data-testid={'ai-toc-progress-step-' + s.key} data-state={i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo'}>
                  <span className={css.dot}>{i < activeIdx ? '✓' : i === activeIdx ? '●' : '○'}</span>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
            <div className={css.hint}>{tx(`AI 识别可能需要几十秒，请稍候。完整 PDF 不会上传，仅发送所选 ${selectedCount} 页目录图。`, `Detection may take a few dozen seconds. The full PDF is never uploaded; only the ${selectedCount} selected outline pages are sent.`)}</div>
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
    case 'transcribing': return 1
    case 'structuring': return 2
    case 'mapping': return 3
    default: return 3
  }
}
