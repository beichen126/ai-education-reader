import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useReaderDisplay, type ReaderDisplayApi } from './use-reader-display'
import type { PdfPerformanceTelemetry } from './pdf-performance-telemetry'
import type { PdfSession } from '../pdf/pdf-session'
import type { PdfNavigationMode } from '../engine/pdf-navigation-settings'
import { readSessionPageViewport, renderSessionPageSurface, renderSessionPage } from '../pdf/pdf-session'
import { ContinuousRenderController } from '../pdf/continuous-render-controller'
import type { CachedSurface } from '../pdf/reader-render-controller'

/** Why a shared viewport changed its logical page. Stage 8 uses the same contract
 * for observer, keyboard, TOC and programmatic scroll updates. */
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

export type PdfViewportApi = ReaderDisplayApi & {
  documentKey: string | null
  mode: PdfNavigationMode
  currentPage: number
  pageCount: number
  continuousPages?: ContinuousPageView[]
  continuousPageErrors?: ReadonlyMap<number, string>
  scrollToPage?: (page: number, align?: 'start' | 'center') => void
}

export type ContinuousPageView = {
  pageNumber: number
  mounted: boolean
  surface: CachedSurface | null
  error: string | null
  aspectRatio: number
  pageRef: (element: HTMLElement | null) => void
  canvasRef: (element: HTMLCanvasElement | null) => void
  style: CSSProperties
}

const CONTINUOUS_PAGE_RADIUS = 3
const DEFAULT_PAGE_ASPECT_RATIO = 0.707

function clampPage(page: number, pageCount: number): number {
  return Math.max(1, Math.min(Math.max(1, pageCount), Math.trunc(page) || 1))
}

function pageWindow(center: number, pageCount: number): Set<number> {
  const safeCenter = clampPage(center, pageCount)
  const out = new Set<number>()
  for (let page = safeCenter - CONTINUOUS_PAGE_RADIUS; page <= safeCenter + CONTINUOUS_PAGE_RADIUS; page++) {
    if (page >= 1 && page <= pageCount) out.add(page)
  }
  return out
}

type ContinuousViewportApi = {
  stageRef: React.RefObject<HTMLDivElement | null>
  rendering: boolean
  surface: CachedSurface | null
  pageError: string | null
  continuousPages: ContinuousPageView[]
  continuousPageErrors: ReadonlyMap<number, string>
  requestZoomUrl(pageOverride?: number): Promise<string>
  clearPageError(): void
  scrollToPage(page: number, align?: 'start' | 'center'): void
}

