// Document Reader (Stage 9.2B1 / 9.2B1.1): full-document reading space backed by an
// explicit PDF session (never the PdfPanel singleton). Lifecycle contract:
// the [docId] load effect OWNS the session it opens and only closes its OWN
// session — reader→library, reader→closed and A→B all tear down via that effect
// cleanup (render generation invalidated, page URL revoked, viewer closed,
// progress flushed with the document id bound at call time). App-level unmount
// effect only keeps pagehide/visibility flush.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getDocument, getDocumentRecordMeta, getDocumentBinary, updateLastReadPage, updateDocumentChapters, DocumentBinaryMissingError } from './document-service'
import { getDocumentNote, saveDocumentNote } from './document-note-service'
import { useSessions, getSessionsCurrent, sessionsActions } from '../engine/sessions-store'
import { listConversations } from '../storage/storage'
import { allBranches } from '../branches/branch-store'
import { listStudyCardsByDocumentPage, type StudyCard } from '../study-cards/study-card-service'
import { learningUiActions } from '../study-cards/learning-ui-store'
import { formatBytes } from '../storage/diagnostics'
import { addPdfContextToDraft } from '../pdf/pdf-context-draft'
import { renderPdfContextRanges, PdfContextRenderError, type ContextRenderProgress } from '../pdf/pdf-context-render'
import { validatePdfRange, countPdfRangePages, needsPdfContextSoftConfirm, MAX_PDF_CONTEXT_PAGES, type PdfRange, type PdfSelection } from '../pdf/pdf-types'
import { findCurrentChapter, buildCurrentPageSelection, buildChapterSelection, buildManualRangeSelection, applyBookmarkRangePreferenceDelta, type BookmarkRangePreferenceDelta } from './reader-context'
import { findCurrentChapterPath } from './document-context'
import { bookmarkRangeEndModeOf } from './bookmark-range-preferences'
import { bookmarkRangePresentation } from '../pdf/bookmark-range'
import { DocumentContextPicker } from './DocumentContextPicker'
import { executeDocumentContext } from './document-context-service'
import { useDocumentUi, documentUiActions } from './document-ui-store'
import { clampReaderPage, parsePageInput } from './reader-utils'
import { openPdfSession, closePdfSession, readSessionOutline, readSessionPageLabels, pdfErrorMessage, type PdfSession } from '../pdf/pdf-session'
import { isZoomStale } from './use-reader-display'
import { usePdfViewport } from './pdf-viewport'
import { PdfError } from '../pdf/pdf-service'
import { ZoomableImageDialog } from '../gallery/ZoomableImageDialog'
import { createUrlOwner } from './url-owner'
import { ChapterBuilder, type ChapterBuilderSave } from './ChapterBuilder'
import { chaptersToEditableDraft } from './chapter-builder'
import { chapterNodesFromPdfOutline } from './chapter-model'
import type { ChapterDraftItem } from './chapter-builder'
import { TocPagePicker } from './TocPagePicker'
import { TocReview, type TocReviewSave } from './TocReview'
import { extractAiToc, type AiTocProgress } from './use-ai-toc-extraction'
import { exportBookmarkedPdf, PdfOutlineError } from '../export/index'
import { AiTocProgressDialog } from './AiTocProgressDialog'
import { getSettingsSnapshot, useSettings } from '../engine/settings-store'
import type { MappedTocItem } from './toc-mapping'
import type { LearningDocument, ChapterNode } from './document-types'
import { getUiLanguage, localizedConversationTitle, localizedErrorText, localizedStudyCardTitle, tx } from '../engine/locale'
import { findConversationsByDocumentPage, type PdfPageConversationHit } from '../pdf/pdf-page-conversations'
import { flushNoteEditorSession, type NoteEditorSession } from './note-session'
import { NoteAvailabilityGate, NoteReadCache, noteAvailabilityFrom, noteHasContent, noteKey, notePersistedState, type NoteAvailability } from './note-availability'
import { ReaderProgressController } from './reader-progress-controller'
import { createPdfPerformanceTelemetry, type PdfPerformanceTelemetry } from './pdf-performance-telemetry'
import { READER_ZOOM_MAX, READER_ZOOM_MIN, clampReaderZoom, readerZoomFromWheel, stepReaderZoom } from './reader-zoom'
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
  const pdfNavigationMode = useSettings(s => s.pdfNavigationMode)
  const docId = ui.view === 'reader' ? ui.documentId : null
  const readerRequestId = ui.view === 'reader' ? ui.requestId : 0
  const requestedPage = ui.view === 'reader' ? ui.pageNumber : undefined
  const [doc, setDoc] = useState<LearningDocument | null>(null)
  const [recordMeta, setRecordMeta] = useState<Awaited<ReturnType<typeof getDocumentRecordMeta>> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const sessionRef = useRef<PdfSession | null>(null)
  const [displaySession, setDisplaySession] = useState<PdfSession | null>(null)
  const [displayTelemetry, setDisplayTelemetry] = useState<PdfPerformanceTelemetry | null>(null)
  const outlineScheduleRef = useRef<(() => void) | null>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const urlOwnerRef = useRef(createUrlOwner())
  const [pageInput, setPageInput] = useState('')
  const [readerZoom, setReaderZoom] = useState(1)
  const readerZoomRef = useRef(1)
  const pendingReaderZoomRef = useRef<number | null>(null)
  const readerZoomFrameRef = useRef<number | null>(null)
  const readerZoomAnchorRef = useRef<{
    element: HTMLElement
    ratioX: number
    ratioY: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const pageInputRef = useRef<HTMLInputElement | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [progressError, setProgressError] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null)
  const [noteSaveError, setNoteSaveError] = useState(false)
  const [noteLoadError, setNoteLoadError] = useState(false)
  const [noteAvailability, setNoteAvailability] = useState<NoteAvailability>({ kind: 'loading', key: '' })
  const [noteReadAttempt, setNoteReadAttempt] = useState(0)
  const [noteWriteEnabled, setNoteWriteEnabled] = useState(false)
  const [noteActionBusy, setNoteActionBusy] = useState(false)
  const noteSessionRef = useRef<NoteEditorSession | null>(null)
  const noteCacheRef = useRef(new NoteReadCache(getDocumentNote))
  const noteFlushBarrierRef = useRef<Promise<void>>(Promise.resolve())
  const noteGenerationRef = useRef(new NoteAvailabilityGate())
  const noteToggleRef = useRef<HTMLButtonElement | null>(null)
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null)
  const currentNoteKey = docId && doc ? noteKey(docId, page) : null
  const [zoomBusy, setZoomBusy] = useState(false)
  // ---- Reader正文 display path (Agent C): direct visible canvas, no JPEG Blob on the
  //      main reading pipeline. The hook owns viewport-aware scaling, caching, prefetch,
  //      real RenderTask cancellation, and the on-demand zoom Blob. ----
  const onFirstPixelReady = useCallback(() => {
    const schedule = outlineScheduleRef.current
    outlineScheduleRef.current = null
    schedule?.()
  }, [])
  const [tocState, setTocState] = useState<TocTreeState>({ expanded: new Set() })
  const [tocOpen, setTocOpen] = useState(false)
  const [tocPanelClosed, setTocPanelClosed] = useState(false)
  const tocToggleRef = useRef<HTMLButtonElement | null>(null)
  const tocPanelRef = useRef<HTMLElement | null>(null)
  const tocBackRef = useRef<HTMLButtonElement | null>(null)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [viewerPage, setViewerPage] = useState(1)
  const viewerOpenRef = useRef(false)
  const genRef = useRef(0)
  // Zoom ownership token (Agent G, G1): a full-res zoom Blob render is bound to the navigation
  // context captured when requested (doc + page + session). Any page turn / doc switch / reader
  // close / a newer zoom invalidates it, so a stale render can never open for a page the user
  // already left, and its object URL is released immediately instead of leaking.
  const zoomGenRef = useRef(0)
  const pageRef = useRef(1); pageRef.current = page
  const docIdRef = useRef<string | null>(null); docIdRef.current = docId
  const progressRef = useRef<ReaderProgressController | null>(null)
  if (progressRef.current === null) {
    progressRef.current = new ReaderProgressController(updateLastReadPage, {
      onStateChange: state => setProgressError(state.lastError ?? null),
    })
  }
  // ---- Reader -> Context bridge state (Stage 9.2B2) ----
  const conv = useSessions(s => s.byId[s.current || ''])
  const [ctxMenuOpen, setCtxMenuOpen] = useState(false)
  const [ctxMode, setCtxMode] = useState<'menu' | 'manual'>('menu')
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [ctxBusy, setCtxBusy] = useState(false)
  const [ctxPickerOpen, setCtxPickerOpen] = useState(false)
  const [ctxRunning, setCtxRunning] = useState<{ total: number; done: number } | null>(null)
  const [ctxProgress, setCtxProgress] = useState<ContextRenderProgress | null>(null)
  const [ctxMsg, setCtxMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [relatedConversations, setRelatedConversations] = useState<PdfPageConversationHit[]>([])
  const [relatedOpen, setRelatedOpen] = useState(false)
  const [relatedError, setRelatedError] = useState<string | null>(null)
  const [ctxPending, setCtxPending] = useState<ReaderContextRequest | null>(null)
  const ctxGenRef = useRef(0)
  const ctxMenuOpenRef = useRef(false); ctxMenuOpenRef.current = ctxMenuOpen
  // ---- Manual Chapter Builder (Stage 9.4A) ----
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderSaveSource, setBuilderSaveSource] = useState<'manual' | 'ai-toc'>('manual')
  const builderOpenRef = useRef(false); builderOpenRef.current = builderOpen
  // ---- Native TOC override (Stage 9.4A.2) ----
  const [nativeDraft, setNativeDraft] = useState<{ items: ChapterDraftItem[]; skipped: number } | null>(null)
  const [builderHint, setBuilderHint] = useState<string | null>(null)
  const [hasNativeOutline, setHasNativeOutline] = useState(false)
  const [nativeOutlineStatus, setNativeOutlineStatus] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null)
  const restoreBusyRef = useRef(false)
  // ---- AI TOC (Stage 9.4B): picker -> vision extraction -> review draft ----
  const [tocPickerOpen, setTocPickerOpen] = useState(false)
  const [aiTocExtracting, setAiTocExtracting] = useState(false)
  const [aiTocMsg, setAiTocMsg] = useState<string | null>(null)
  const [aiTocItems, setAiTocItems] = useState<MappedTocItem[] | null>(null)
  const [aiTocWarning, setAiTocWarning] = useState<string | null>(null)
  // Finding 9.4D.2-0.6: AI TOC progress dialog state (real phase progress, hide/cancel/error/retry).
  const [aiTocProgress, setAiTocProgress] = useState<AiTocProgress | null>(null)
  const [aiTocDialogHidden, setAiTocDialogHidden] = useState(false)
  const [aiTocError, setAiTocError] = useState<string | null>(null)
  const [tocReviewOpen, setTocReviewOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const tocReviewOpenRef = useRef(false); tocReviewOpenRef.current = tocReviewOpen
  const aiTocGenRef = useRef(0)
  const aiTocAbortRef = useRef<AbortController | null>(null)
  const lastAiTocPagesRef = useRef<number[]>([])

  const writeNote = useCallback(async (targetDocId: string, targetPage: number, content: string) => {
    const saved = await saveDocumentNote(targetDocId, targetPage, content)
    noteCacheRef.current.remember(targetDocId, targetPage, saved)
    return saved
  }, [])

  const trackNoteFlush = useCallback((flush: Promise<void>): Promise<void> => {
    const barrier = noteFlushBarrierRef.current.catch(() => undefined).then(() => flush).catch(() => undefined)
    noteFlushBarrierRef.current = barrier
    return flush
  }, [])

  const flushNoteSession = useCallback((session: NoteEditorSession): Promise<void> => flushNoteEditorSession(session, writeNote, {
    onSaved: (savedSession, _attemptedContent, currentContent) => {
      if (noteSessionRef.current !== savedSession) return
      setNoteSaveError(false)
      setNoteLoadError(false)
      setNoteSavedAt(Date.now())
      if (currentContent) {
        const kind = noteHasContent(savedSession.text) ? 'existing' : 'empty'
        setNoteAvailability({ kind, key: savedSession.key })
      }
    },
    onError: (failedSession) => {
      if (noteSessionRef.current === failedSession) {
        setNoteSaveError(true)
        setNoteSavedAt(null)
        setNoteAvailability(prev => {
          const persisted = prev.key === failedSession.key
            ? (prev.kind === 'existing' || (prev.kind === 'error' && prev.persisted === 'existing') ? 'existing' : 'empty')
            : notePersistedState(noteCacheRef.current.peek(failedSession.documentId, failedSession.pageNumber))
          return { kind: 'error', key: failedSession.key, persisted }
        })
      }
    },
  }), [writeNote])

  const queueNoteSave = useCallback((session: NoteEditorSession) => {
    if (session.timer !== null) window.clearTimeout(session.timer)
    session.timer = window.setTimeout(() => {
      session.timer = null
      void flushNoteSession(session).catch(() => {})
    }, 450)
  }, [flushNoteSession])

  // Register a pending note write before a Reader transition commits. React's
  // passive effect cleanup still flushes as a backstop, and same-snapshot
  // flushes are deduplicated by note-session.
  const flushCurrentNote = useCallback((): Promise<void> => {
    const session = noteSessionRef.current
    if (!session) return Promise.resolve()
    const flush = trackNoteFlush(flushNoteSession(session))
    // Existing navigation/close call sites are intentionally fire-and-forget;
    // attaching this observer keeps a failed lifecycle flush observable to the
    // session without creating an unhandled rejection. The toggle awaits it.
    void flush.catch(() => {})
    return flush
  }, [flushNoteSession, trackNoteFlush])

  const isNarrowViewport = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
  const focusTocToggle = useCallback(() => {
    window.requestAnimationFrame(() => tocToggleRef.current?.focus())
  }, [])
  const focusTocBack = useCallback(() => {
    window.requestAnimationFrame(() => tocBackRef.current?.focus())
  }, [])
  const closeToc = useCallback(() => {
    setTocOpen(false)
    setTocPanelClosed(true)
    focusTocToggle()
  }, [focusTocToggle])
  const toggleToc = useCallback(() => {
    const narrow = isNarrowViewport()
    if (narrow) {
      const nextOpen = tocPanelClosed || !tocOpen
      setTocPanelClosed(false)
      setTocOpen(nextOpen)
      if (nextOpen) focusTocBack()
      else focusTocToggle()
      return
    }
    const nextOpen = tocPanelClosed
    setTocPanelClosed(!nextOpen)
    setTocOpen(nextOpen)
    if (nextOpen) focusTocBack()
    else focusTocToggle()
  }, [focusTocBack, focusTocToggle, tocOpen, tocPanelClosed])

  // ---- load document now OWNS the whole lifecycle for one docId ----
  useEffect(() => {
    if (!docId) {
      // Reader left (library / closed / switching): reset everything synchronously
      // so the previous document's page / image / TOC / viewer never leaks in.
      void progressRef.current?.release('close')
      genRef.current++ // any in-flight render of the old document becomes stale
      ctxGenRef.current++ // any in-flight Reader Context generation becomes cancelled
      setCtxBusy(false); setCtxProgress(null); setCtxMsg(null)
      setCtxPending(null); setCtxMenuOpen(false); setCtxMode('menu'); setManualError(null)
      setBuilderOpen(false)
      sessionRef.current = null
      setDisplaySession(null)
      setDisplayTelemetry(null)
      urlOwnerRef.current.revokeAll()
      setViewerUrl(null); setViewerPage(1); viewerOpenRef.current = false
      setZoomBusy(false)
      setDoc(null); setRecordMeta(null); setPageCount(0); setPage(1); setPageInput('')
      setPageError(null); setProgressError(null); setLoadError(null)
      setNotesOpen(false); setNoteText(''); setNoteLoading(false); setNoteSavedAt(null); setNoteSaveError(false); setNoteLoadError(false); setNoteWriteEnabled(false)
      setNoteAvailability({ kind: 'loading', key: '' })
      setTocState({ expanded: new Set() }); setTocOpen(false); setTocPanelClosed(false)
      setNativeDraft(null); setBuilderHint(null); setHasNativeOutline(false); setNativeOutlineStatus('unknown')
      setRestoreConfirmOpen(false); setRestoreMsg(null)
      aiTocAbortRef.current?.abort(); aiTocAbortRef.current = null
      aiTocGenRef.current++
      setTocPickerOpen(false); setAiTocExtracting(false); setAiTocMsg(null)
      setAiTocItems(null); setAiTocWarning(null); setTocReviewOpen(false)
      setAiTocProgress(null); setAiTocDialogHidden(false); setAiTocError(null); lastAiTocPagesRef.current = []
      return
    }
    // Ownership contract: the effect remembers the documentId IT was created for.
    // React updates refs on render — a cleanup that reads docIdRef.current would
    // see the NEW document id after A->B / reader->closed and write A's page into B.
    const ownedDocId = docId
    let cancelled = false
    let ownedSession: PdfSession | null = null
    let ownedProgressBinding: ReturnType<ReaderProgressController['bind']> | null = null
    let outlineTimer: number | null = null
    void (async () => {
      const telemetry = createPdfPerformanceTelemetry(ownedDocId, 'reader')
      telemetry.mark('reader-open-intent')
      setDisplayTelemetry(telemetry)
      setLoadError(null); setDoc(null); setRecordMeta(null)
      setPageCount(0); setPage(1); setPageInput(''); setPageError(null)
      setTocState({ expanded: new Set() }); setTocOpen(false); setTocPanelClosed(false)
      setViewerUrl(null); setViewerPage(1); viewerOpenRef.current = false
      setZoomBusy(false)
      setBuilderOpen(false)
      urlOwnerRef.current.revokeAll()
      sessionRef.current = null
      setDisplaySession(null)
      outlineScheduleRef.current = null
      aiTocAbortRef.current?.abort(); aiTocAbortRef.current = null
      aiTocGenRef.current++
      setTocPickerOpen(false); setAiTocExtracting(false); setAiTocMsg(null)
      setAiTocItems(null); setAiTocWarning(null); setTocReviewOpen(false)
      setAiTocProgress(null); setAiTocDialogHidden(false); setAiTocError(null); lastAiTocPagesRef.current = []
      try {
        const perfMode = (globalThis as typeof globalThis & { __dshPdfPerformanceMode?: 'legacy' | 'split' }).__dshPdfPerformanceMode ?? 'split'
        // Diagnostics-only legacy branch: it reproduces the pre-Stage-6 hydrated
        // getDocument() path so the benchmark can compare like-for-like in one build.
        const legacyDocument = perfMode === 'legacy' ? await getDocument(ownedDocId) : undefined
        const metaPromise = legacyDocument ? Promise.resolve(legacyDocument) : getDocumentRecordMeta(ownedDocId)
        // Start the binary read immediately. Metadata still resolves first for the
        // Reader shell, but the two independent storage reads no longer serialize.
        const binaryPromise = legacyDocument ? null : getDocumentBinary(ownedDocId)
        const meta = await metaPromise
        if (cancelled) return
        if (!meta) {
          await binaryPromise?.catch(() => undefined)
          setLoadError(tx('找不到这份文档。', 'This document could not be found.'))
          return
        }
        telemetry.mark('metadata-ready')
        setRecordMeta(meta)
        setPageCount(meta.pageCount)
        const start = clampReaderPage((requestedPage ?? meta.lastReadPage) || 1, meta.pageCount)
        setPage(start); setPageInput(String(start))
        const sourceBlob = legacyDocument?.sourceBlob ?? await binaryPromise!
        telemetry.mark('binary-ready')
        if (cancelled) return
        const o = await openPdfSession(sourceBlob)
        telemetry.mark('pdf-proxy-ready')
        if (cancelled) { void closePdfSession(o.session); return }
        const d: LearningDocument = { ...meta, sourceBlob }
        ownedSession = o.session
        sessionRef.current = o.session
        setDisplaySession(o.session)
        setDoc(d); setPageCount(d.pageCount)
        ownedProgressBinding = progressRef.current?.bind(ownedDocId, start) ?? null
        setProgressError(null)
        // Detect whether the ORIGINAL PDF has a native outline — ephemeral, used only
        // for the 整理/恢复 目录 UI. Reading must never fail because of this.
        setNativeOutlineStatus('unknown')
        const readOutline = () => {
          if (telemetry.snapshot()?.phases['first-pixel-ready'] === undefined) {
            outlineTimer = window.setTimeout(readOutline, 16)
            return
          }
          void readSessionOutline(o.session).then(outline => {
            telemetry.mark('outline-ready')
            if (!cancelled) {
              setHasNativeOutline(outline.items.length > 0)
              setNativeOutlineStatus(outline.items.length > 0 ? 'yes' : 'no')
            }
          }).catch(() => {
            telemetry.mark('outline-ready')
            if (!cancelled) { setHasNativeOutline(false); setNativeOutlineStatus('unknown') }
          })
        }
        const scheduleOutline = () => {
          // A late surface callback from a previous StrictMode/session render may
          // reach the current ref. Only this run's first-pixel mark may release
          // the outline, otherwise outline work can race ahead of the new page.
          if (cancelled || telemetry.snapshot()?.phases['first-pixel-ready'] === undefined) return
          const idle = (window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback
          outlineTimer = idle ? idle(readOutline, { timeout: 0 }) : window.setTimeout(readOutline, 0)
        }
        outlineScheduleRef.current = scheduleOutline
      } catch (e) {
        if (!cancelled) {
          if (e instanceof DocumentBinaryMissingError) setLoadError(tx('本地 PDF 文件数据已丢失，请重新导入。', 'The local PDF data is missing. Import the file again.'))
          else setLoadError(e instanceof PdfError ? pdfErrorMessage(e.kind) : tx('无法打开这份文档。', 'Unable to open this document.'))
        }
      }
    })()
    return () => {
      cancelled = true
      outlineScheduleRef.current = null
      if (outlineTimer !== null) {
        const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
        if (cancelIdle) cancelIdle(outlineTimer)
        else window.clearTimeout(outlineTimer)
      }
      genRef.current++ // invalidate pending renders of THIS document immediately
      ctxGenRef.current++ // cancel any in-flight Reader Context generation (silent)
      setCtxBusy(false); setCtxProgress(null); setCtxMsg(null)
      setCtxPending(null); setCtxMenuOpen(false)
      // Release the controller session owned by this document effect. The controller
      // keeps the closure-bound owner and serializes any pending write.
      if (ownedProgressBinding) void progressRef.current?.release('switch', ownedProgressBinding)
      aiTocAbortRef.current?.abort(); aiTocAbortRef.current = null
      aiTocGenRef.current++
      if (ownedSession) { void closePdfSession(ownedSession) }
      if (sessionRef.current === ownedSession) { sessionRef.current = null; setDisplaySession(null); setDisplayTelemetry(null) }
      urlOwnerRef.current.revokeAll()
      setViewerUrl(null); setViewerPage(1); viewerOpenRef.current = false
    }
  }, [docId, readerRequestId])

  // Page-note availability is preloaded even while the panel is closed. The
  // same cache/promise is consumed by the editor effect below, so the closed
  // label and textarea cannot race two independent reads.
  useEffect(() => {
    if (!docId || !doc || !currentNoteKey) {
      setNoteAvailability({ kind: 'loading', key: '' })
      return
    }
    const key = currentNoteKey
    const request = noteGenerationRef.current.begin(key)
    let cancelled = false
    setNoteAvailability({ kind: 'loading', key })
    const barrier = noteFlushBarrierRef.current
    void barrier.catch(() => undefined).then(() => noteCacheRef.current.read(docId, page)).then(note => {
      if (cancelled || !noteGenerationRef.current.accepts(request)) return
      setNoteAvailability(noteAvailabilityFrom(key, note))
    }).catch(() => {
      if (cancelled || !noteGenerationRef.current.accepts(request)) return
      const persisted = notePersistedState(noteCacheRef.current.peek(docId, page))
      setNoteAvailability({ kind: 'error', key, persisted })
    })
    return () => { cancelled = true }
  }, [currentNoteKey, noteReadAttempt])

  // Page notes are keyed by document + page. Loading is intentionally
  // independent from the PDF render so a slow note read never blocks page
  // navigation; page/doc transitions first wait on the previous session's
  // tracked flush barrier.
  useEffect(() => {
    const prior = noteSessionRef.current
    if (!docId || !doc || !currentNoteKey || !notesOpen) {
      if (prior) trackNoteFlush(flushNoteSession(prior))
      noteSessionRef.current = null
      setNoteLoading(false)
      setNoteWriteEnabled(false)
      if (!notesOpen) setNoteText('')
      return
    }
    let cancelled = false
    const key = currentNoteKey
    const session: NoteEditorSession = { documentId: docId, pageNumber: page, key, text: '', loaded: false, baseLoaded: false, writeEnabled: false, dirty: false, timer: null, lastSave: null }
    noteSessionRef.current = session
    setNoteLoading(true); setNoteSavedAt(null); setNoteSaveError(false); setNoteLoadError(false); setNoteWriteEnabled(false)
    setNoteText('')
    const barrier = noteFlushBarrierRef.current
    void barrier.catch(() => undefined).then(() => noteCacheRef.current.read(docId, page)).then(note => {
      if (cancelled || noteSessionRef.current !== session) return
      session.loaded = true
      session.baseLoaded = true
      session.writeEnabled = true
      setNoteWriteEnabled(true)
      if (!session.editedDuringLoad) {
        session.text = note && noteHasContent(note.content) ? note.content : ''
        setNoteText(session.text)
      }
    }).catch(() => {
      if (!cancelled && noteSessionRef.current === session) {
        session.loaded = false
        session.baseLoaded = false
        session.writeEnabled = false
        setNoteWriteEnabled(false)
        setNoteLoadError(true)
        if (!session.editedDuringLoad) { session.text = ''; setNoteText('') }
      }
    }).finally(() => { if (!cancelled && noteSessionRef.current === session) setNoteLoading(false) })
    return () => {
      cancelled = true
      trackNoteFlush(flushNoteSession(session))
      session.writeEnabled = false
      if (noteSessionRef.current === session) noteSessionRef.current = null
    }
  }, [docId, doc, currentNoteKey, page, notesOpen, flushNoteSession, trackNoteFlush])

  useEffect(() => {
    if (!notesOpen || noteLoading) return
    const focusTimer = window.setTimeout(() => noteInputRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [notesOpen, noteLoading, currentNoteKey])

  // Reverse provenance is a pure, ON-DEMAND query (Stage 2 §5.6): the reader does not
  // read conversations, branches or cards while the panel is closed, and a page turn only
  // ever re-queries the exact (documentId, page) pair the user is looking at.
  // Stage 7 splits the panel into two independent categories: 会话 and 学习卡片.
  const sessionsListRef = useSessions(s => s.list)
  const [relatedRevision, setRelatedRevision] = useState(0)
  const [relatedCards, setRelatedCards] = useState<StudyCard[]>([])
  const [relatedConvState, setRelatedConvState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [relatedCardState, setRelatedCardState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  useEffect(() => {
    if (!relatedOpen) return
    if (!docId || !doc) return
    let cancelled = false
    setRelatedError(null)
    const timer = window.setTimeout(() => {
      const targetPage = page
      const targetDocId = doc.id
      setRelatedConvState('loading')
      setRelatedCardState('loading')
      // One category failing never blocks the other.
      void Promise.all([listConversations(), allBranches()]).then(([conversations, branches]) => {
        if (cancelled) return
        setRelatedConversations(findConversationsByDocumentPage(targetDocId, targetPage, conversations, branches))
        setRelatedConvState('ready')
      }).catch(() => {
        if (cancelled) return
        setRelatedConversations([])
        setRelatedConvState('error')
        setRelatedError(tx('会话读取失败，可关闭面板后重试。', 'Unable to load chats. Close the panel and try again.'))
      })
      void listStudyCardsByDocumentPage(targetDocId, targetPage).then(cards => {
        if (cancelled) return
        setRelatedCards(cards)
        setRelatedCardState('ready')
      }).catch(() => {
        if (cancelled) return
        setRelatedCards([])
        setRelatedCardState('error')
      })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [relatedOpen, relatedRevision, docId, doc?.id, page, sessionsListRef])
  // Closing the panel drops the previous result; nothing is queried while it is closed.
  useEffect(() => {
    if (relatedOpen) return
    setRelatedConversations([])
    setRelatedError(null)
    setRelatedCards([])
    setRelatedConvState('idle')
    setRelatedCardState('idle')
  }, [relatedOpen])
  const openRelatedPanel = () => {
    setRelatedOpen(open => {
      if (!open) setRelatedRevision(value => value + 1)
      return !open
    })
  }
  const openRelatedCard = (card: StudyCard) => {
    const documentId = card.documentRefs.find(ref => ref.documentId)?.documentId ?? ''
    learningUiActions.openCard(card.id, {
      filter: documentId ? { kind: 'document', documentId } : { kind: 'all' },
      query: '',
      sort: 'created-desc',
      seed: 1,
      orderedIds: relatedCards.map(item => item.id),
    })
  }

  // ---- Invalidate any PENDING zoom render on navigation (Agent G, G2): every page turn / doc
  //      switch (and reader close) bumps the zoom generation, so a zoom that is still rendering
  //      never installs a Blob for a page the user already left. Installed zoom URLs are
  //      separately revoked in the docId effect cleanup / reader-close branch above. ----
  useEffect(() => { zoomGenRef.current++ }, [page, docId])
  useEffect(() => {
    pendingReaderZoomRef.current = null
    readerZoomRef.current = 1
    setReaderZoom(1)
  }, [docId])

  // ---- Reader正文 display render: now handled by useReaderDisplay (viewport-aware
  //      scale, real RenderTask cancel, bounded cache, neighbor prefetch). No JPEG Blob. ----

  // ---- progress observation is centralized in ReaderProgressController ----
  useEffect(() => {
    if (!docId || !doc) return
    progressRef.current?.observePage(page, 'navigation')
  }, [docId, doc?.id, page])

  // ---- App-level: use the same controller for hidden/pagehide flush ----
  useEffect(() => {
    const flush = () => { void progressRef.current?.flush('pagehide') }
    const onVis = () => { if (document.visibilityState === 'hidden') void progressRef.current?.flush('hidden') }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const go = useCallback((p: number, count: number) => {
    const next = clampReaderPage(p, count)
    flushCurrentNote()
    setPage(prev => prev === next ? prev : next)
    setPageInput(String(next))
  }, [flushCurrentNote])

  const display = usePdfViewport({
    session: displaySession,
    documentKey: docId,
    pageCount,
    currentPage: page,
    mode: pdfNavigationMode,
    telemetry: displayTelemetry,
    onCurrentPageChange: next => go(next, pageCount),
    onFirstPixelReady,
  })

  const captureReaderZoomAnchor = useCallback((element: HTMLElement, clientX?: number, clientY?: number) => {
    const rect = element.getBoundingClientRect()
    const offsetX = clientX == null ? element.clientWidth / 2 : Math.max(0, Math.min(element.clientWidth, clientX - rect.left))
    const offsetY = clientY == null ? element.clientHeight / 2 : Math.max(0, Math.min(element.clientHeight, clientY - rect.top))
    readerZoomAnchorRef.current = {
      element,
      ratioX: (element.scrollLeft + offsetX) / Math.max(1, element.scrollWidth),
      ratioY: (element.scrollTop + offsetY) / Math.max(1, element.scrollHeight),
      offsetX,
      offsetY,
    }
  }, [])

  const scheduleReaderZoom = useCallback((value: number, anchor?: { element: HTMLElement; clientX?: number; clientY?: number }) => {
    const next = clampReaderZoom(value)
    if (anchor) captureReaderZoomAnchor(anchor.element, anchor.clientX, anchor.clientY)
    pendingReaderZoomRef.current = next
    readerZoomRef.current = next
    if (readerZoomFrameRef.current !== null) return
    readerZoomFrameRef.current = window.requestAnimationFrame(() => {
      readerZoomFrameRef.current = null
      const pending = pendingReaderZoomRef.current
      pendingReaderZoomRef.current = null
      if (pending !== null) setReaderZoom(pending)
    })
  }, [captureReaderZoomAnchor])

  useEffect(() => () => {
    if (readerZoomFrameRef.current !== null) window.cancelAnimationFrame(readerZoomFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    const anchor = readerZoomAnchorRef.current
    readerZoomAnchorRef.current = null
    if (!anchor) return
    const frame = window.requestAnimationFrame(() => {
      const { element } = anchor
      if (!element.isConnected) return
      element.scrollLeft = anchor.ratioX * element.scrollWidth - anchor.offsetX
      element.scrollTop = anchor.ratioY * element.scrollHeight - anchor.offsetY
    })
    return () => window.cancelAnimationFrame(frame)
  }, [readerZoom])

  useEffect(() => {
    const stage = display.stageRef.current
    if (!stage || display.mode !== 'continuous') return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const current = pendingReaderZoomRef.current ?? readerZoomRef.current
      scheduleReaderZoom(readerZoomFromWheel(current, event.deltaY), {
        element: stage,
        clientX: event.clientX,
        clientY: event.clientY,
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [display.mode, display.stageRef, scheduleReaderZoom, docId])

  const openRelatedConversation = useCallback(async (hit: PdfPageConversationHit) => {
    flushCurrentNote()
    const opened = await sessionsActions.openAtMessage(hit.conversationId, hit.messageId, hit.branchId)
    if (!opened) { setRelatedError(tx('这条对话或消息已不存在。', 'This chat or message no longer exists.')); return }
    setRelatedOpen(false)
    documentUiActions.close()
  }, [flushCurrentNote])

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
    if (!targetConversationId) { setCtxMsg({ text: tx('请先创建一个会话。', 'Create a chat first.'), ok: false }); return }
    const count = countPdfRangePages(ranges)
    if (count > MAX_PDF_CONTEXT_PAGES) {
      setCtxMsg({ text: tx('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请选择较小的页码范围。', 'You can process up to ' + MAX_PDF_CONTEXT_PAGES + ' pages at a time. Select a smaller range.'), ok: false })
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
    // UNIFIED execution: Reader page/chapter/manual selection converges on the SAME
    // service as the shared picker (executeDocumentContext). The Reader passes its own
    // PdfSession as existingSession (never closed by the service). Staleness is tested
    // against the CURRENT active conversation (getSessionsCurrent), NOT a stale closure:
    // if the user switches conversation, the old operation cancels early and NEVER writes
    // into A or B (0.4 / 0.5).
    const ownedDocId = request.documentId
    const ownedConvId = request.targetConversationId
    const isCancelled = () => gen !== ctxGenRef.current
    const isStale = () => gen !== ctxGenRef.current || getSessionsCurrent() !== ownedConvId || docIdRef.current !== ownedDocId
    try {
      const res = await executeDocumentContext({
        targetConversationId: request.targetConversationId,
        documentId: request.documentId, fileName: request.fileName, pageCount: request.pageCount,
        selection: request.selection, existingSession: request.session,
        isCancelled, isStale,
        onProgress: (p) => { if (gen === ctxGenRef.current) setCtxProgress(p) },
      })
      if (gen !== ctxGenRef.current) return // cancelled / stale during render -> silent
      const label = request.selection.title ? tx('已加入「' + request.selection.title + '」· ' + res.count + ' 页', 'Added “' + request.selection.title + '” · ' + res.count + ' pages') : tx('已加入当前对话 · ' + res.count + ' 页', 'Added to current chat · ' + res.count + ' pages')
      if (!res.ok && res.error) setCtxMsg({ text: localizedErrorText(res.error, 'Unable to add the PDF context to the chat.'), ok: false })
      else if (res.ok) setCtxMsg({ text: label, ok: true })
    } catch (e) {
      if (gen !== ctxGenRef.current) return
      setCtxMsg({ text: e instanceof PdfContextRenderError ? localizedErrorText(e.message, 'Unable to build context.') : tx('无法生成上下文。', 'Unable to build context.'), ok: false })
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
  // Add a context from the shared picker using the Reader's OWN session (never closed).
  // Block 0.4: the Reader's generation token cancels any in-flight picker op when the
  // doc or conversation changes; a stale op NEVER writes into a different conversation.
  const addFromPicker = useCallback(async (selection: PdfSelection) => {
    if (!doc || !sessionRef.current || ctxBusy) return
    const targetConversationId = conv?.id
    if (!targetConversationId) { setCtxMsg({ text: tx('请先创建一个会话。', 'Create a chat first.'), ok: false }); return }
    const count = countPdfRangePages(selection.ranges)
    if (count > MAX_PDF_CONTEXT_PAGES) { setCtxMsg({ text: tx('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请选择较小的页码范围。', 'You can process up to ' + MAX_PDF_CONTEXT_PAGES + ' pages at a time. Select a smaller range.'), ok: false }); return }
    const ownedDocId = doc.id
    const ownedConvId = targetConversationId
    const gen = ++ctxGenRef.current
    setCtxBusy(true); setCtxRunning({ total: count, done: 0 }); setCtxMsg(null)
    const isCancelled = () => gen !== ctxGenRef.current
    const isStale = () => gen !== ctxGenRef.current || (docIdRef.current !== ownedDocId) || (getSessionsCurrent() !== ownedConvId)
    try {
      const res = await executeDocumentContext({ targetConversationId, documentId: doc.id, fileName: doc.fileName, pageCount, selection, existingSession: sessionRef.current, isCancelled, isStale, onProgress: (p) => { if (gen === ctxGenRef.current) setCtxRunning({ total: p.total, done: p.done }) } })
      if (gen !== ctxGenRef.current) return
      const label = selection.title ? tx('已加入「' + selection.title + '」· ' + res.count + ' 页', 'Added “' + selection.title + '” · ' + res.count + ' pages') : tx('已加入当前对话 · ' + res.count + ' 页', 'Added to current chat · ' + res.count + ' pages')
      setCtxMsg(res.ok ? { text: label, ok: true } : { text: localizedErrorText(res.error, 'Unable to add the PDF context to the chat.'), ok: false })
    } catch { if (gen === ctxGenRef.current) setCtxMsg({ text: tx('无法生成上下文。', 'Unable to build context.'), ok: false }) }
    finally { if (gen === ctxGenRef.current) { setCtxBusy(false); setCtxRunning(null) } }
  }, [doc, conv, ctxBusy, pageCount])

  const applyCommittedBookmarkRangePreferences = useCallback((delta: BookmarkRangePreferenceDelta) => {
    setDoc(current => applyBookmarkRangePreferenceDelta(current, delta))
  }, [])

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
    setBuilderHint(tx('正在整理 PDF 原始目录。保存后仅修改本地目录，不会改动原 PDF。', 'Organizing the original PDF outline. Saving changes only the local outline, not the PDF.'))
    setBuilderSaveSource('manual')
    setBuilderOpen(true)
  }, [doc])
  // 编辑目录: edit the current (manual override) tree in place — no native origin hint.
  const openEditCurrent = useCallback(() => {
    if (!doc) return
    const { items, skippedUnresolved } = chaptersToEditableDraft(doc.chapters)
    setNativeDraft({ items, skipped: skippedUnresolved })
    setBuilderHint(null)
    setBuilderSaveSource('manual')
    setBuilderOpen(true)
  }, [doc])
  // ---- AI TOC extraction runner (Stage 9.4C.1): snapshot -> vision -> mapped draft ----
  // Ownership: a NEW run aborts the previous one (same doc / A->B / reader close / unmount).
  // AiToc snapshot is taken ONCE at start; a stale result that resolves later never setState.
  const runAiToc = useCallback(async (selectedPages: number[]) => {
    const session = sessionRef.current
    if (!doc || !session) return
    aiTocAbortRef.current?.abort()
    const controller = new AbortController()
    aiTocAbortRef.current = controller
    setTocPickerOpen(false)
    setAiTocExtracting(true); setAiTocMsg(null); setAiTocWarning(null)
    setAiTocProgress(null); setAiTocDialogHidden(false); setAiTocError(null)
    lastAiTocPagesRef.current = selectedPages
    const gen = ++aiTocGenRef.current
    const ownedDocId = doc.id
    try {
      const s = getSettingsSnapshot()
      const res = await extractAiToc({
        session, pageCount, selectedPages,
        apiKey: s.apiKey, baseUrl: s.apiBaseUrl, model: s.model, visionCapability: s.visionCapability,
        getPageLabels: async () => readSessionPageLabels(session),
        signal: controller.signal,
        onProgress: (p) => { if (gen === aiTocGenRef.current) setAiTocProgress(p) },
      })
      if (gen !== aiTocGenRef.current || docIdRef.current !== ownedDocId) return
      if (!res.ok) { setAiTocError(localizedErrorText((res as { error: string }).error, 'Unable to detect the outline. Try again.')); return }
      setAiTocItems(res.items)
      setAiTocWarning(res.warning ? localizedErrorText(res.warning, 'Text was detected, but the hierarchy needs review before saving.') : null)
      setAiTocMsg(null); setAiTocError(null)
      setTocReviewOpen(true)
    } catch {
      if (gen === aiTocGenRef.current) setAiTocError(tx('目录识别失败，请重试。', 'Outline detection failed. Try again.'))
    } finally {
      if (gen === aiTocGenRef.current) setAiTocExtracting(false)
    }
  }, [doc, pageCount])

  // Progress dialog lifecycle (Finding 9.4D.2-0.6): hide keeps the operation running and
  // shows a Reader activity chip; cancel aborts (no review, no persistence, no object URL).
  const cancelAiToc = () => {
    aiTocAbortRef.current?.abort()
    setAiTocDialogHidden(false)
    setAiTocError(tx('已取消目录识别', 'Outline detection cancelled'))
    setAiTocExtracting(false)
  }
  const hideAiTocDialog = () => { setAiTocDialogHidden(true); setAiTocError(null) }
  const retryAiToc = () => { const p = lastAiTocPagesRef.current; if (p.length) void runAiToc(p) }

    // Export the CURRENT chapter tree as a real bookmark outline in a NEW PDF.
  const exportBookmarked = async () => {
    if (!doc) return
    setExportBusy(true); setExportMsg(null)
    try {
      await exportBookmarkedPdf({ id: doc.id, fileName: doc.fileName, pageCount: doc.pageCount, chapters: doc.chapters })
      setExportMsg(tx('已导出带目录 PDF', 'PDF with outline exported'))
    } catch (e) {
      setExportMsg(e instanceof PdfOutlineError ? e.message : tx('导出失败，请重试。', 'Export failed. Try again.'))
    } finally { setExportBusy(false) }
  }

    // 编辑全部目录: hand the reviewed rows to the existing ChapterBuilder (no second editor).
  const editAiTocAll = useCallback((rows: MappedTocItem[]) => {
    const items: ChapterDraftItem[] = rows
      .filter(r => r.startPage != null)
      .map((r, i) => ({ id: 'ai' + i, title: r.title, level: r.level, startPage: r.startPage as number }))
    setNativeDraft({ items, skipped: rows.filter(r => r.startPage == null).length })
    setBuilderHint(tx('正在编辑 AI 识别并已检查的目录。保存后仅修改本地目录，不会改动原 PDF。', 'Editing the reviewed AI-detected outline. Saving changes only the local outline, not the PDF.'))
    setBuilderSaveSource('ai-toc')
    setTocReviewOpen(false)
    setBuilderOpen(true)
  }, [])

  // Save the AI-reviewed draft as chapterSource 'ai-toc' — the ONLY persistence step.
  const saveAiToc = useCallback(async (save: TocReviewSave) => {
    if (!doc) throw new Error('no document')
    await updateDocumentChapters(doc.id, save.chapters, 'ai-toc')
    let fresh
    try { fresh = await getDocument(doc.id) } catch { fresh = undefined }
    if (fresh) { setDoc(fresh); setTocState(prev => ({ expanded: prev.expanded })) }
    setTocReviewOpen(false)
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
      if (!session) { setRestoreMsg(tx('无法读取 PDF 原始目录，当前整理结果未发生变化。', 'Unable to read the original PDF outline. Your current outline was not changed.')); return }
      const outline = await readSessionOutline(session)
      if (outline.items.length === 0) { setRestoreMsg(tx('无法读取 PDF 原始目录，当前整理结果未发生变化。', 'Unable to read the original PDF outline. Your current outline was not changed.')); return }
      const nativeTree = chapterNodesFromPdfOutline(outline.items)
      await updateDocumentChapters(doc.id, nativeTree, 'native')
      const fresh = await getDocument(doc.id)
      if (fresh) { setDoc(fresh); setTocState(prev => ({ expanded: prev.expanded })) }
      setRestoreConfirmOpen(false)
    } catch {
      setRestoreMsg(tx('无法读取 PDF 原始目录，当前整理结果未发生变化。', 'Unable to read the original PDF outline. Your current outline was not changed.'))
    } finally {
      restoreBusyRef.current = false
    }
  }, [doc])

  // ---- keyboard: arrows page, Escape closes (viewer gets priority) ----
  useEffect(() => {
    if (!doc) return
    const onKey = (e: KeyboardEvent) => {
      if (viewerOpenRef.current) return
      const t = document.activeElement as HTMLElement | null
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as HTMLElement).isContentEditable)
      // TOC Review / Chapter Builder are DOCKED on the left (item 6/11): the PDF stays
      // operable. Escape is owned by them (they close themselves / their confirm layer);
      // ArrowLeft/ArrowRight still page the PDF ONLY when focus is not in a text input
      // (so in-field text editing keeps its arrows). No double keyboard handler conflict.
      if (tocReviewOpenRef.current || builderOpenRef.current) {
        if (e.key === 'Escape') return
        if (inField) return
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(pageRef.current - 1, pageCount) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); go(pageRef.current + 1, pageCount) }
        return
      }
      // Restore-original confirm: Escape cancels it, never closes the Reader.
      if (restoreConfirmOpen && e.key === 'Escape') { e.preventDefault(); setRestoreConfirmOpen(false); return }
      // Context menu takes Escape ONLY — arrows / typing / everything else pass through.
      if (ctxMenuOpenRef.current && e.key === 'Escape') { e.preventDefault(); setCtxMenuOpen(false); setCtxMode('menu'); return }
      const tocVisible = !tocPanelClosed && (!isNarrowViewport() || tocOpen)
      if (tocVisible && e.key === 'Escape') {
        e.preventDefault()
        closeToc()
        return
      }
      if (tocVisible && isNarrowViewport() && e.key === 'Tab') {
        const panel = tocPanelRef.current
        if (panel) {
          const focusables = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length > 0)
          if (focusables.length > 0) {
            const first = focusables[0]
            const last = focusables[focusables.length - 1]
            if (!panel.contains(document.activeElement)) {
              e.preventDefault()
              ;(e.shiftKey ? last : first).focus()
            } else if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first.focus()
            }
          }
        }
      }
      // Page-input editing defers ARROWS only; Escape always closes the reader.
      if (inField && e.key !== 'Escape') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(pageRef.current - 1, pageCount) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(pageRef.current + 1, pageCount) }
      else if (e.key === 'Escape') { flushCurrentNote(); documentUiActions.close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeToc, doc, flushCurrentNote, go, pageCount, restoreConfirmOpen, tocOpen, tocPanelClosed])

  const commitPageInput = () => {
    const r = parsePageInput(pageInput, pageCount)
    if (r.ok === false) { setPageError(r.error); return }
    flushCurrentNote()
    setPageError(null)
    setPage(r.page); setPageInput(String(r.page))
  }

  const retryProgress = useCallback(() => {
    void progressRef.current?.retry()
  }, [])

  const currentNoteState: NoteAvailability = currentNoteKey && noteAvailability.key === currentNoteKey
    ? noteAvailability
    : { kind: 'loading', key: currentNoteKey ?? '' }
  const noteReadError = currentNoteState.kind === 'error'
  const closedNoteState = noteReadError ? currentNoteState.persisted : currentNoteState.kind
  const noteButtonState = notesOpen ? 'open' : closedNoteState
  const noteButtonLabel = notesOpen
    ? tx('收起笔记', 'Hide note')
    : noteReadError ? tx('重试读取笔记', 'Retry loading note')
      : closedNoteState === 'existing' ? tx('查看笔记', 'View note') : closedNoteState === 'empty' ? tx('新建笔记', 'New note') : tx('检查笔记…', 'Checking note…')

  const retryNoteRead = useCallback(() => {
    if (!currentNoteKey || noteActionBusy) return
    setNoteActionBusy(true)
    setNoteLoadError(false)
    setNoteSaveError(false)
    setNoteAvailability({ kind: 'loading', key: currentNoteKey })
    setNoteReadAttempt(value => value + 1)
    window.setTimeout(() => setNoteActionBusy(false), 0)
  }, [currentNoteKey, noteActionBusy])

  const toggleNotes = useCallback(async () => {
    if (!doc || noteActionBusy) return
    if (!notesOpen) {
      if (noteReadError) {
        retryNoteRead()
        return
      }
      if (closedNoteState === 'loading') return
      setNotesOpen(true)
      return
    }
    setNoteActionBusy(true)
    try {
      await flushCurrentNote()
      setNotesOpen(false)
      window.setTimeout(() => noteToggleRef.current?.focus(), 0)
    } catch {
      // Keep the panel open so the failed draft remains editable and retryable;
      // the existing accessible status exposes the failure and the closed-state
      // label never claims a failed draft was persisted.
      setNoteSaveError(true)
      noteInputRef.current?.focus()
    } finally {
      setNoteActionBusy(false)
    }
  }, [closedNoteState, doc, flushCurrentNote, noteActionBusy, noteReadError, notesOpen, retryNoteRead])

  // ---- Zoom: the main reading path is a visible canvas (C1/C2). Clicking it requests a
  //      one-off full-resolution Blob for the zoom viewer — never part of the display path. ----
  const openZoom = (targetPage = page) => {
    if (viewerOpenRef.current || zoomBusy) return
    setZoomBusy(true)
    // G1: bind this zoom request to the navigation context it was requested from.
    const zoomGen = ++zoomGenRef.current
    const ownedDocId = docIdRef.current
    const ownedPage = targetPage
    const ownedSession = sessionRef.current
    void display.requestZoomUrl(targetPage)
      .then(url => {
        if (!url) return
        // G2/G3: a stale zoom (page turned / doc switched / reader closed / a newer zoom) must
        // never open, and its Blob URL must be released NOW — never handed to urlOwner to forget.
        const currentPageForZoom = display.mode === 'continuous' && pageRef.current === page && ownedPage !== page
          ? ownedPage
          : pageRef.current
        const currentCtx = { gen: zoomGenRef.current, docId: docIdRef.current, page: currentPageForZoom, session: sessionRef.current }
        if (isZoomStale({ gen: zoomGen, docId: ownedDocId, page: ownedPage, session: ownedSession }, currentCtx)) { URL.revokeObjectURL(url); return }
        urlOwnerRef.current.replace(url)
        viewerOpenRef.current = true
        setViewerPage(ownedPage)
        setViewerUrl(urlOwnerRef.current.current)
      })
      .catch(() => { setPageError(tx('第 ' + page + ' 页渲染失败。', 'Page ' + page + ' failed to render.')) })
      .finally(() => setZoomBusy(false))
  }

  if (ui.view !== 'reader') return null
  const currentChapter = doc ? findCurrentChapter(doc.chapters, page) : null
  const currentChapterPath = doc ? findCurrentChapterPath(doc.chapters, page) : []
  const toggleTocNode = (n: ChapterNode) => setTocState(prev => { const e = new Set(prev.expanded); if (e.has(n.id)) e.delete(n.id); else e.add(n.id); return { expanded: e } })
  const clickChapter = (n: ChapterNode) => {
    if (n.selectable && n.startPage != null) {
      go(n.startPage, pageCount)
      if (isNarrowViewport()) {
        setTocOpen(false)
        window.requestAnimationFrame(() => pageInputRef.current?.focus())
      }
    }
    else if (n.children.length > 0) toggleTocNode(n)
  }

  return (
    <div className={css.overlay} data-testid="document-reader">
      <div className={css.topbar}>
        <button className={css.backBtn} data-testid="reader-back" onClick={() => { flushCurrentNote(); documentUiActions.backToLibrary() }}>← {tx('文件', 'Files')}</button>
        <span className={css.title} data-testid="reader-title">{doc?.fileName ?? recordMeta?.fileName ?? '…'}</span>
        <div className={css.topActions}>
          {doc && (
            <button className={css.ctxBtn} data-testid="reader-ctx-toggle" aria-label={tx('加入对话', 'Add to chat')} title={tx('加入对话', 'Add to chat')} disabled={ctxBusy} onClick={() => setCtxMenuOpen(o => !o)}>
              {ctxBusy ? tx('处理中', 'Processing') : tx('加入对话', 'Add to chat')}
            </button>
          )}
          {doc && (
            <button className={css.relatedBtn} data-testid="reader-related-toggle" aria-expanded={relatedOpen} onClick={openRelatedPanel}>
              {tx('关于此页', 'About this page')}{relatedOpen && (relatedConversations.length + relatedCards.length) > 0 ? ' ' + (relatedConversations.length + relatedCards.length) : ''}
            </button>
          )}
          <button ref={tocToggleRef} className={css.tocToggle} data-testid="reader-toc-toggle" aria-expanded={tocPanelClosed ? false : (isNarrowViewport() ? tocOpen : true)} aria-controls={loadError ? undefined : 'reader-toc-panel'} onClick={toggleToc}>{tx('目录', 'Outline')}</button>
          {doc && <button type="button" ref={noteToggleRef} className={css.noteToggle} data-testid="reader-notes-toggle" data-note-state={noteButtonState} disabled={(!notesOpen && closedNoteState === 'loading') || noteActionBusy} aria-busy={noteActionBusy || undefined} onClick={() => void toggleNotes()}>{noteButtonLabel}</button>}
          <button className={css.closeBtn} data-testid="reader-close" onClick={() => { flushCurrentNote(); documentUiActions.close() }}>{tx('关闭', 'Close')}</button>
        </div>
      </div>
      {relatedOpen && (
        <div className={css.relatedPanel} data-testid="reader-related-conversations">
          <div className={css.relatedTitle}>{tx('关于此页 · 第 ' + page + ' 页', 'About this page · page ' + page)}</div>
          <div className={css.relatedGroupTitle} data-testid="reader-related-conversations-group">{tx('会话', 'Chats')}{relatedConvState === 'ready' ? tx('（' + relatedConversations.length + '）', ' (' + relatedConversations.length + ')') : ''}</div>
          {relatedConvState === 'loading' && <div className={css.relatedMeta} data-testid="reader-related-conversations-loading">{tx('正在读取会话…', 'Loading chats…')}</div>}
          {relatedConvState === 'error' && <div className={css.relatedError} data-testid="reader-related-conversations-error">{tx('会话读取失败', 'Unable to load chats')}</div>}
          {relatedConvState === 'ready' && relatedConversations.length === 0 && <div className={css.relatedMeta} data-testid="reader-related-conversations-empty">{tx('这一页还没有相关会话。', 'No related chats on this page yet.')}</div>}
          {relatedConversations.map((hit) => (
            <button type="button" className={css.relatedItem} data-testid="reader-related-item" key={hit.conversationId + ':' + hit.messageId + ':' + hit.documentId + ':' + hit.pageNumber} onClick={() => void openRelatedConversation(hit)}>
              <span className={css.relatedConversation}>{localizedConversationTitle(hit.conversationTitle)}</span>
              <span className={css.relatedMeta}>{new Date(hit.messageCreatedAt).toLocaleString(getUiLanguage() === 'en' ? 'en-US' : 'zh-CN')} · {tx('消息 ', 'Message ')}{hit.messageId.slice(0, 8)}</span>
              {hit.messagePreview && <span className={css.relatedPreview}>“{hit.messagePreview}”</span>}
            </button>
          ))}
          <div className={css.relatedGroupTitle} data-testid="reader-related-cards-group">{tx('学习卡片', 'Study cards')}{relatedCardState === 'ready' ? tx('（' + relatedCards.length + '）', ' (' + relatedCards.length + ')') : ''}</div>
          {relatedCardState === 'loading' && <div className={css.relatedMeta} data-testid="reader-related-cards-loading">{tx('正在读取学习卡片…', 'Loading study cards…')}</div>}
          {relatedCardState === 'error' && <div className={css.relatedError} data-testid="reader-related-cards-error">{tx('学习卡片读取失败', 'Unable to load study cards')}</div>}
          {relatedCardState === 'ready' && relatedCards.length === 0 && <div className={css.relatedMeta} data-testid="reader-related-cards-empty">{tx('这一页还没有学习卡片。', 'No study cards on this page yet.')}</div>}
          {relatedCards.map(card => (
            <button type="button" className={css.relatedItem} data-testid="reader-related-card" data-card-id={card.id} key={card.id} onClick={() => openRelatedCard(card)}>
              <span className={css.relatedConversation}>{localizedStudyCardTitle(card.title, card.titleMode, card.autoTitleOrdinal)}</span>
              <span className={css.relatedMeta}>{localizedConversationTitle(card.source.conversationTitleSnapshot) || tx('学习卡片', 'Study card')}</span>
            </button>
          ))}
          {relatedError && <div className={css.relatedError} data-testid="reader-related-error">{relatedError}</div>}
        </div>
      )}
      <div className={css.body}>
        {loadError ? (
          <div className={css.errorBox} data-testid="reader-error">{loadError}</div>
        ) : (
          <>
            <aside ref={tocPanelRef} id="reader-toc-panel" className={css.toc + (tocOpen ? ' ' + css.tocOpen : '') + (tocPanelClosed ? ' ' + css.tocClosed : '')} data-testid="reader-toc">
              <div className={css.tocHeader}>
                <button type="button" ref={tocBackRef} className={css.tocBack} data-testid="reader-toc-back" aria-label={tx('返回 PDF 阅读', 'Back to PDF')} onClick={closeToc}>← {tx('返回阅读', 'Back to reading')}</button>
                <div className={css.tocTitle}>{tx('目录', 'Outline')}</div>
              </div>
              {doc && doc.chapters.length > 0 ? (
                <div className={css.tocTree}>
                  {doc.chapters.map(c => <TocRow key={c.id} node={c} depth={0} state={tocState} onOpen={clickChapter} onToggle={toggleTocNode} />)}
                </div>
              ) : (
                <div className={css.tocEmpty}>
                  <div data-testid="reader-toc-empty">{tx('这份 PDF 暂无章节目录。', 'This PDF has no outline.')}</div>
                  <button type="button" className={css.tocCreate} data-testid="reader-toc-create" onClick={() => { setBuilderSaveSource('manual'); setBuilderOpen(true) }}>{tx('创建章节', 'Create chapters')}</button>
                </div>
              )}
              {doc && doc.chapterSource !== 'none' && (
                <div className={css.tocActions}>
                  {doc.chapterSource === 'native' && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-organize" onClick={openOrganizeNative}>{tx('整理目录', 'Organize outline')}</button>
                  )}
                  {doc.chapterSource !== 'native' && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-edit" onClick={openEditCurrent}>{tx('编辑目录', 'Edit outline')}</button>
                  )}
                  {doc.chapterSource !== 'native' && hasNativeOutline && (
                    <button type="button" className={css.tocActionBtn} data-testid="reader-toc-restore" onClick={() => setRestoreConfirmOpen(true)}>{tx('恢复原始目录', 'Restore original outline')}</button>
                  )}
                </div>
              )}
              {doc && (
                <div className={css.tocAiArea}>
                  <button type="button" className={css.tocActionBtn} data-testid="reader-toc-ai" disabled={aiTocExtracting || tocPickerOpen} onClick={() => setTocPickerOpen(true)}>{tx('AI 识别目录', 'Detect outline with AI')}</button>
                  <button type="button" className={css.tocActionBtn} data-testid="reader-export-pdf" disabled={exportBusy || doc.chapters.length === 0} onClick={() => void exportBookmarked()}>{exportBusy ? tx('导出中…', 'Exporting…') : tx('导出带目录 PDF', 'Export PDF with outline')}</button>
                </div>
              )}
              {exportMsg && <div className={css.tocRestoreMsg} data-testid="reader-export-msg">{exportMsg}</div>}
              {restoreMsg && <div className={css.tocRestoreMsg} data-testid="reader-toc-restore-msg">{restoreMsg}</div>}
              {aiTocMsg && <div className={css.tocRestoreMsg} data-testid="reader-toc-ai-msg">{aiTocMsg}</div>}
              {aiTocExtracting && aiTocDialogHidden && (
                <button type="button" className={css.tocActionBtn} data-testid="reader-toc-ai-activity" onClick={() => setAiTocDialogHidden(false)}>⏳ {tx('目录识别中…（点击查看进度）', 'Detecting outline… (view progress)')}</button>
              )}
            </aside>
            <main className={css.stage} ref={display.stageRef} data-testid="reader-viewport" data-pdf-navigation-mode={display.mode}>
              {display.rendering && <div className={css.hint} data-testid="reader-loading">{tx('正在渲染第 ' + page + ' 页…', 'Rendering page ' + page + '…')}</div>}
              {(display.pageError || pageError) && <div className={css.errorBox} data-testid="reader-page-error">{display.pageError || pageError}</div>}
              {display.mode !== 'continuous' && display.surface && (
                <button className={css.pageBtn} data-testid="reader-page" disabled={zoomBusy} onClick={() => openZoom()}>
                  <canvas ref={display.canvasRef} className={css.pageCanvas} data-testid="reader-page-img" aria-label={tx('PDF 第 ' + page + ' 页', 'PDF page ' + page)} data-render-width={String(display.surface.width)} data-render-height={String(display.surface.height)} width={display.surface.width} height={display.surface.height} />
                </button>
              )}
              {display.mode === 'continuous' && display.continuousWindow && (
                <div
                  ref={display.continuousStackRef}
                  className={css.continuousStack}
                  data-testid="reader-continuous-scroll"
                  data-reader-zoom={Math.round(readerZoom * 100)}
                  role="region"
                  aria-label={tx('PDF 连续阅读', 'Continuous PDF reading')}
                  style={{ width: `min(${readerZoom * 100}%, ${Math.round(960 * readerZoom)}px)` }}
                >
                  <div className={css.continuousSpacer} data-testid="reader-continuous-top-spacer" style={{ height: display.continuousWindow.topSpacer + 'px' }} />
                  {display.continuousWindow.pages.map(view => (
                    <section key={view.pageNumber} className={css.continuousPage} data-testid={'reader-continuous-page-' + view.pageNumber} data-page-number={view.pageNumber} data-mounted="true" data-render-state={view.surface ? 'ready' : view.error ? 'error' : 'loading'} style={view.style}>
                      {view.surface ? (
                        <button type="button" className={css.continuousPageButton} data-testid={'reader-continuous-page-button-' + view.pageNumber} disabled={zoomBusy} onClick={() => openZoom(view.pageNumber)}>
                          <canvas ref={view.canvasRef} className={css.continuousCanvas} data-testid={'reader-continuous-canvas-' + view.pageNumber} aria-label={tx('PDF 第 ' + view.pageNumber + ' 页', 'PDF page ' + view.pageNumber)} width={view.surface.width} height={view.surface.height} data-render-width={String(view.surface.width)} data-render-height={String(view.surface.height)} />
                        </button>
                      ) : view.error ? <div className={css.errorBox} role="alert">{view.error}</div> : <span className={css.continuousPlaceholder}>{tx('第 ' + view.pageNumber + ' 页', 'Page ' + view.pageNumber)}</span>}
                    </section>
                  ))}
                  <div className={css.continuousSpacer} data-testid="reader-continuous-bottom-spacer" style={{ height: display.continuousWindow.bottomSpacer + 'px' }} />
                </div>
              )}
            </main>
            {notesOpen && doc && (
              <aside className={css.notePanel} data-testid="reader-notes">
                <div className={css.noteTitle}>{tx('第 ' + page + ' 页笔记', 'Notes for page ' + page)}</div>
                {noteLoading ? (
                  <div className={css.noteStatus} data-testid="reader-note-loading">{tx('正在加载…', 'Loading…')}</div>
                ) : (
                <textarea ref={noteInputRef} className={css.noteInput} value={noteText} disabled={noteLoading || !noteWriteEnabled} aria-label={tx(`第 ${page} 页笔记`, `Notes for page ${page}`)} placeholder={tx('记录这一页的想法…', 'Write your thoughts about this page…')} onChange={e => {
                  const value = e.target.value
                  setNoteText(value)
                  setNoteSavedAt(null)
                  setNoteSaveError(false)
                  setNoteLoadError(false)
                  const session = noteSessionRef.current
                  if (session && session.baseLoaded && session.writeEnabled) {
                    session.text = value
                    session.dirty = true
                    queueNoteSave(session)
                  }
                }} />
                )}
                <div className={css.noteStatus} data-testid="reader-note-status" role={noteSaveError || noteLoadError ? 'alert' : 'status'} aria-live="polite">{noteLoadError ? tx('读取失败，可重新编辑并重试', 'Load failed. Edit and try again.') : noteSaveError ? tx('保存失败，将重试', 'Save failed. Will retry.') : noteSavedAt ? tx('已自动保存', 'Saved automatically') : tx('输入后自动保存', 'Saves automatically as you type')}</div>
              </aside>
            )}
          </>
        )}
      </div>
      {ctxMenuOpen && !ctxBusy && (
        <div className={css.ctxMenu} data-testid="reader-ctx-menu">
          <div className={css.ctxMenuTitle}>{tx('加入对话', 'Add to chat')}</div>
          <button type="button" className={css.menuItem} data-testid="reader-ctx-current-page" onClick={() => { const s = buildCurrentPageSelection(page); void requestContext(s, s.ranges) }}>
            {tx('当前页', 'Current page')}<span className={css.menuMeta}>{tx('第 ' + page + ' 页', 'Page ' + page)}</span>
          </button>
          {currentChapterPath.length > 0 && <div className={css.ctxMenuTitle2}>{tx('所在章节', 'Containing chapters')}</div>}
          {[...currentChapterPath].reverse().map(n => {
            const mode = bookmarkRangeEndModeOf(doc?.bookmarkRangePreferences, n.id)
            const range = n.startPage != null && n.endPage != null
              ? bookmarkRangePresentation({ startPage: n.startPage, endPage: n.endPage, pageCount })[mode]
              : null
            return (
              <button key={n.id} type="button" className={css.menuItem} data-testid={'reader-ctx-ancestor-' + n.id} disabled={!n.selectable || n.startPage == null} onClick={() => { const s = buildChapterSelection(n, { pageCount, bookmarkRangePreferences: doc?.bookmarkRangePreferences }); void requestContext(s, s.ranges) }}>
                <span className={css.menuLevel}>L{n.level}</span>{n.title}<span className={css.menuMeta}>{range ? range.label : tx('无法定位页码', 'Page unavailable')}</span>
              </button>
            )
          })}
          {doc && currentChapterPath.length === 0 && <div className={css.ctxHint}>{tx('当前页不属于可识别章节', 'This page is not inside a recognized chapter')}</div>}
          <button type="button" className={css.menuItem} data-testid="reader-ctx-picker" onClick={() => { setCtxMenuOpen(false); setCtxPickerOpen(true) }}>{tx('选择其他章节 / 多章节…', 'Choose another or multiple chapters…')}</button>
          <button type="button" className={css.menuItem} data-testid="reader-ctx-manual" onClick={() => { setCtxMode('manual'); setManualError(null) }}>{tx('自定义页码…', 'Custom page range…')}</button>
          {ctxMode === 'manual' && (
            <div className={css.ctxForm} data-testid="reader-ctx-manual-form">
              <div className={css.ctxFormRow}>
                <label>{tx('开始页', 'Start page')}</label><input className={css.ctxInput} data-testid="reader-ctx-start" inputMode="numeric" value={manualStart} onChange={e => setManualStart(e.target.value)} />
                <label>{tx('结束页', 'End page')}</label><input className={css.ctxInput} data-testid="reader-ctx-end" inputMode="numeric" value={manualEnd} onChange={e => setManualEnd(e.target.value)} />
              </div>
              {manualError && <div className={css.ctxHint} data-testid="reader-ctx-manual-error">{manualError}</div>}
              <button type="button" className={css.menuItem} data-testid="reader-ctx-go" onClick={commitManualRange}>{tx('确认加入', 'Add range')}</button>
            </div>
          )}
          <button type="button" className={css.menuClose} onClick={() => { setCtxMenuOpen(false); setCtxMode('menu') }}>{tx('收起', 'Close')}</button>
        </div>
      )}
      {ctxPending && (
        <div className={css.ctxConfirm} data-testid="reader-ctx-confirm">
          <div>{tx('本次将处理 ' + ctxPending.count + ' 页。', 'This will process ' + ctxPending.count + ' pages.')}</div>
          <div className={css.ctxHint}>{tx('大范围 PDF 会占用更多本地处理时间和模型视觉上下文。', 'Large PDF ranges require more local processing time and model vision context.')}</div>
          <div className={css.ctxConfirmBtns}>
            <button className={css.ctxPrimary} data-testid="reader-ctx-confirm-yes" onClick={confirmContext}>{tx('继续加入 ' + ctxPending.count + ' 页', 'Add ' + ctxPending.count + ' pages')}</button>
            <button className={css.ctxSecondary} data-testid="reader-ctx-confirm-no" onClick={() => setCtxPending(null)}>{tx('取消', 'Cancel')}</button>
          </div>
        </div>
      )}
      {ctxBusy && ctxProgress && (
        <div className={css.ctxProgress} data-testid="reader-ctx-progress">{tx('正在准备上下文 ', 'Preparing context ')}{ctxProgress.done} / {ctxProgress.total}{tx(' 页', ' pages')} · {formatBytes(ctxProgress.bytes)}</div>
      )}
      {ctxMsg && (
        <div className={css.ctxMsg + (ctxMsg.ok ? ' ' + css.ctxMsgOk : '')} data-testid="reader-ctx-msg">
          <span>{ctxMsg.text}</span>
          {ctxMsg.ok && <button className={css.ctxSecondary} data-testid="reader-ctx-back" onClick={() => { flushCurrentNote(); documentUiActions.close() }}>{tx('返回对话', 'Back to chat')}</button>}
        </div>
      )}
      {ctxPickerOpen && doc && (
        <DocumentContextPicker
          documentId={doc.id}
          onCancel={() => setCtxPickerOpen(false)}
          onPreferencesCommitted={applyCommittedBookmarkRangePreferences}
          onAdd={(selection) => { setCtxPickerOpen(false); void addFromPicker(selection) }}
        />
      )}
      {doc && ctxRunning && (
        <div className={css.ctxProgress} data-testid="reader-ctx-progress">{tx('正在准备上下文 ', 'Preparing context ')}{ctxRunning.done} / {ctxRunning.total}{tx(' 页', ' pages')}</div>
      )}
      {progressError && (
        <div className={css.progressError} data-testid="reader-progress-error" role="alert">
          <span>{tx('阅读位置暂未保存', 'Reading position not saved yet')}</span>
          <button type="button" className={css.ctxSecondary} data-testid="reader-progress-retry" onClick={retryProgress}>{tx('重试', 'Retry')}</button>
        </div>
      )}
      <div className={css.navBar}>
        <button className={css.navBtn} data-testid="reader-prev" disabled={page <= 1} onClick={() => go(page - 1, pageCount)}>{tx('上一页', 'Previous')}</button>
        <div className={css.counter}>
          <input ref={pageInputRef} className={css.pageInput} data-testid="reader-page-input" inputMode="numeric" aria-label={tx('当前页码', 'Current page')} value={pageInput}
            onChange={e => setPageInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitPageInput() } }} />
          <span className={css.counterTotal}>/ {pageCount}</span>
        </div>
        <button className={css.navBtn} data-testid="reader-next" disabled={pageCount === 0 || page >= pageCount} onClick={() => go(page + 1, pageCount)}>{tx('下一页', 'Next')}</button>
        {display.mode === 'continuous' && (
          <div className={css.readerZoom} role="group" aria-label={tx('PDF 阅读缩放', 'PDF zoom')} title={tx('拖动滑杆，或按住 Ctrl 使用滚轮 / 触控板双指缩放', 'Drag the slider, or hold Ctrl and use the wheel / pinch gesture')}>
            <button type="button" className={css.zoomStepBtn} data-testid="reader-zoom-out" aria-label={tx('缩小 PDF', 'Zoom out')} disabled={readerZoom <= READER_ZOOM_MIN} onClick={() => scheduleReaderZoom(stepReaderZoom(readerZoomRef.current, -1), display.stageRef.current ? { element: display.stageRef.current } : undefined)}>−</button>
            <input
              type="range"
              className={css.zoomSlider}
              data-testid="reader-zoom-slider"
              min={Math.round(READER_ZOOM_MIN * 100)}
              max={Math.round(READER_ZOOM_MAX * 100)}
              step="1"
              value={Math.round(readerZoom * 100)}
              aria-label={tx('PDF 缩放比例', 'PDF zoom level')}
              aria-valuetext={Math.round(readerZoom * 100) + '%'}
              onChange={event => scheduleReaderZoom(Number(event.currentTarget.value) / 100, display.stageRef.current ? { element: display.stageRef.current } : undefined)}
            />
            <button type="button" className={css.zoomValueBtn} data-testid="reader-zoom-value" title={tx('恢复 100%', 'Reset to 100%')} onClick={() => scheduleReaderZoom(1, display.stageRef.current ? { element: display.stageRef.current } : undefined)}>{Math.round(readerZoom * 100)}%</button>
            <button type="button" className={css.zoomStepBtn} data-testid="reader-zoom-in" aria-label={tx('放大 PDF', 'Zoom in')} disabled={readerZoom >= READER_ZOOM_MAX} onClick={() => scheduleReaderZoom(stepReaderZoom(readerZoomRef.current, 1), display.stageRef.current ? { element: display.stageRef.current } : undefined)}>＋</button>
          </div>
        )}
      </div>
      {viewerUrl && (
        <ZoomableImageDialog
          src={viewerUrl}
          alt={tx('PDF 第 ' + viewerPage + ' 页', 'PDF page ' + viewerPage)}
          resetKey={viewerPage}
          onClose={() => { viewerOpenRef.current = false; setViewerUrl(null); setViewerPage(1); urlOwnerRef.current.revokeAll() }}
          labels={{ close: tx('关闭', 'Close'), dialog: tx('PDF 页面查看', 'PDF page viewer') }}
        />
      )}
      {tocReviewOpen && aiTocItems && (
        <TocReview
          pageCount={pageCount}
          items={aiTocItems}
          notice={aiTocWarning ?? undefined}
          onJump={(p) => go(p, pageCount)}
          onSave={saveAiToc}
          onClose={() => setTocReviewOpen(false)}
          onEditAll={editAiTocAll}
        />
      )}
      {tocPickerOpen && sessionRef.current && (
        <TocPagePicker
          session={sessionRef.current}
          pageCount={pageCount}
          onCancel={() => setTocPickerOpen(false)}
          onStart={(selectedPages) => { setTocPickerOpen(false); void runAiToc(selectedPages) }}
        />
      )}
      {(aiTocError || (aiTocExtracting && !aiTocDialogHidden)) && (
        <AiTocProgressDialog
          progress={aiTocProgress}
          selectedCount={lastAiTocPagesRef.current.length}
          error={aiTocError}
          onClose={hideAiTocDialog}
          onCancel={cancelAiToc}
          onRetry={aiTocError ? retryAiToc : undefined}
        />
      )}
      {builderOpen && doc && (
        <ChapterBuilder
          pageCount={doc.pageCount}
          initialChapters={doc.chapters}
          currentPage={page}
          draftSeed={nativeDraft ? nativeDraft.items : undefined}
          skippedUnresolved={nativeDraft ? nativeDraft.skipped : 0}
          hint={builderHint || undefined}
          saveSource={builderSaveSource}
          onSave={saveBuilder}
          onClose={() => { setBuilderOpen(false); setNativeDraft(null); setBuilderHint(null) }}
        />
      )}
      {restoreConfirmOpen && (
        <div className={css.restoreConfirm} data-testid="reader-restore-confirm">
          <div className={css.restoreConfirmBox}>
            <div>{tx('恢复 PDF 原始目录后，你当前整理的目录将被替换。确认恢复？', 'Restoring the original PDF outline will replace your current outline. Continue?')}</div>
            <div className={css.restoreConfirmBtns}>
              <button type="button" className={css.tocSecondary} data-testid="reader-restore-no" onClick={() => setRestoreConfirmOpen(false)}>{tx('取消', 'Cancel')}</button>
              <button type="button" className={css.tocPrimary} data-testid="reader-restore-yes" onClick={() => void restoreNative()}>{tx('确认恢复', 'Restore')}</button>
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
          <button type="button" className={css.tocChevronBtn} data-testid={'reader-toc-toggle-' + node.id} aria-label={expanded ? tx('收起', 'Collapse') : tx('展开', 'Expand')} onClick={() => onToggle(node)}>{expanded ? '▾' : '▸'}</button>
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
