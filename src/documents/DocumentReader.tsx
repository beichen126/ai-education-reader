// Document Reader (Stage 9.2B1 / 9.2B1.1): full-document reading space backed by an
// explicit PDF session (never the PdfPanel singleton). Lifecycle contract:
// the [docId] load effect OWNS the session it opens and only closes its OWN
// session — reader→library, reader→closed and A→B all tear down via that effect
// cleanup (render generation invalidated, page URL revoked, viewer closed,
// progress flushed with the document id bound at call time). App-level unmount
// effect only keeps pagehide/visibility flush.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDocument, updateLastReadPage, updateDocumentChapters } from './document-service'
import { useSessions } from '../engine/sessions-store'
import { formatBytes } from '../storage/diagnostics'
import { addPdfContextToDraft } from '../pdf/pdf-context-draft'
import { renderPdfContextRanges, PdfContextRenderError, type ContextRenderProgress } from '../pdf/pdf-context-render'
import { validatePdfRange, countPdfRangePages, needsPdfContextSoftConfirm, MAX_PDF_CONTEXT_PAGES, type PdfRange, type PdfSelection } from '../pdf/pdf-types'
import { findCurrentChapter, buildCurrentPageSelection, buildChapterSelection, buildManualRangeSelection } from './reader-context'
import { useDocumentUi, documentUiActions } from './document-ui-store'
import { clampReaderPage, parsePageInput } from './reader-utils'
import { openPdfSession, renderSessionPage, closePdfSession, readSessionOutline, pdfErrorMessage, type PdfSession } from '../pdf/pdf-session'
import { PdfError } from '../pdf/pdf-service'
import { ZoomableImageDialog } from '../gallery/ZoomableImageDialog'
import { createUrlOwner } from './url-owner'
import { ChapterBuilder, type ChapterBuilderSave } from './ChapterBuilder'
import { chaptersToEditableDraft } from './chapter-builder'
import { chapterNodesFromPdfOutline } from './chapter-model'
import type { ChapterDraftItem } from './chapter-builder'
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
  const [renderSize, setRenderSize] = useState<{ w: number; h: number } | null>(null)
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
  // ---- Reader -> Context bridge state (Stage 9.2B2) ----
  const conv = useSessions(s => s.byId[s.current || ''])
  const [ctxMenuOpen, setCtxMenuOpen] = useState(false)
  const [ctxMode, setCtxMode] = useState<'menu' | 'manual'>('menu')
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [ctxBusy, setCtxBusy] = useState(false)
  const [ctxProgress, setCtxProgress] = useState<ContextRenderProgress | null>(null)
  const [ctxMsg, setCtxMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [ctxPending, setCtxPending] = useState<ReaderContextRequest | null>(null)
  const ctxGenRef = useRef(0)
  const ctxMenuOpenRef = useRef(false); ctxMenuOpenRef.current = ctxMenuOpen
  // ---- Manual Chapter Builder (Stage 9.4A) ----
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderSeed, setBuilderSeed] = useState(false)
  const builderOpenRef = useRef(false); builderOpenRef.current = builderOpen
  // ---- Native TOC override (Stage 9.4A.2) ----
  const [nativeDraft, setNativeDraft] = useState<{ items: ChapterDraftItem[]; skipped: number } | null>(null)
  const [builderHint, setBuilderHint] = useState<string | null>(null)
  const [hasNativeOutline, setHasNativeOutline] = useState(false)
  const [nativeOutlineStatus, setNativeOutlineStatus] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null)
  const restoreBusyRef = useRef(false)

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
      ctxGenRef.current++ // any in-flight Reader Context generation becomes cancelled
      setCtxBusy(false); setCtxProgress(null); setCtxMsg(null)
      setCtxPending(null); setCtxMenuOpen(false); setCtxMode('menu'); setManualError(null)
      setBuilderOpen(false)
      sessionRef.current = null
      urlOwnerRef.current.revokeAll()
      setPageUrl(null); setRenderSize(null)
      setViewerUrl(null); viewerOpenRef.current = false
      setDoc(null); setPageCount(0); setPage(1); setPageInput('')
      setPageError(null); setRendering(false); setLoadError(null)
      setTocState({ expanded: new Set() }); setTocOpen(false)
      setNativeDraft(null); setBuilderHint(null); setHasNativeOutline(false); setNativeOutlineStatus('unknown')
      setRestoreConfirmOpen(false); setRestoreMsg(null)
      return
    }
    // Ownership contract: the effect remembers the documentId IT was created for.
    // React updates refs on render — a cleanup that reads docIdRef.current would
    // see the NEW document id after A->B / reader->closed and write A's page into B.
    const ownedDocId = docId
    let cancelled = false
    let ownedSession: PdfSession | null = null
    void (async () => {
      setLoadError(null); setDoc(null)
      setPageCount(0); setPage(1); setPageInput(''); setPageError(null)
      setTocState({ expanded: new Set() }); setTocOpen(false)
      setViewerUrl(null); viewerOpenRef.current = false
      setBuilderOpen(false)
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
        // Detect whether the ORIGINAL PDF has a native outline — ephemeral, used only
        // for the 整理/恢复 目录 UI. Reading must never fail because of this.
        setNativeOutlineStatus('unknown')
        try {
          const outline = await readSessionOutline(o.session)
          if (!cancelled) {
            setHasNativeOutline(outline.items.length > 0)
            setNativeOutlineStatus(outline.items.length > 0 ? 'yes' : 'no')
          }
        } catch {
          if (!cancelled) { setHasNativeOutline(false); setNativeOutlineStatus('unknown') }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof PdfError ? pdfErrorMessage(e.kind) : '无法打开这份文档。')
      }
    })()
    return () => {
      cancelled = true
      genRef.current++ // invalidate pending renders of THIS document immediately
      ctxGenRef.current++ // cancel any in-flight Reader Context generation (silent)
      setCtxBusy(false); setCtxProgress(null); setCtxMsg(null)
      setCtxPending(null); setCtxMenuOpen(false)
      // last meaningful page of the OWNED document — closure id, NEVER docIdRef
      if (ownedDocId) persist(ownedDocId, pageRef.current)
      if (ownedSession) { void closePdfSession(ownedSession) }
      if (sessionRef.current === ownedSession) sessionRef.current = null
      urlOwnerRef.current.revokeAll()
      setViewerUrl(null); viewerOpenRef.current = false
    }
  }, [docId, persist])

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
      setRenderSize({ w: r.width, h: r.height })
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

  // ---- Reader -> Context bridge (Stage 9.2B2 / 9.2B2.1) ----
  // TWO phases, no confirm loop: requestContext() snapshots the operation identity
  // and (for >30 pages) asks for approval ONCE; executeContext() runs the already
  // approved snapshot and NEVER asks again — approving a request re-executes the
  // SAME snapshot, never re-reads conv/doc/session/page.
  type ReaderContextRequest = {
    targetConversationId: string
    documentId: string
    fileName: string
    selection: PdfSelection
    ranges: PdfRange[]
    pageCount: number
    session: NonNullable<typeof sessionRef.current>
    count: number
  }
  const requestContext = useCallback((selection: PdfSelection, ranges: PdfRange[]) => {
    if (!doc || !sessionRef.current || ctxBusy) return
    const targetConversationId = conv?.id
    if (!targetConversationId) { setCtxMsg({ text: '请先创建一个会话。', ok: false }); return }
    const count = countPdfRangePages(ranges)
    if (count > MAX_PDF_CONTEXT_PAGES) {
      setCtxMsg({ text: '当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请选择较小的页码范围。', ok: false })
      return
    }
    const request: ReaderContextRequest = {
      targetConversationId, documentId: doc.id, fileName: doc.fileName,
      selection, ranges, pageCount,
      session: sessionRef.current,
      count,
    }
    setCtxMenuOpen(false); setCtxMode('menu'); setManualError(null)
    if (needsPdfContextSoftConfirm(count)) { setCtxPending(request); return }
    void executeContext(request)
  }, [doc, conv, ctxBusy, pageCount])

  const executeContext = useCallback(async (request: ReaderContextRequest) => {
    const gen = ++ctxGenRef.current
    setCtxBusy(true); setCtxMsg(null); setCtxProgress({ done: 0, total: request.count, bytes: 0 })
    setCtxPending(null)
    try {
      const { pages } = await renderPdfContextRanges({
        ranges: request.ranges, pageCount: request.pageCount,
        renderPage: (n) => renderSessionPage(request.session, n),
        onProgress: (p) => { if (gen === ctxGenRef.current) setCtxProgress(p) },
        isCancelled: () => gen !== ctxGenRef.current,
      })
      if (gen !== ctxGenRef.current) return // cancelled during render -> silent
      // Commit boundary: once all pages rendered, let the atomic attach complete
      // even if the user left meanwhile (no partial attachments); only the UI
      // message is suppressed after a cancel.
      const res = await addPdfContextToDraft(request.targetConversationId, { documentId: request.documentId, fileName: request.fileName, selection: request.selection, pages })
      if (gen !== ctxGenRef.current) return
      const label = request.selection.title ? '已加入「' + request.selection.title + '」· ' + res.count + ' 页' : '已加入当前对话 · ' + res.count + ' 页'
      setCtxMsg(res.ok ? { text: label, ok: true } : { text: res.error, ok: false })
    } catch (e) {
      if (gen !== ctxGenRef.current) return
      setCtxMsg({ text: e instanceof PdfContextRenderError ? e.message : '无法生成上下文。', ok: false })
    } finally {
      if (gen === ctxGenRef.current) { setCtxBusy(false); setCtxProgress(null) }
    }
  }, [])

  const confirmContext = () => {
    if (!ctxPending) return
    const request = ctxPending
    setCtxPending(null)
    void executeContext(request)
  }
  const commitManualRange = () => {
    const v = validatePdfRange(manualStart, manualEnd, pageCount)
    if (v) { setManualError(v); return }
    setManualError(null)
    const s = Number(manualStart.trim()), e = Number(manualEnd.trim())
    const sel = buildManualRangeSelection(s, e)
    void requestContext(sel, sel.ranges)
  }

  // ---- Save the manual chapter tree: persist once, then refresh from IDB so the
  // Reader TOC updates immediately. The current page is NEVER re-seeked (a builder
  // save is not re-opening the Reader). ----
  const saveBuilder = useCallback(async (save: ChapterBuilderSave) => {
    // Test seam (Stage 9.4A.1): e2e sets this to verify a failed save keeps the
    // Builder open, preserves the draft and shows an error. Never set in prod.
    const w = window as unknown as { __dshFailNextChapterSave?: boolean }
    if (w.__dshFailNextChapterSave) { w.__dshFailNextChapterSave = false; throw new Error('simulated chapter save failure') }
    if (!doc) throw new Error('no document')
    // A failed persist MUST propagate to the Builder (stays open, draft kept, error shown).
    await updateDocumentChapters(doc.id, save.chapters, save.source)
    // Refresh the tree so the TOC updates immediately. Page state is local and
    // untouched by setDoc, so the current page is preserved (never re-seeked).
    let fresh
    try { fresh = await getDocument(doc.id) } catch { fresh = undefined }
    if (fresh) {
      setDoc(fresh)
      setTocState(prev => ({ expanded: prev.expanded }))
    }
    // Close ONLY after the write succeeded.
    setBuilderOpen(false)
    setNativeDraft(null); setBuilderHint(null)
  }, [doc])

  // ---- Native TOC override (Stage 9.4A.2): 整理目录 / 编辑目录 / 恢复原始目录 ----
  // 整理目录: copy the CURRENT persisted (native) tree into an editable draft. The
  // original PDF native outline is NEVER mutated — it lives in sourceBlob.
  const openOrganizeNative = useCallback(() => {
    if (!doc) return
    const { items, skippedUnresolved } = chaptersToEditableDraft(doc.chapters)
    setNativeDraft({ items, skipped: skippedUnresolved })
    setBuilderHint('正在整理 PDF 原始目录。保存后仅修改本地目录，不会改动原 PDF。')
    setBuilderSeed(false)
    setBuilderOpen(true)
  }, [doc])
  // 编辑目录: edit the current (manual override) tree in place — no native origin hint.
  const openEditCurrent = useCallback(() => {
    if (!doc) return
    const { items, skippedUnresolved } = chaptersToEditableDraft(doc.chapters)
    setNativeDraft({ items, skipped: skippedUnresolved })
    setBuilderHint(null)
    setBuilderSeed(false)
    setBuilderOpen(true)
  }, [doc])
  // Restore original native outline: re-read the PDF sourceBlob outline (never a
  // persisted snapshot) and replace the current chapters. All-or-nothing.
  const restoreNative = useCallback(async () => {
    if (!doc || restoreBusyRef.current) return
    restoreBusyRef.current = true
    setRestoreMsg(null)
    try {
      // Test seam (Stage 9.4A.2): e2e sets this to verify a failed restore keeps the
      // current (manual) tree and reports an error. Never set in prod.
      const w = window as unknown as { __dshFailNextNativeRestore?: boolean }
      if (w.__dshFailNextNativeRestore) { w.__dshFailNextNativeRestore = false; throw new Error('simulated native restore failure') }
      const session = sessionRef.current
      if (!session) { setRestoreMsg('无法读取 PDF 原始目录，当前整理结果未发生变化。'); return }
      const outline = await readSessionOutline(session)
      if (outline.items.length === 0) { setRestoreMsg('无法读取 PDF 原始目录，当前整理结果未发生变化。'); return }
      const nativeTree = chapterNodesFromPdfOutline(outline.items)
      await updateDocumentChapters(doc.id, nativeTree, 'native')
      const fresh = await getDocument(doc.id)
      if (fresh) { setDoc(fresh); setTocState(prev => ({ expanded: prev.expanded })) }
      setRestoreConfirmOpen(false)
    } catch {
      setRestoreMsg('无法读取 PDF 原始目录，当前整理结果未发生变化。')
    } finally {
      restoreBusyRef.current = false
    }
  }, [doc])

  // ---- keyboard: arrows page, Escape closes (viewer gets priority) ----
  useEffect(() => {
    if (!doc) return
    const onKey = (e: KeyboardEvent) => {
      if (viewerOpenRef.current) return
      // Chapter Builder owns keyboard priority while open — no page-turning.
      if (builderOpenRef.current) return
      // Restore-original confirm: Escape cancels it, never closes the Reader.
      if (restoreConfirmOpen && e.key === 'Escape') { e.preventDefault(); setRestoreConfirmOpen(false); return }
      const t = document.activeElement as HTMLElement | null
      // Context menu takes Escape ONLY — arrows / typing / everything else pass through.
      if (ctxMenuOpenRef.current && e.key === 'Escape') { e.preventDefault(); setCtxMenuOpen(false); setCtxMode('menu'); return }
      // Page-input editing defers ARROWS only; Escape always closes the reader.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && e.key !== 'Escape') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(pageRef.current - 1, pageCount) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(pageRef.current + 1, pageCount) }
      else if (e.key === 'Escape') { documentUiActions.close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, pageCount, go, restoreConfirmOpen])

  const commitPageInput = () => {
    const r = parsePageInput(pageInput, pageCount)
    if (r.ok === false) { setPageError(r.error); return }
    setPageError(null); skipFirstProgressRef.current = false
    setPage(r.page); setPageInput(String(r.page))
  }

  if (ui.view !== 'reader') return null
  const currentChapter = doc ? findCurrentChapter(doc.chapters, page) : null
  const toggleTocNode = (n: ChapterNode) => setTocState(prev => { const e = new Set(prev.expanded); if (e.has(n.id)) e.delete(n.id); else e.add(n.id); return { expanded: e } })
  const clickChapter = (n: ChapterNode) => {
    if (n.selectable && n.startPage != null) { go(n.startPage, pageCount); setTocOpen(false) }
    else if (n.children.length > 0) toggleTocNode(n)
  }

  return (
    <div className={css.overlay} data-testid="document-reader">
      <div className={css.topbar}>
        <button className={css.backBtn} data-testid="reader-back" onClick={() => { documentUiActions.backToLibrary() }}>← 文件</button>
        <span className={css.title} data-testid="reader-title">{doc ? doc.fileName : '…'}</span>
        <div className={css.topActions}>
          {doc && (
            <button className={css.ctxBtn} data-testid="reader-ctx-toggle" aria-label="加入对话" title="加入对话" disabled={ctxBusy} onClick={() => setCtxMenuOpen(o => !o)}>
              {ctxBusy ? '处理中' : '加入对话'}
            </button>
          )}
          {doc && doc.chapterSource !== 'native' && (
            <button className={css.buildBtn} data-testid="reader-build" title="从此页新建章节" onClick={() => { setBuilderSeed(true); setBuilderOpen(true) }}>从此页新建章节</button>
          )}
          <button className={css.tocToggle} data-testid="reader-toc-toggle" onClick={() => setTocOpen(o => !o)}>目录</button>
          <button className={css.closeBtn} data-testid="reader-close" onClick={() => { documentUiActions.close() }}>关闭</button>
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
                <div className={css.tocEmpty}>
                  <div data-testid="reader-toc-empty">这份 PDF 暂无章节目录。</div>
                  <button type="button" className={css.tocCreate} data-testid="reader-toc-create" onClick={() => { setBuilderSeed(false); setBuilderOpen(true) }}>创建章节</button>
                </div>
              )}
              {doc && doc.chapterSource !== 'none' && (
                <div className={css.tocActions}>
                  {doc.chapterSource === 'native' && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-organize" onClick={openOrganizeNative}>整理目录</button>
                  )}
                  {doc.chapterSource !== 'native' && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-edit" onClick={openEditCurrent}>编辑目录</button>
                  )}
                  {doc.chapterSource !== 'native' && hasNativeOutline && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-restore" onClick={() => setRestoreConfirmOpen(true)}>恢复原始目录</button>
                  )}
                </div>
              )}
              {restoreMsg && <div className={css.tocRestoreMsg} data-testid="reader-toc-restore-msg">{restoreMsg}</div>}
            </aside>
            <main className={css.stage}>
              {rendering && <div className={css.hint} data-testid="reader-loading">正在渲染第 {page} 页…</div>}
              {pageError && <div className={css.errorBox} data-testid="reader-page-error">{pageError}</div>}
              {pageUrl && (
                <button className={css.pageBtn} data-testid="reader-page" onClick={() => { viewerOpenRef.current = true; setViewerUrl(pageUrl) }}>
                  <img className={css.pageImg} data-testid="reader-page-img" src={pageUrl} alt={'第 ' + page + ' 页'} data-render-width={renderSize ? String(renderSize.w) : undefined} data-render-height={renderSize ? String(renderSize.h) : undefined} />
                </button>
              )}
            </main>
          </>
        )}
      </div>
      {ctxMenuOpen && !ctxBusy && (
        <div className={css.ctxMenu} data-testid="reader-ctx-menu">
          <div className={css.ctxMenuTitle}>加入对话</div>
          <button type="button" className={css.menuItem} data-testid="reader-ctx-current-page" onClick={() => { const s = buildCurrentPageSelection(page); void requestContext(s, s.ranges) }}>
            当前页<span className={css.menuMeta}>第 {page} 页</span>
          </button>
          <button type="button" className={css.menuItem} data-testid="reader-ctx-current-chapter" disabled={!currentChapter} onClick={() => { if (!currentChapter) return; const s = buildChapterSelection(currentChapter); void requestContext(s, s.ranges) }}>
            当前章节{currentChapter && <span className={css.menuMeta}>{currentChapter.title} · PDF {currentChapter.startPage}–{currentChapter.endPage}</span>}
          </button>
          {doc && !currentChapter && <div className={css.ctxHint}>当前页不属于可识别章节</div>}
          <button type="button" className={css.menuItem} data-testid="reader-ctx-manual" onClick={() => { setCtxMode('manual'); setManualError(null) }}>自选页码</button>
          {ctxMode === 'manual' && (
            <div className={css.ctxForm} data-testid="reader-ctx-manual-form">
              <div className={css.ctxFormRow}>
                <label>开始页</label><input className={css.ctxInput} data-testid="reader-ctx-start" inputMode="numeric" value={manualStart} onChange={e => setManualStart(e.target.value)} />
                <label>结束页</label><input className={css.ctxInput} data-testid="reader-ctx-end" inputMode="numeric" value={manualEnd} onChange={e => setManualEnd(e.target.value)} />
              </div>
              {manualError && <div className={css.ctxHint} data-testid="reader-ctx-manual-error">{manualError}</div>}
              <button type="button" className={css.menuItem} data-testid="reader-ctx-go" onClick={commitManualRange}>确认加入</button>
            </div>
          )}
          <button type="button" className={css.menuClose} onClick={() => { setCtxMenuOpen(false); setCtxMode('menu') }}>收起</button>
        </div>
      )}
      {ctxPending && (
        <div className={css.ctxConfirm} data-testid="reader-ctx-confirm">
          <div>本次将处理 {ctxPending.count} 页。</div>
          <div className={css.ctxHint}>大范围 PDF 会占用更多本地处理时间和模型视觉上下文。</div>
          <div className={css.ctxConfirmBtns}>
            <button className={css.ctxPrimary} data-testid="reader-ctx-confirm-yes" onClick={confirmContext}>继续加入 {ctxPending.count} 页</button>
            <button className={css.ctxSecondary} data-testid="reader-ctx-confirm-no" onClick={() => setCtxPending(null)}>取消</button>
          </div>
        </div>
      )}
      {ctxBusy && ctxProgress && (
        <div className={css.ctxProgress} data-testid="reader-ctx-progress">正在准备上下文 {ctxProgress.done} / {ctxProgress.total} 页 · {formatBytes(ctxProgress.bytes)}</div>
      )}
      {ctxMsg && (
        <div className={css.ctxMsg + (ctxMsg.ok ? ' ' + css.ctxMsgOk : '')} data-testid="reader-ctx-msg">
          <span>{ctxMsg.text}</span>
          {ctxMsg.ok && <button className={css.ctxSecondary} data-testid="reader-ctx-back" onClick={() => { documentUiActions.close() }}>返回对话</button>}
        </div>
      )}
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
      {builderOpen && doc && (
        <ChapterBuilder
          pageCount={doc.pageCount}
          initialChapters={doc.chapters}
          currentPage={page}
          seedFromCurrentPage={builderSeed}
          draftSeed={nativeDraft ? nativeDraft.items : undefined}
          skippedUnresolved={nativeDraft ? nativeDraft.skipped : 0}
          hint={builderHint || undefined}
          onSave={saveBuilder}
          onClose={() => { setBuilderOpen(false); setBuilderSeed(false); setNativeDraft(null); setBuilderHint(null) }}
        />
      )}
      {restoreConfirmOpen && (
        <div className={css.restoreConfirm} data-testid="reader-restore-confirm">
          <div className={css.restoreConfirmBox}>
            <div>恢复 PDF 原始目录后，你当前整理的目录将被替换。确认恢复？</div>
            <div className={css.restoreConfirmBtns}>
              <button type="button" className={css.tocSecondary} data-testid="reader-restore-no" onClick={() => setRestoreConfirmOpen(false)}>取消</button>
              <button type="button" className={css.tocPrimary} data-testid="reader-restore-yes" onClick={() => void restoreNative()}>确认恢复</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TocRow({ node, depth, state, onOpen, onToggle }: { node: ChapterNode; depth: number; state: TocTreeState; onOpen: (n: ChapterNode) => void; onToggle: (n: ChapterNode) => void }) {
  const hasKids = node.children.length > 0
  const expanded = state.expanded.has(node.id)
  const leafSelectable = node.selectable && node.startPage != null
  // TOC layout (Stage 9.4A.2): each chapter node is a VERTICAL block. Its row (chevron
  // + title + page) is a single flex row that spans the full available width; children
  // render BELOW the row in their own vertical container — never as sibling flex items
  // of the row (which squeezes long Chinese titles into character-by-character wrapping
  // and forces horizontal overflow). Indent is bounded left padding only.
  const indent = Math.min(depth * 12, 96)
  return (
    <div className={css.tocNode} style={{ paddingLeft: indent }}>
      <div className={css.tocNodeWrap} data-testid={'reader-toc-node-' + node.id}>
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
      </div>
      {hasKids && expanded && (
        <div className={css.tocChildren}>
          {node.children.map(c => <TocRow key={c.id} node={c} depth={depth + 1} state={state} onOpen={onOpen} onToggle={onToggle} />)}
        </div>
      )}
    </div>
  )
}
