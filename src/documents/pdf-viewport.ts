import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useReaderDisplay, type ReaderDisplayApi } from './use-reader-display'
import { notePdfRendererAttach, notePdfRendererCall, type PdfPerformanceTelemetry } from './pdf-performance-telemetry'
import type { PdfSession } from '../pdf/pdf-session'
import type { PdfNavigationMode } from '../engine/pdf-navigation-settings'
import { readSessionPageViewport, renderSessionPageSurface, renderSessionPage } from '../pdf/pdf-session'
import { ContinuousRenderController } from '../pdf/continuous-render-controller'
import { ContinuousLayoutModel, type VirtualWindow } from '../pdf/continuous-layout-model'
import type { CachedSurface } from '../pdf/reader-render-controller'

/** Why a shared viewport changed its logical page. The same contract is used for
 *  observer, keyboard, TOC and programmatic scroll updates. */
export type PageChangeReason = 'navigation' | 'toc' | 'page-input' | 'scroll' | 'restore' | 'mode-switch'

export type PdfViewportProps = {
  session: PdfSession | null
  documentKey: string | null
  pageCount: number
  currentPage: number
  mode: PdfNavigationMode
  telemetry?: PdfPerformanceTelemetry | null
  onCurrentPageChange?: (page: number, reason: PageChangeReason) => void
  onOpenZoom?: (page: number) => void
  onFirstPixelReady?: () => void
}

/** One mounted page in the virtualized continuous stack. */
export type ContinuousPageView = {
  pageNumber: number
  surface: CachedSurface | null
  error: string | null
  canvasRef: (element: HTMLCanvasElement | null) => void
  /** The page box height, so spacers and offsets agree with the layout model. */
  style: CSSProperties
}

/**
 * The mounted window of a continuous stack. Only `pages` exists in the DOM; the two
 * spacers stand in for every other page, so the DOM never grows with `pageCount`.
 */
export type ContinuousWindowView = {
  topSpacer: number
  bottomSpacer: number
  pages: ContinuousPageView[]
}

export type PdfViewportApi = ReaderDisplayApi & {
  documentKey: string | null
  mode: PdfNavigationMode
  currentPage: number
  pageCount: number
  continuousWindow?: ContinuousWindowView
  continuousPageErrors?: ReadonlyMap<number, string>
  scrollToPage?: (page: number, align?: 'start' | 'center') => void
}

const STAGE_PADDING = 24
const PAGE_GAP = 12
/** Canvas/surface hard cap for the continuous renderer (task §5.3). */
const MAX_CANVAS_PAGES = 7
const MAX_MOUNTED_PAGES = 11
const SCROLL_SETTLE_MS = 180

function clampPage(page: number, pageCount: number): number {
  return Math.max(1, Math.min(Math.max(1, pageCount), Math.trunc(page) || 1))
}

function sameWindow(a: VirtualWindow, b: VirtualWindow): boolean {
  if (a.startPage !== b.startPage || a.endPage !== b.endPage) return false
  if (a.topSpacer !== b.topSpacer || a.bottomSpacer !== b.bottomSpacer) return false
  return a.pages.length === b.pages.length && a.pages.every((page, index) => page === b.pages[index])
}

function emptyWindow(): VirtualWindow {
  return { startPage: 1, endPage: 0, topSpacer: 0, bottomSpacer: 0, pages: [] }
}

/** The at most `limit` window pages closest to the page the user is looking at. */
function pickTargets(window: VirtualWindow, centrePage: number, limit: number): number[] {
  if (window.pages.length <= limit) return [...window.pages]
  return [...window.pages]
    .sort((a, b) => Math.abs(a - centrePage) - Math.abs(b - centrePage) || a - b)
    .slice(0, limit)
    .sort((a, b) => a - b)
}

type ContinuousViewportApi = {
  stageRef: React.RefObject<HTMLDivElement | null>
  rendering: boolean
  surface: CachedSurface | null
  pageError: string | null
  continuousWindow: ContinuousWindowView
  continuousPageErrors: ReadonlyMap<number, string>
  requestZoomUrl(pageOverride?: number): Promise<string>
  clearPageError(): void
  scrollToPage(page: number, align?: 'start' | 'center'): void
}

/**
 * Continuous PDF viewport. Page geometry is owned by the pure
 * {@link ContinuousLayoutModel}; the DOM contains only the mounted window plus two
 * spacers, and the render controller only ever targets the window's pages.
 */
