// Document Reader (Stage 9.2B1 / 9.2B1.1): full-document reading space backed by an
// explicit PDF session (never the PdfPanel singleton). Lifecycle contract:
// the [docId] load effect OWNS the session it opens and only closes its OWN
// session — reader→library, reader→closed and A→B all tear down via that effect
// cleanup (render generation invalidated, page URL revoked, viewer closed,
// progress flushed with the document id bound at call time). App-level unmount
// effect only keeps pagehide/visibility flush.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDocument, updateLastReadPage } from './document-service'
import { useDocumentUi, documentUiActions } from './document-ui-store'
import { clampReaderPage, parsePageInput } from './reader-utils'
import { openPdfSession, renderSessionPage, closePdfSession, pdfErrorMessage, type PdfSession } from '../pdf/pdf-session'
import { PdfError } from '../pdf/pdf-service'
import { ZoomableImageDialog } from '../gallery/ZoomableImageDialog'
import { createUrlOwner } from './url-owner'
import type { LearningDocument, ChapterNode } from './document-types'
import css from './document-reader.module.css'

type TocTreeState = { expanded: ReadonlySet<string> }

const EMPTY_DOC_STATE = {
  doc: null as LearningDocument | null,
  pageCount: 0,
  page: 1,
  pageInput: '',
}

