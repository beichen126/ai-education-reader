import type { AiTocProgress } from './use-ai-toc-extraction'
import css from './ai-toc-progress.module.css'

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
    if (!progress) return '正在启动目录识别…'
    switch (progress.phase) {
      case 'rendering': return '正在准备目录页面 ' + (progress.completed + 1) + ' / ' + progress.total
      case 'transcribing': return '正在识别目录文字 ' + (progress.windowIndex + 1) + ' / ' + progress.windowCount
      case 'structuring': return '正在分析整本目录层级'
      case 'mapping': return '正在建立 PDF 页码映射'
      case 'done': return '目录识别完成，正在打开检查目录…'
      default: return '正在识别目录…'
    }
  })()

  const steps: { key: string; label: string }[] = [
    { key: 'rendering', label: '准备目录页面' },
    { key: 'transcribing', label: '识别目录文字' },
    { key: 'structuring', label: '分析目录结构' },
    { key: 'mapping', label: '建立页码映射' },
  ]
  const activeIdx = error ? 4 : (progress ? stepIndex(progress.phase) : -1)

  return (
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label="目录识别">
      <div className={css.box} data-testid="ai-toc-progress">
        <div className={css.header}>
          <span className={css.title}>{error ? '目录识别失败' : 'AI 正在识别目录'}</span>
          {!error && <button type="button" className={css.close} data-testid="ai-toc-progress-hide" aria-label="隐藏" onClick={onClose}>×</button>}
        </div>
        {error ? (
          <div className={css.errBody}>
            <div className={css.errText} data-testid="ai-toc-progress-error">{error}</div>
            <div className={css.btns}>
              <button type="button" className={css.btn} data-testid="ai-toc-progress-close" onClick={onClose}>关闭</button>
              {onRetry && <button type="button" className={css.btnPrimary} data-testid="ai-toc-progress-retry" onClick={onRetry}>重新识别</button>}
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
            <div className={css.hint}>AI 识别可能需要几十秒，请稍候。完整 PDF 不会上传，仅发送所选{selectedCount}页目录图。</div>
            <div className={css.footer}>
              <button type="button" className={css.btn} data-testid="ai-toc-progress-cancel" onClick={onCancel}>取消识别</button>
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