function useContinuousPdfViewport(props: PdfViewportProps & { enabled: boolean }): ContinuousViewportApi {
  const { enabled, session, documentKey, pageCount, currentPage, telemetry } = props
  const stageRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<ContinuousRenderController | null>(null)
  const layoutRef = useRef<ContinuousLayoutModel | null>(null)
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>())
  const canvasRefCallbacks = useRef(new Map<number, (element: HTMLCanvasElement | null) => void>())
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const pageCountRef = useRef(pageCount)
  pageCountRef.current = pageCount
  const onCurrentPageChangeRef = useRef(props.onCurrentPageChange)
  onCurrentPageChangeRef.current = props.onCurrentPageChange
  const onFirstPixelReadyRef = useRef(props.onFirstPixelReady)
  onFirstPixelReadyRef.current = props.onFirstPixelReady
  const telemetryRef = useRef(telemetry ?? null)
  telemetryRef.current = telemetry ?? null
  const firstPixelReportedRef = useRef(false)
  const lastReportedPageRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const pendingJumpRef = useRef<{ page: number; align: 'start' | 'center'; attempts: number } | null>(null)
  const [layoutRevision, setLayoutRevision] = useState(0)
  const [viewWindow, setViewWindow] = useState<VirtualWindow>(emptyWindow)
  const [surfaces, setSurfaces] = useState<Map<number, CachedSurface>>(new Map())
  const [pageErrors, setPageErrors] = useState<Map<number, string>>(new Map())
  const [surfaceRevision, setSurfaceRevision] = useState(0)
  const [rendering, setRendering] = useState(false)
  const bumpLayout = useCallback(() => setLayoutRevision(value => value + 1), [])

  const ensureLayout = useCallback((): ContinuousLayoutModel => {
    let layout = layoutRef.current
    if (!layout) {
      layout = new ContinuousLayoutModel({ pageCount: pageCountRef.current, contentWidth: 800, gap: PAGE_GAP, overscanPx: 0, maxWindowPages: MAX_MOUNTED_PAGES })
      layoutRef.current = layout
    }
    layout.setPageCount(pageCountRef.current)
    return layout
  }, [])

  const getCanvasRef = useCallback((page: number) => {
    let callback = canvasRefCallbacks.current.get(page)
    if (!callback) {
      callback = element => {
        if (element) canvasRefs.current.set(page, element)
        else canvasRefs.current.delete(page)
      }
      canvasRefCallbacks.current.set(page, callback)
    }
    return callback
  }, [])

  // ---- bind a controller to the session; an inactive renderer creates nothing ----
  useEffect(() => {
    if (!enabled || !session || !documentKey) {
      controllerRef.current?.cancelAll()
      controllerRef.current = null
      layoutRef.current = null
      setSurfaces(new Map())
      setPageErrors(new Map())
      setRendering(false)
      setViewWindow(emptyWindow())
      return
    }
    firstPixelReportedRef.current = false
    lastReportedPageRef.current = null
    pendingJumpRef.current = null
    // A document switch invalidates every measurement.
    layoutRef.current = null
    const layout = ensureLayout()
    const ownedSession = session
    const controller = new ContinuousRenderController({
      readViewport1: page => { notePdfRendererCall('continuous', 'readViewport'); return readSessionPageViewport(ownedSession, page) },
      startRender: (page, scale) => { notePdfRendererCall('continuous', 'startRender'); return renderSessionPageSurface(ownedSession, page, scale) },
    }, { pageCount, cacheCapacity: MAX_CANVAS_PAGES }, {
      onPageReady: (page, surface) => {
        setSurfaces(previous => { const next = new Map(previous); next.set(page, surface); return next })
        setPageErrors(previous => { const next = new Map(previous); next.delete(page); return next })
        setSurfaceRevision(value => value + 1)
      },
      onPageEvicted: page => {
        setSurfaces(previous => { if (!previous.has(page)) return previous; const next = new Map(previous); next.delete(page); return next })
        setSurfaceRevision(value => value + 1)
      },
      onPageViewport: (page, viewport) => {
        // A real page size is known BEFORE its pixels arrive: update the metric and
        // compensate the scroll position when the change sits above the anchor.
        const correction = layout.recordPageAspect(page, viewport.width / Math.max(1, viewport.height), currentPageRef.current)
        if (correction.scrollDelta !== 0) {
          const root = stageRef.current
          if (root) { root.scrollTop = Math.max(0, root.scrollTop + correction.scrollDelta); setViewWindow(layout.getVirtualWindow(root.scrollTop)) }
        }
        bumpLayout()
      },
      onPageError: page => setPageErrors(previous => { if (previous.has(page)) return previous; const next = new Map(previous); next.set(page, '第 ' + page + ' 页渲染失败，可重试。'); return next }),
      onRendering: setRendering,
      onRenderStart: () => telemetryRef.current?.mark('first-render-start'),
    })
    controllerRef.current = controller
    notePdfRendererAttach('continuous', 'attach')
    controller.setPageCount(pageCount)
    controller.setTargetPages(layout.getVirtualWindow(stageRef.current?.scrollTop ?? 0).pages)
    return () => {
      notePdfRendererAttach('continuous', 'detach')
      if (controllerRef.current === controller) controllerRef.current = null
      controller.cancelAll()
    }
  }, [bumpLayout, documentKey, enabled, ensureLayout, pageCount, session])

  // ---- measure the scroll root, then keep the model's geometry in sync ----
  useLayoutEffect(() => {
    if (!enabled) return
    const element = stageRef.current
    if (!element) return
    let timer: number | null = null
    const measure = () => {
      const layout = ensureLayout()
      const width = Math.max(1, element.clientWidth - STAGE_PADDING)
      const height = Math.max(1, element.clientHeight)
      // A width change resets every measured height, so re-anchor on the logical page.
      const widthChanged = Math.abs(layout.getContentWidth() - width) > 0.5
      layout.setGeometry({ contentWidth: width, viewportHeight: height, overscanPx: Math.round(height * 0.6) })
      controllerRef.current?.setGeometry({ box: { width, height }, dpr: window.devicePixelRatio || 1 })
      telemetryRef.current?.mark('geometry-ready')
      if (widthChanged) {
        element.scrollTop = layout.offsetForPage(clampPage(currentPageRef.current, pageCountRef.current), 'center')
      }
      setViewWindow(layout.getVirtualWindow(element.scrollTop))
      bumpLayout()
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { if (timer !== null) window.clearTimeout(timer); timer = window.setTimeout(measure, 120) })
      : null
    if (observer) observer.observe(element)
    else window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); if (timer !== null) window.clearTimeout(timer); if (!observer) window.removeEventListener('resize', measure) }
  }, [bumpLayout, documentKey, enabled, ensureLayout, session])

  // ---- scroll: window + settled current page, no session/branch/card reads ----
  const refreshFromScroll = useCallback(() => {
    const root = stageRef.current
    const layout = layoutRef.current
    if (!root || !layout) return
    const next = layout.getVirtualWindow(root.scrollTop)
    setViewWindow(previous => sameWindow(previous, next) ? previous : next)
    const centre = layout.pageAtViewportCenter(root.scrollTop)
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      const element = stageRef.current
      const current = layoutRef.current
      if (!element || !current) return
      const stable = current.pageAtViewportCenter(element.scrollTop)
      if (stable === currentPageRef.current) return
      lastReportedPageRef.current = stable
      onCurrentPageChangeRef.current?.(stable, 'scroll')
    }, SCROLL_SETTLE_MS)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const element = stageRef.current
    if (!element) return
    const schedule = () => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = window.requestAnimationFrame(() => { scrollRafRef.current = null; refreshFromScroll() })
    }
    element.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      element.removeEventListener('scroll', schedule)
      if (scrollRafRef.current !== null) window.cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [documentKey, enabled, refreshFromScroll, session])

  // ---- the controller renders only the mounted window (at most 7 canvases) ----
  useEffect(() => {
    if (!enabled) return
    controllerRef.current?.setTargetPages(pickTargets(viewWindow, currentPage, MAX_CANVAS_PAGES))
  }, [currentPage, enabled, viewWindow])

  // ---- keep the per-page canvas callback map bounded by the mounted window ----
  useEffect(() => {
    const keep = new Set(viewWindow.pages)
    for (const page of [...canvasRefCallbacks.current.keys()]) {
      if (!keep.has(page)) { canvasRefCallbacks.current.delete(page); canvasRefs.current.delete(page) }
    }
  }, [window])

  const scrollToPage = useCallback((targetPage: number, align: 'start' | 'center' = 'center') => {
    const root = stageRef.current
    const layout = layoutRef.current
    if (!root || !layout || pageCountRef.current <= 0) return
    const safe = clampPage(targetPage, pageCountRef.current)
    // Phase 1: jump to the estimated offset with a non-animated scroll. A 500 page
    // smooth scroll would sweep every page in between.
    pendingJumpRef.current = { page: safe, align, attempts: 0 }
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    root.scrollTo({ top: layout.offsetForPage(safe, align), behavior: reduced ? 'auto' : 'auto' })
    setViewWindow(layout.getVirtualWindow(root.scrollTop))
  }, [])

  // ---- phase 2: once the target page is mounted and measured, adjust once ----
  useEffect(() => {
    const pending = pendingJumpRef.current
    if (!pending || !enabled) return
    const root = stageRef.current
    const layout = layoutRef.current
    if (!root || !layout) return
    if (!viewWindow.pages.includes(pending.page)) return
    if (!layout.hasMeasurement(pending.page) && pending.attempts < 3) {
      pending.attempts++
      const timer = window.setTimeout(() => bumpLayout(), 80)
      return () => window.clearTimeout(timer)
    }
    const exact = layout.offsetForPage(pending.page, pending.align)
    if (Math.abs(exact - root.scrollTop) > 1) root.scrollTop = exact
    pendingJumpRef.current = null
    setViewWindow(layout.getVirtualWindow(root.scrollTop))
  }, [bumpLayout, enabled, layoutRevision, viewWindow])

  // ---- external page changes (TOC, page input, restore, mode switch) ----
  useEffect(() => {
    if (!enabled || pageCount <= 0) return
    const root = stageRef.current
    const layout = layoutRef.current
    if (!root || !layout) return
    const target = clampPage(currentPage, pageCount)
    if (layout.pageAtViewportCenter(root.scrollTop) === target) return
    // Our own scroll reported this page; scrolling again would fight the user.
    if (lastReportedPageRef.current === target) return
    scrollToPage(target, 'center')
  }, [currentPage, documentKey, enabled, pageCount, scrollToPage])

  // ---- blit ready surfaces onto the mounted canvases ----
  useEffect(() => {
    for (const page of viewWindow.pages) {
      const surface = surfaces.get(page)
      if (!surface) continue
      const canvas = canvasRefs.current.get(page)
      if (!canvas) continue
      canvas.width = surface.width
      canvas.height = surface.height
      const context = canvas.getContext('2d')
      if (!context) continue
      context.drawImage(surface.surface, 0, 0)
      if (!firstPixelReportedRef.current) {
        firstPixelReportedRef.current = true
        telemetryRef.current?.mark('first-pixel-ready')
        onFirstPixelReadyRef.current?.()
      }
    }
  }, [surfaceRevision, surfaces, viewWindow])

  const requestZoomUrl = useCallback(async (pageOverride?: number): Promise<string> => {
    if (!session) return ''
    const page = clampPage(pageOverride ?? currentPageRef.current, pageCount)
    const rendered = await renderSessionPage(session, page)
    return URL.createObjectURL(rendered.blob)
  }, [pageCount, session])

  const clearPageError = useCallback(() => setPageErrors(new Map()), [])

  const layout = layoutRef.current
  const pages: ContinuousPageView[] = viewWindow.pages.map(page => ({
    pageNumber: page,
    surface: surfaces.get(page) ?? null,
    error: pageErrors.get(page) ?? null,
    canvasRef: getCanvasRef(page),
    style: { height: Math.round(layout ? layout.heightFor(page) : 0) + 'px' } as CSSProperties,
  }))
  const continuousWindow: ContinuousWindowView = {
    topSpacer: Math.round(viewWindow.topSpacer),
    bottomSpacer: Math.round(viewWindow.bottomSpacer),
    pages,
  }
  const centrePage = pageCount > 0 ? clampPage(currentPage, pageCount) : 0
  return {
    stageRef,
    rendering,
    surface: centrePage ? surfaces.get(centrePage) ?? null : null,
    pageError: centrePage ? pageErrors.get(centrePage) ?? null : null,
    continuousWindow,
    continuousPageErrors: pageErrors,
    requestZoomUrl,
    clearPageError,
    scrollToPage,
  }
}

/**
 * Shared PDF viewport seam for Reader and Context Preview.
 *
 * Exactly ONE renderer is active at a time: the inactive one is disabled and performs
 * no viewport read, render, geometry measurement or canvas blit.
 */
export function usePdfViewport(props: PdfViewportProps): PdfViewportApi {
  const pagedEnabled = props.mode === 'paged'
  const display = useReaderDisplay(props.session, props.currentPage, props.pageCount, props.telemetry ?? null, props.onFirstPixelReady, pagedEnabled)
  const continuous = useContinuousPdfViewport({ ...props, enabled: props.mode === 'continuous' })
  const shared = {
    canvasRef: display.canvasRef,
    documentKey: props.documentKey,
    mode: props.mode,
    currentPage: props.currentPage,
    pageCount: props.pageCount,
  }
  if (props.mode === 'continuous') {
    return { ...continuous, ...shared, active: true }
  }
  return { ...display, ...shared }
}
