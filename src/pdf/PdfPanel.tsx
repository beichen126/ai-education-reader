// PDF preview panel: a restrained dialog opened from a Composer "PDF" button.
// Stage 1 scope: load a local PDF, show file info + page count, let the user pick
// a page range, and render ONLY that range to images for local preview. Nothing
// here reaches attachments / draft / messages / Gallery / the AI.
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Modal, Button, Input } from '../dsh/primitives'
import { formatBytes } from '../storage/diagnostics'
import { usePdfPreview } from './use-pdf-preview'
import css from './pdf-panel.module.css'

export function PdfPanel({ initialFile, onClose }: { initialFile?: File; onClose: () => void }) {
  const { doc, pages, status, error, progress, selectFile, generate } = usePdfPreview()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Load the file chosen from the Composer's PDF button once the panel mounts.
  useEffect(() => { if (initialFile) void selectFile(initialFile) }, [initialFile])

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setStart(''); setEnd(''); await selectFile(f) }
    e.target.value = ''
  }

  const generating = progress !== undefined

  return (
    <>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={onPick} />
      <Modal open onClose={onClose} title="PDF 本地预览" closeLabel="关闭" className={css.modal}>
        <div className={css.column}>
          {status === 'loading' && <div className={css.empty}>正在打开 PDF…</div>}

          {status === 'error' && (
            <>
              <div className={css.error} data-testid="pdf-error">{error || 'PDF 处理失败。'}</div>
              <div className={css.actions}>
                <Button variant="outline" onClick={() => fileRef.current?.click()}>重新选择</Button>
              </div>
            </>
          )}

          {status === 'ready' && doc && (
            <>
              <div className={css.fileRow}>
                <span className={css.fileName}>{doc.fileName}</span>
                <span className={css.fileMeta}>{formatBytes(doc.fileSize)} · 共 {doc.pageCount} 页</span>
              </div>

              <div className={css.rangeRow}>
                <div className={css.rangeField}>
                  <label className={css.rangeLabel}>开始页</label>
                  <Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-start" value={start} onChange={e => setStart(e.target.value)} placeholder="1" />
                </div>
                <div className={css.rangeField}>
                  <label className={css.rangeLabel}>结束页</label>
                  <Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-end" value={end} onChange={e => setEnd(e.target.value)} placeholder={String(doc.pageCount)} />
                </div>
              </div>

              {error && <div className={css.error} data-testid="pdf-error">{error}</div>}

              <div className={css.actions}>
                <Button variant="primary" data-testid="pdf-generate" disabled={generating} onClick={() => void generate(start, end)}>
                  {generating ? '正在渲染…' : '生成预览'}
                </Button>
                <Button variant="outline" disabled={generating} onClick={() => fileRef.current?.click()}>重新选择</Button>
              </div>

              {generating && progress && (
                <div className={css.progress}>正在渲染 {progress.done} / {progress.total} 页</div>
              )}

              {!generating && pages.length > 0 && (
                <>
                  <div className={css.progress}>共生成 {pages.length} 页</div>
                  <div className={css.pages}>
                    {pages.map(p => (
                      <div className={css.pageItem} key={p.pageNumber} data-testid="pdf-page">
                        <span className={css.pageLabel}>第 {p.pageNumber} 页</span>
                        <img className={css.pageImg} src={p.previewUrl} alt={`第 ${p.pageNumber} 页`} width={p.width} height={p.height} />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!generating && pages.length === 0 && !error && (
                <div className={css.empty}>输入页码范围后点击“生成预览”。</div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