function useContinuousPdfViewport(props: PdfViewportProps & { enabled: boolean }): ContinuousViewportApi {
  const { enabled, session, documentKey, pageCount, currentPage, telemetry } = props
  const stageRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<ContinuousRenderController | null>(null)
  const pageRefs = useRef(new Map<number, HTMLElement>())
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>())
  const pageRefCallbacks = useRef(new Map<number, (element: HTMLElement | null) => void>())
  const canvasRefCallbacks = useRef(new Map<number, (element: HTMLCanvasElement | null) => void>())
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const onCurrentPageChangeRef = useRef(props.onCurrentPageChange)
  onCurrentPageChangeRef.current = props.onCurrentPageChange
  const onFirstPixelReadyRef = useRef(props.onFirstPixelReady)
  onFirstPixelReadyRef.current = props.onFirstPixelReady
  const telemetryRef = useRef(telemetry ?? null)
  telemetryRef.current = telemetry ?? null
  const firstPixelReportedRef = useRef(false)
  const anchorPageRef = useRef<number | null>(null)
  const pendingScrollPageRef = useRef<number | null>(null)
  const stablePageTimerRef = useRef<number | null>(null)
  const scanRafRef = useRef<number | null>(null)
  const [geometry, setGeometry] = useState<{ box: { width: number; height: number }; dpr: number } | null>(null)
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const [windowPages, setWindowPages] = useState<Set<number>>(() => pageWindow(currentPage, pageCount))
  const windowPagesRef = useRef(windowPages)
  windowPagesRef.current = windowPages
  const [surfaces, setSurfaces] = useState<Map<number, CachedSurface>>(new Map())
  const [aspects, setAspects] = useState<Map<number, number>>(new Map())
  const [pageErrors, setPageErrors] = useState<Map<number, string>>(new Map())
  const [surfaceRevision, setSurfaceRevision] = useState(0)
  const [rendering, setRendering] = useState(false)

  const getPageRef = useCallback((page: number) => {
    let callback = pageRefCallbacks.current.get(page)
    if (!callback) {
      callback = element => {
        if (element) pageRefs.current.set(page, element)
        else pageRefs.current.delete(page)
      }
      pageRefCallbacks.current.set(page, callback)
    }
    return callback
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

  useEffect(() => {
    if (!enabled || !session || !documentKey) {
      controllerRef.current?.cancelAll()
      controllerRef.current = null
      setSurfaces(new Map())
      setPageErrors(new Map())
      setRendering(false)
      return
    }
    firstPixelReportedRef.current = false
    const ownedSession = session
    const controller = new ContinuousRenderController({
      readViewport1: page => readSessionPageViewport(ownedSession, page),
      startRender: (page, scale) => renderSessionPageSurface(ownedSession, page, scale),
    }, { pageCount, cacheCapacity: 11 }, {
      onPageReady: (page, surface) => {
        setSurfaces(previous => { const next = new Map(previous); next.set(page, surface); return next })
        setPageErrors(previous => { const next = new Map(previous); next.delete(page); return next })
        setSurfaceRevision(value => value + 1)
      },
      onPageEvicted: page => {
        setSurfaces(previous => { const next = new Map(previous); next.delete(page); return next })
        setSurfaceRevision(value => value + 1)
      },
      onPageViewport: (page, viewport) => {
        const ratio = viewport.width / Math.max(1, viewport.height)
        setAspects(previous => {
          if (previous.get(page) === ratio) return previous
          const next = new Map(previous); next.set(page, ratio); return next
        })
      },
      onPageError: page => setPageErrors(previous => { const next = new Map(previous); next.set(page, '第 ' + page + ' 页渲染失败，可重试。'); return next }),
      onRendering: setRendering,
      onRenderStart: () => telemetryRef.current?.mark('first-render-start'),
    })
    controllerRef.current = controller
    controller.setPageCount(pageCount)
    // The mode can be selected before a document is opened. In that case the
    // stage geometry is already measured when the PDF session arrives, so the
    // new controller must consume the existing measurement immediately instead
    // of waiting for a resize that may never happen.
    controller.setGeometry(geometryRef.current)
    const initialTargets = windowPagesRef.current.size > 0 ? [...windowPagesRef.current] : [...pageWindow(currentPageRef.current, pageCount)]
    controller.setTargetPages(initialTargets)
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      controller.cancelAll()
    }
  }, [documentKey, enabled, pageCount, session])

  useEffect(() => {
    controllerRef.current?.setPageCount(pageCount)
    if (!enabled) return
    setWindowPages(pageWindow(currentPage, pageCount))
    setAspects(new Map())
    setPageErrors(new Map())
  }, [currentPage, enabled, pageCount])

  useEffect(() => {
    if (!enabled) return
    controllerRef.current?.setGeometry(geometry)
  }, [enabled, geometry])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = stageRef.current
    if (!element) return
    let timer: number | null = null
    const measure = () => {
      const next = { box: { width: Math.max(1, element.clientWidth - 24), height: Math.max(1, element.clientHeight - 24) }, dpr: window.devicePixelRatio || 1 }
      setGeometry(previous => previous && previous.box.width === next.box.width && previous.box.height === next.box.height && previous.dpr === next.dpr ? previous : next)
      telemetryRef.current?.mark('geometry-ready')
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { if (timer !== null) window.clearTimeout(timer); timer = window.setTimeout(measure, 120) })
      : null
    if (observer) observer.observe(element)
    else window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); if (timer !== null) window.clearTimeout(timer); if (!observer) window.removeEventListener('resize', measure) }
  }, [enabled, documentKey, session])

  const choosePageFromScroll = useCallback(() => {
    const root = stageRef.current
    if (!root || pageRefs.current.size === 0) return
    const rootRect = root.getBoundingClientRect()
    const center = rootRect.top + rootRect.height / 2
    let candidate = clampPage(currentPageRef.current, pageCount)
    let distance = Number.POSITIVE_INFINITY
    for (const [page, element] of pageRefs.current) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) continue
      const pageCenter = rect.top + rect.height / 2
      const nextDistance = Math.abs(pageCenter - center)
      if (nextDistance < distance) { candidate = page; distance = nextDistance }
    }
    setWindowPages(previous => {
      const next = pageWindow(candidate, pageCount)
      if (previous.size === next.size && [...previous].every(page => next.has(page))) return previous
      return next
    })
    if (candidate === currentPageRef.current) return
    if (stablePageTimerRef.current !== null) window.clearTimeout(stablePageTimerRef.current)
    stablePageTimerRef.current = window.setTimeout(() => {
      stablePageTimerRef.current = null
      if (candidate === currentPageRef.current) return
      pendingScrollPageRef.current = candidate
      onCurrentPageChangeRef.current?.(candidate, 'scroll')
    }, 180)
  }, [pageCount])

  useEffect(() => {
    if (!enabled) return
    const element = stageRef.current
    if (!element) return
    const schedule = () => {
      if (scanRafRef.current !== null) return
      scanRafRef.current = window.requestAnimationFrame(() => { scanRafRef.current = null; choosePageFromScroll() })
    }
    const onScroll = () => schedule()
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(schedule, { root: element, rootMargin: '150% 0px', threshold: [0, 0.5, 1] })
      : null
    for (const pageElement of pageRefs.current.values()) observer?.observe(pageElement)
    schedule()
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (scanRafRef.current !== null) window.cancelAnimationFrame(scanRafRef.current)
      scanRafRef.current = null
      if (stablePageTimerRef.current !== null) window.clearTimeout(stablePageTimerRef.current)
      stablePageTimerRef.current = null
    }
  }, [choosePageFromScroll, documentKey, enabled, pageCount, session])

  useEffect(() => {
    if (!enabled) return
    const targets = windowPages.size > 0 ? [...windowPages] : [...pageWindow(currentPage, pageCount)]
    controllerRef.current?.setTargetPages(targets)
  }, [currentPage, enabled, pageCount, windowPages])

  const scrollToPage = useCallback((targetPage: number, align: 'start' | 'center' = 'center') => {
    const element = stageRef.current
    const target = pageRefs.current.get(clampPage(targetPage, pageCount))
    if (!element || !target) return
    const safePage = clampPage(targetPage, pageCount)
    pendingScrollPageRef.current = safePage
    const targetTop = target.offsetTop - (align === 'center' ? Math.max(0, (element.clientHeight - target.offsetHeight) / 2) : 0)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({ top: Math.max(0, targetTop), behavior: reduced ? 'auto' : 'smooth' })
  }, [pageCount])

  useEffect(() => {
    anchorPageRef.current = null
    pendingScrollPageRef.current = null
  }, [documentKey])

  useEffect(() => {
    if (!enabled || pageCount <= 0) return
    const target = clampPage(currentPage, pageCount)
    setWindowPages(pageWindow(target, pageCount))
    if (pendingScrollPageRef.current === target) { pendingScrollPageRef.current = null; return }
    if (anchorPageRef.current === target) return
    anchorPageRef.current = target
    const timer = window.setTimeout(() => scrollToPage(target, 'center'), 0)
    return () => window.clearTimeout(timer)
  }, [currentPage, documentKey, enabled, pageCount, scrollToPage])

  useEffect(() => {
    const readySurfaces = [...surfaces.entries()]
    for (const [page, surface] of readySurfaces) {
      if (!windowPages.has(page)) continue
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
        props.onFirstPixelReady?.()
      }
    }
  }, [onFirstPixelReadyRef, surfaceRevision, surfaces, windowPages])

  const requestZoomUrl = useCallback(async (pageOverride?: number): Promise<string> => {
    if (!session) return ''
    const page = clampPage(pageOverride ?? currentPageRef.current, pageCount)
    const rendered = await renderSessionPage(session, page)
    return URL.createObjectURL(rendered.blob)
  }, [pageCount, session])

  const clearPageError = useCallback(() => setPageErrors(new Map()), [])
  const continuousPages: ContinuousPageView[] = []
  for (let page = 1; page <= pageCount; page++) {
    const ratio = aspects.get(page) ?? DEFAULT_PAGE_ASPECT_RATIO
    continuousPages.push({
      pageNumber: page,
      mounted: windowPages.has(page),
      surface: surfaces.get(page) ?? null,
      error: pageErrors.get(page) ?? null,
      aspectRatio: ratio,
      pageRef: getPageRef(page),
      canvasRef: getCanvasRef(page),
      style: { aspectRatio: String(ratio), ['--pdf-page-aspect' as string]: String(ratio) } as CSSProperties,
    })
  }
  const currentSurface = surfaces.get(clampPage(currentPage, pageCount)) ?? null
  const currentError = pageErrors.get(clampPage(currentPage, pageCount)) ?? null
  return { stageRef, rendering, surface: currentSurface, pageError: currentError, continuousPages, continuousPageErrors: pageErrors, requestZoomUrl, clearPageError, scrollToPage }
}

/**
 * Shared PDF viewport seam for Reader and Context Preview.
 *
 * Both paged and continuous renderers stay behind this seam. The two surfaces
 * therefore share mode selection, page-change ownership and zoom input without
 * duplicating renderer orchestration or persistence behavior.
 */
export function usePdfViewport(props: PdfViewportProps): PdfViewportApi {
  const display = useReaderDisplay(props.session, props.currentPage, props.pageCount, props.telemetry ?? null, props.onFirstPixelReady)
  const continuous = useContinuousPdfViewport({ ...props, enabled: props.mode === 'continuous' })
  const active = props.mode === 'continuous' ? continuous : display
  return {
    ...active,
    canvasRef: display.canvasRef,
    documentKey: props.documentKey,
    mode: props.mode,
    currentPage: props.currentPage,
    pageCount: props.pageCount,
  }
}
