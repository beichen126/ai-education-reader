import type { AiTocProgress } from './use-ai-toc-extraction'
import css from './ai-toc-progress.module.css'
import { tx } from '../engine/locale'
import { describeTocRepairReasons } from './toc-repair-reasons'

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
      case 'rendering': return tx('已准备目录页面 ', 'Outline pages prepared: ') + progress.completed + ' / ' + progress.total
      case 'transcribing': return progress.completedBatches != null ? tx('并行识别目录文字 · 已完成 ', 'Reading batches in parallel: ') + progress.completedBatches + ' / ' + progress.windowCount + tx(' 批', ' complete') : tx('正在识别目录文字 · 第 ', 'Reading outline text · batch ') + (progress.windowIndex + 1) + ' / ' + progress.windowCount
      case 'structuring': return (progress.repair ? tx('正在校正 · 已分析 ', 'Correcting hierarchy: ') : tx('已分析 ', 'Hierarchy entries analyzed: ')) + progress.completed + ' / ' + progress.total + tx(' 个目录层级', '')
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
            {progress?.phase === 'structuring' && progress.repair && progress.diagnostics?.length ? <div className={css.hint} data-testid="ai-toc-repair-reason">{tx('正在校正原因：', 'Correcting because: ')}{describeTocRepairReasons(progress.diagnostics, tx('zh', 'en') === 'en')}</div> : null}
            {progress?.phase === 'structuring' && <div><progress className={css.progressBar} data-testid="ai-toc-hierarchy-progress" max={Math.max(1, progress.total)} value={progress.completed} aria-label={tx('目录层级分析进度', 'Outline hierarchy progress')} /><div className={css.hint}>{tx('按模型实际返回的层级数更新，完成后统一校验；思考期间数字暂不增长。', 'Counts actual returned levels, validated when complete. The count pauses while the model is thinking.')}</div></div>}
            {progress?.phase === 'transcribing' && progress.totalPages != null && <div className={css.hint}>{tx('已准备 ', 'Prepared ')}{progress.renderedPages} / {progress.totalPages}{tx(' 页；3 路并行准备，准备好一批就发送一批，最多同时识别 5 批。', ' pages; 3 preparation slots, sending each ready batch with up to 5 requests at once.')}</div>}
            <div className={css.steps}>
              {steps.map((s, i) => {
                const preparing = i === 0 && progress?.phase === 'transcribing' && (progress.renderedPages ?? 0) < (progress.totalPages ?? 0)
                const state = preparing || i === activeIdx ? 'active' : i < activeIdx ? 'done' : 'todo'
                return <div key={s.key} className={css.step + (state === 'done' ? ' ' + css.done : state === 'active' ? ' ' + css.active : '')} data-testid={'ai-toc-progress-step-' + s.key} data-state={state}>
                  <span className={css.dot}>{state === 'done' ? '✓' : state === 'active' ? '●' : '○'}</span>
                  <span>{s.label}</span>
                </div>
              })}
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
