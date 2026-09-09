import { useCallback, useEffect, useRef, useState } from 'react'
import { closePdfSession, openPdfSession, type PdfSession } from '../pdf/pdf-session'
import { PdfError, pdfErrorMessage } from '../pdf/pdf-service'
import { useReaderDisplay } from './use-reader-display'
import { ZoomableImageDialog } from '../gallery/ZoomableImageDialog'
import type { ChapterNode, LearningDocument } from './document-types'
import css from './document-context-preview.module.css'

type Props = {
  document: LearningDocument
  initialPage: number
  onBack: () => void
}

function clampPage(page: number, pageCount: number): number {
  return Math.max(1, Math.min(pageCount, Math.trunc(page) || 1))
}

function narrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches
}

function PreviewTocRows({ nodes, onOpen, depth = 0 }: { nodes: ChapterNode[]; onOpen: (node: ChapterNode) => void; depth?: number }) {
  return (
    <div className={css.tocTree}>
      {nodes.map(node => (
        <div key={node.id}>
          <button type="button" className={css.tocRow} data-testid={'doc-context-preview-chapter-' + node.id} style={{ paddingLeft: 8 + depth * 14 }} disabled={node.startPage == null} onClick={() => onOpen(node)}>
            <span className={css.tocText}>{node.title}</span>
            {node.startPage != null && <span className={css.tocRange}>{node.startPage}–{node.endPage ?? node.startPage}</span>}
          </button>
          {node.children.length > 0 && <PreviewTocRows nodes={node.children} onOpen={onOpen} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

export function DocumentContextPreview({ document: sourceDoc, initialPage, onBack }: Props) {
  const [session, setSession] = useState<PdfSession | null>(null)
  const sessionRef = useRef<PdfSession | null>(null)
  const generationRef = useRef(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(clampPage(initialPage, sourceDoc.pageCount))
  const [pageInput, setPageInput] = useState(String(clampPage(initialPage, sourceDoc.pageCount)))
  const [tocOpen, setTocOpen] = useState(false)
  const [tocClosed, setTocClosed] = useState(false)
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  const zoomUrlRef = useRef<string | null>(null)
  const zoomGenerationRef = useRef(0)
  const [zoomBusy, setZoomBusy] = useState(false)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const display = useReaderDisplay(session, page, sourceDoc.pageCount)
  const tocVisible = narrowViewport() ? tocOpen && !tocClosed : !tocClosed

  const clearZoom = useCallback(() => {
    if (zoomUrlRef.current) URL.revokeObjectURL(zoomUrlRef.current)
    zoomUrlRef.current = null
    setZoomUrl(null)
  }, [])

  useEffect(() => {
    const generation = ++generationRef.current
    let ownedSession: PdfSession | null = null
    setSession(null)
    setStatus('loading')
    setError(null)
    const start = clampPage(initialPage, sourceDoc.pageCount)
    setPage(start)
    setPageInput(String(start))
    void openPdfSession(sourceDoc.sourceBlob).then(opened => {
      if (generation !== generationRef.current) { void closePdfSession(opened.session); return }
      ownedSession = opened.session
      sessionRef.current = opened.session
      setSession(opened.session)
      setStatus('ready')
      window.requestAnimationFrame(() => backRef.current?.focus())
    }).catch((e: unknown) => {
      if (generation !== generationRef.current) return
      setStatus('error')
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : '无法打开该 PDF 预览。')
    })
    return () => {
      generationRef.current++
      zoomGenerationRef.current++
      clearZoom()
      if (sessionRef.current === ownedSession) { sessionRef.current = null; setSession(null) }
      if (ownedSession) void closePdfSession(ownedSession)
    }
  }, [clearZoom, initialPage, sourceDoc.id, sourceDoc.sourceBlob, sourceDoc.pageCount])

  useEffect(() => {
    zoomGenerationRef.current++
    clearZoom()
  }, [clearZoom, page])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (zoomUrlRef.current) { clearZoom(); return }
      if (tocVisible) {
        setTocOpen(false)
        setTocClosed(true)
        return
      }
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearZoom, onBack, tocVisible])

  const go = (nextPage: number) => {
    const next = clampPage(nextPage, sourceDoc.pageCount)
    setPage(next)
    setPageInput(String(next))
  }

  const commitPageInput = () => {
    const value = Number(pageInput.trim())
    if (!Number.isInteger(value) || value < 1 || value > sourceDoc.pageCount) {
      setPageInput(String(page))
      return
    }
    go(value)
  }

  const openZoom = () => {
    if (zoomBusy || !sessionRef.current) return
    const generation = ++zoomGenerationRef.current
    const ownedSession = sessionRef.current
    const ownedPage = page
    setZoomBusy(true)
    void display.requestZoomUrl().then(url => {
      if (!url) return
      if (generation !== zoomGenerationRef.current || ownedSession !== sessionRef.current || ownedPage !== page) {
        URL.revokeObjectURL(url)
        return
      }
      if (zoomUrlRef.current) URL.revokeObjectURL(zoomUrlRef.current)
      zoomUrlRef.current = url
      setZoomUrl(url)
    }).catch(() => setError('页面放大查看失败。')).finally(() => setZoomBusy(false))
  }

  const openChapter = (node: ChapterNode) => {
    if (node.startPage == null) return
    go(node.startPage)
    if (narrowViewport()) {
      setTocOpen(false)
      setTocClosed(false)
      window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="doc-context-preview-page-input"]')?.focus())
    }
  }

  return (
    <div className={css.overlay} data-testid="doc-context-preview-view" role="dialog" aria-modal="true" aria-labelledby="doc-context-preview-title">
      <div className={css.preview}>
        <header className={css.header}>
          <button ref={backRef} type="button" className={css.back} data-testid="doc-context-preview-back" onClick={onBack}>← 返回选择</button>
          <h2 id="doc-context-preview-title" className={css.title} data-testid="doc-context-preview-title">PDF 预览 · {sourceDoc.fileName}</h2>
          <button type="button" className={css.tocToggle} data-testid="doc-context-preview-toc-toggle" aria-expanded={tocVisible} aria-controls="doc-context-preview-toc" onClick={() => { setTocClosed(false); setTocOpen(open => !open) }}>目录</button>
        </header>
        <div className={css.body}>
          {tocVisible && (
            <aside id="doc-context-preview-toc" className={css.toc} data-testid="doc-context-preview-toc">
              <div className={css.tocTitle}>目录</div>
              {sourceDoc.chapters.length > 0 ? <PreviewTocRows nodes={sourceDoc.chapters} onOpen={openChapter} /> : <div className={css.tocEmpty}>这份 PDF 暂无章节目录。</div>}
            </aside>
          )}
          <main className={css.main}>
            {status === 'loading' && <div className={css.status} data-testid="doc-context-preview-loading" aria-live="polite">正在打开 PDF 预览…</div>}
            {status === 'error' && <div className={css.error} data-testid="doc-context-preview-error" role="alert">{error || '无法打开该 PDF 预览。'}</div>}
            {session && status === 'ready' && (
              <div ref={display.stageRef} className={css.stage} data-testid="doc-context-preview-stage">
                <button type="button" className={css.pageButton} data-testid="doc-context-preview-page" disabled={zoomBusy} onClick={openZoom} aria-label={'PDF 第 ' + page + ' 页，点击放大'}>
                  <canvas ref={display.canvasRef} className={css.canvas} data-testid="doc-context-preview-page-canvas" aria-label={'PDF 第 ' + page + ' 页'} data-render-width={display.surface ? String(display.surface.width) : undefined} data-render-height={display.surface ? String(display.surface.height) : undefined} />
                </button>
                {display.rendering && <div className={css.rendering} aria-live="polite">正在渲染第 {page} 页…</div>}
                {display.pageError && <div className={css.error} data-testid="doc-context-preview-page-error" role="alert">{display.pageError}</div>}
              </div>
            )}
          </main>
        </div>
        <footer className={css.footer}>
          <button type="button" className={css.navButton} data-testid="doc-context-preview-prev" disabled={status !== 'ready' || page <= 1} onClick={() => go(page - 1)}>上一页</button>
          <div className={css.counter}>
            <input className={css.pageInput} data-testid="doc-context-preview-page-input" inputMode="numeric" aria-label="预览当前页码" value={pageInput} onChange={event => setPageInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPageInput() } }} />
            <span> / {sourceDoc.pageCount}</span>
          </div>
          <button type="button" className={css.navButton} data-testid="doc-context-preview-next" disabled={status !== 'ready' || page >= sourceDoc.pageCount} onClick={() => go(page + 1)}>下一页</button>
          <button type="button" className={css.zoomButton} data-testid="doc-context-preview-zoom" disabled={status !== 'ready' || zoomBusy} onClick={openZoom}>放大</button>
        </footer>
      </div>
      {zoomUrl && <ZoomableImageDialog src={zoomUrl} alt={'PDF 第 ' + page + ' 页'} resetKey={page} onClose={clearZoom} labels={{ close: '关闭', dialog: 'PDF 页面预览' }} />}
    </div>
  )
}
