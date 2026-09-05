// Reader display binding (Agent C): wires a PdfSession to a visible <canvas> through
// the PDF.js-free ReaderRenderController. Owns: the session-bound controller lifecycle,
// viewport-style geometry measurement (ResizeObserver + debounce), the surface blit to
// the visible canvas, and the on-demand full-resolution Blob for the zoom viewer.
// The Reader正文 display NEVER encodes to a JPEG Blob (C1/C2) — the canvas is the screen.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readSessionPageViewport, renderSessionPageSurface, renderSessionPage, type PdfSession } from '../pdf/pdf-session'
import { ReaderRenderController, type CachedSurface, type DisplayGeometry } from '../pdf/reader-render-controller'

export type ReaderDisplayApi = {
  /** Attach to the visible <canvas>. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** Attach to the stage container so the display box can be measured. */
  stageRef: React.RefObject<HTMLDivElement | null>
  rendering: boolean
  /** The current page's ready display surface (null while loading / no doc). */
  surface: CachedSurface | null
  pageError: string | null
  /** Produce a full-resolution (MAX_RENDER_EDGE) Blob URL for the zoom viewer. */
  requestZoomUrl(): Promise<string>
  clearPageError(): void
}

const STAGE_PADDING = 24 // 12px each side of the reader stage
export { isZoomStale, type ZoomRequestContext } from './zoom-ownership'

export function useReaderDisplay(session: PdfSession | null, page: number, pageCount: number): ReaderDisplayApi {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<ReaderRenderController | null>(null)
  const [rendering, setRendering] = useState(false)
  const [surface, setSurface] = useState<CachedSurface | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [geometry, setGeometry] = useState<DisplayGeometry | null>(null)
  const pageRef = useRef(page); pageRef.current = page
  const pageCountRef = useRef(pageCount); pageCountRef.current = pageCount

  // ---- bind a controller to the session (recreated on document switch) ----
  useEffect(() => {
    setSurface(null)
    setPageError(null)
    if (!session) {
      controllerRef.current?.cancelAll()
      controllerRef.current = null
      return
    }
    const backend = {
      readViewport1: (n: number) => readSessionPageViewport(session, n),
      startRender: (n: number, scale: number) => renderSessionPageSurface(session, n, scale),
    }
    const ctrl = new ReaderRenderController(backend, { cacheCapacity: 5, pageCount }, {
      onForeground: (s) => setSurface(s),
      onRenderState: (r) => setRendering(r),
      onPageError: (n) => setPageError('第 ' + n + ' 页渲染失败。'),
    })
    controllerRef.current = ctrl
    return () => {
      if (controllerRef.current === ctrl) { ctrl.cancelAll(); controllerRef.current = null }
    }
  }, [session])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { controllerRef.current?.setPageCount(pageCount) }, [pageCount])

  // ---- blit the ready surface onto the visible canvas (after it is mounted) ----
  useEffect(() => {
    if (!surface) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = surface.width
    canvas.height = surface.height
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.drawImage(surface.surface, 0, 0)
  }, [surface])

  // ---- measure the stage box (debounced on resize) to drive viewport-aware scaling ----
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let timer: number | null = null
    const measure = () => {
      setGeometry({
        box: { width: Math.max(1, el.clientWidth - STAGE_PADDING), height: Math.max(1, el.clientHeight - STAGE_PADDING) },
        dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      })
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (timer !== null) window.clearTimeout(timer); timer = window.setTimeout(measure, 200) })
      ro.observe(el)
      return () => { ro.disconnect(); if (timer !== null) window.clearTimeout(timer) }
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [session])

  // ---- push geometry + navigate: the controller decides cache / cancel / prefetch ----
  useEffect(() => {
    const ctrl = controllerRef.current
    if (!ctrl || !session) return
    ctrl.setGeometry(geometry)
    ctrl.setPageCount(pageCount)
    setPageError(null)
    ctrl.requestForeground(page)
  }, [page, pageCount, geometry, session])

  const requestZoomUrl = useCallback(async (): Promise<string> => {
    const sess = session
    const pg = pageRef.current
    if (!sess) return ''
    const r = await renderSessionPage(sess, pg)
    return URL.createObjectURL(r.blob)
  }, [session])

  const clearPageError = useCallback(() => setPageError(null), [])

  return { canvasRef, stageRef, rendering, surface, pageError, requestZoomUrl, clearPageError }
}