export function DocumentReader() {
  const ui = useDocumentUi(x => x)
  const docId = ui.view === 'reader' ? ui.documentId : null
  const [doc, setDoc] = useState<LearningDocument | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const sessionRef = useRef<PdfSession | null>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const urlOwnerRef = useRef(createUrlOwner())
  const [rendering, setRendering] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const [pageError, setPageError] = useState<string | null>(null)
  const [tocState, setTocState] = useState<TocTreeState>({ expanded: new Set() })
  const [tocOpen, setTocOpen] = useState(false)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const viewerOpenRef = useRef(false)
  const genRef = useRef(0)
  const pageRef = useRef(1); pageRef.current = page
  const docIdRef = useRef<string | null>(null); docIdRef.current = docId
  const skipFirstProgressRef = useRef(true)
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  // ---- docId-BOUND progress persistence: each write carries the id it belongs to ----
  const persist = useCallback((targetDocId: string, p: number) => {
    if (!targetDocId) return
    queueRef.current = queueRef.current.then(() => updateLastReadPage(targetDocId, p).catch(() => {})).catch(() => {})
  }, [])
  const flushProgress = useCallback(() => {
    const id = docIdRef.current
    if (id) persist(id, pageRef.current)
  }, [persist])
  const flushRef = useRef(flushProgress); flushRef.current = flushProgress

  // ---- load document now OWNS the whole lifecycle for one docId ----
  useEffect(() => {
    if (!docId) {
      // Reader left (library / closed / switching): reset everything synchronously
      // so the previous document's page / image / TOC / viewer never leaks in.
      genRef.current++ // any in-flight render of the old document becomes stale
      sessionRef.current = null
      urlOwnerRef.current.revokeAll()
      setPageUrl(null)
      setViewerUrl(null); viewerOpenRef.current = false
      setDoc(null); setPageCount(0); setPage(1); setPageInput('')
      setPageError(null); setRendering(false); setLoadError(null)
      setTocState({ expanded: new Set() }); setTocOpen(false)
      return
    }
    let cancelled = false
    let ownedSession: PdfSession | null = null
    void (async () => {
      setLoadError(null); setDoc(null)
      setPageCount(0); setPage(1); setPageInput(''); setPageError(null)
      setTocState({ expanded: new Set() }); setTocOpen(false)
      setViewerUrl(null); viewerOpenRef.current = false
      urlOwnerRef.current.revokeAll(); setPageUrl(null)
      sessionRef.current = null
      try {
        const d = await getDocument(docId)
        if (cancelled) return
        if (!d) { setLoadError('找不到这份文档。'); return }
        const o = await openPdfSession(d.sourceBlob)
        if (cancelled) { void closePdfSession(o.session); return }
        ownedSession = o.session
        sessionRef.current = o.session
        setDoc(d); setPageCount(d.pageCount)
        const start = clampReaderPage(d.lastReadPage || 1, d.pageCount)
        setPage(start); setPageInput(String(start))
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof PdfError ? pdfErrorMessage(e.kind) : '无法打开这份文档。')
      }
    })()
    return () => {
      cancelled = true
      genRef.current++ // invalidate pending renders of THIS document immediately
      flushRef.current() // last meaningful page of THIS document (id bound via docIdRef)
      if (ownedSession) { void closePdfSession(ownedSession) }
      if (sessionRef.current === ownedSession) sessionRef.current = null
      urlOwnerRef.current.revokeAll()
      setViewerUrl(null); viewerOpenRef.current = false
    }
  }, [docId])

  // ---- render current page (generation token discards stale results) ----
  useEffect(() => {
    if (!sessionRef.current || !doc || pageCount <= 0) return
    const session = sessionRef.current
    const gen = ++genRef.current
    setRendering(true); setPageError(null)
    void renderSessionPage(session, page).then(r => {
      if (gen !== genRef.current) return // stale (page switch / document switch / leave)
      urlOwnerRef.current.replace(URL.createObjectURL(r.blob))
      setPageUrl(urlOwnerRef.current.current)
      setRendering(false)
    }).catch(() => {
      if (gen !== genRef.current) return
      setRendering(false)
      setPageError('第 ' + page + ' 页渲染失败。')
    })
  }, [page, pageCount, doc])

  // ---- debounced progress persistence (1000ms), id bound at schedule time ----
  useEffect(() => {
    if (skipFirstProgressRef.current) { skipFirstProgressRef.current = false; return }
    const idAtSchedule = docIdRef.current
    const t = setTimeout(() => { if (idAtSchedule) persist(idAtSchedule, page) }, 1000)
    return () => clearTimeout(t)
  }, [page, persist])

  // ---- App-level: flush on hidden/pagehide (unmount flush is the [docId] cleanup) ----
  useEffect(() => {
    const flush = () => flushRef.current()
    const onVis = () => { if (document.visibilityState === 'hidden') flushRef.current() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const go = useCallback((p: number, count: number) => {
    const next = clampReaderPage(p, count)
    setPage(prev => prev === next ? prev : next)
    setPageInput(String(next))
  }, [])

  // ---- keyboard: arrows page, Escape closes (viewer gets priority) ----
  useEffect(() => {
    if (!doc) return
    const onKey = (e: KeyboardEvent) => {
      if (viewerOpenRef.current) return
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(pageRef.current - 1, pageCount) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(pageRef.current + 1, pageCount) }
      else if (e.key === 'Escape') { documentUiActions.close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, pageCount, go])

  const commitPageInput = () => {
    const r = parsePageInput(pageInput, pageCount)
    if (r.ok === false) { setPageError(r.error); return }
    setPageError(null); skipFirstProgressRef.current = false
    setPage(r.page); setPageInput(String(r.page))
  }

  if (ui.view !== 'reader') return null
  const toggleTocNode = (n: ChapterNode) => setTocState(prev => { const e = new Set(prev.expanded); if (e.has(n.id)) e.delete(n.id); else e.add(n.id); return { expanded: e } })
  const clickChapter = (n: ChapterNode) => {
    if (n.selectable && n.startPage != null) { go(n.startPage, pageCount); setTocOpen(false) }
    else if (n.children.length > 0) toggleTocNode(n)
  }

  return (
    <div className={css.overlay} data-testid="document-reader">
      <div className={css.topbar}>
        <button className={css.backBtn} data-testid="reader-back" onClick={() => { flushRef.current(); documentUiActions.backToLibrary() }}>← 文件</button>
        <span className={css.title} data-testid="reader-title">{doc ? doc.fileName : '…'}</span>
        <div className={css.topActions}>
          <button className={css.tocToggle} data-testid="reader-toc-toggle" onClick={() => setTocOpen(o => !o)}>目录</button>
          <button className={css.closeBtn} data-testid="reader-close" onClick={() => { flushRef.current(); documentUiActions.close() }}>关闭</button>
        </div>
      </div>
      <div className={css.body}>
        {loadError ? (
          <div className={css.errorBox} data-testid="reader-error">{loadError}</div>
        ) : (
          <>
            <aside className={css.toc + (tocOpen ? ' ' + css.tocOpen : '')} data-testid="reader-toc">
              <div className={css.tocTitle}>目录</div>
              {doc && doc.chapters.length > 0 ? (
                <div className={css.tocTree}>
                  {doc.chapters.map(c => <TocRow key={c.id} node={c} depth={0} state={tocState} onOpen={clickChapter} onToggle={toggleTocNode} />)}
                </div>
              ) : (
                <div className={css.tocEmpty} data-testid="reader-toc-empty">这份 PDF 暂无章节目录。</div>
              )}
            </aside>
            <main className={css.stage}>
              {rendering && <div className={css.hint} data-testid="reader-loading">正在渲染第 {page} 页…</div>}
              {pageError && <div className={css.errorBox} data-testid="reader-page-error">{pageError}</div>}
              {pageUrl && (
                <button className={css.pageBtn} data-testid="reader-page" onClick={() => { viewerOpenRef.current = true; setViewerUrl(pageUrl) }}>
                  <img className={css.pageImg} data-testid="reader-page-img" src={pageUrl} alt={'第 ' + page + ' 页'} />
                </button>
              )}
            </main>
          </>
        )}
      </div>
      <div className={css.navBar}>
        <button className={css.navBtn} data-testid="reader-prev" disabled={page <= 1} onClick={() => go(page - 1, pageCount)}>上一页</button>
        <div className={css.counter}>
          <input className={css.pageInput} data-testid="reader-page-input" inputMode="numeric" aria-label="当前页码" value={pageInput}
            onChange={e => setPageInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitPageInput() } }} />
          <span className={css.counterTotal}>/ {pageCount}</span>
        </div>
        <button className={css.navBtn} data-testid="reader-next" disabled={pageCount === 0 || page >= pageCount} onClick={() => go(page + 1, pageCount)}>下一页</button>
      </div>
      {viewerUrl && (
        <ZoomableImageDialog
          src={viewerUrl}
          alt=""
          resetKey={page}
          onClose={() => { viewerOpenRef.current = false; setViewerUrl(null) }}
          labels={{ close: '关闭', dialog: 'PDF 页面查看' }}
        />
      )}
    </div>
  )
}

function TocRow({ node, depth, state, onOpen, onToggle }: { node: ChapterNode; depth: number; state: TocTreeState; onOpen: (n: ChapterNode) => void; onToggle: (n: ChapterNode) => void }) {
  const hasKids = node.children.length > 0
  const expanded = state.expanded.has(node.id)
  const leafSelectable = node.selectable && node.startPage != null
  return (
    <div className={css.tocNodeWrap} style={{ paddingLeft: 6 + depth * 14 }}>
      {hasKids ? (
        <button type="button" className={css.tocChevronBtn} data-testid={'reader-toc-toggle-' + node.id} aria-label={expanded ? '收起' : '展开'} onClick={() => onToggle(node)}>{expanded ? '▾' : '▸'}</button>
      ) : <span className={css.tocChevron} aria-hidden />}
      <button
        type="button"
        className={css.tocRow}
        data-testid={'reader-chapter-' + node.id}
        onClick={() => onOpen(node)}
      >
        <span className={css.tocText}>{node.title}</span>
        {leafSelectable && <span className={css.tocRange}>{node.startPage}</span>}
      </button>
      {hasKids && expanded && node.children.map(c => <TocRow key={c.id} node={c} depth={depth + 1} state={state} onOpen={onOpen} onToggle={onToggle} />)}
    </div>
  )
}
