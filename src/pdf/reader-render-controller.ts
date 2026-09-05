// Reader display render controller (Agent C, C3/C5/C6/C7). PDF.js-free and React-free:
// it orchestrates cancellable foreground renders, a bounded LRU page cache and
// low-priority neighbor prefetch, without touching PDF.js internals. A test injects a
// fake RenderBackend, so cancel / cache / prefetch / eviction semantics are node-testable.
//
// Ownership rules baked in here:
//   1. The user's current page render ALWAYS outranks prefetch (C6).
//   2. A new foreground request cancels every unrelated in-flight render (C7) — only
//      the requested page's render survives, so fast 10→11→12→13 never piles up CPU.
//   3. Cached pages are returned WITHOUT re-rendering (C5 cache revisit).
//   4. document switch / reader close calls cancelAll() to free every surface + task.
import { BoundedPageCache } from './pdf-page-cache'
import { computeDisplayScale } from './pdf-render-policy'
import type { PageSurface, PageSurfaceRender } from './pdf-service'

/** A display-ready page the controller caches and hands to the visible canvas. */
export type CachedSurface = {
  surface: ImageBitmap | HTMLCanvasElement
  width: number
  height: number
  scale: number
  pageNumber: number
  /** Release backing resources (ImageBitmap.close() when relevant). Idempotent. */
  dispose(): void
}

/** The render backend the controller drives — implemented by PdfSession (real) or a fake. */
export type RenderBackend = {
  /** Viewport at scale 1 for a page (anchor for viewport-aware scaling). */
  readViewport1(pageNumber: number): Promise<{ width: number; height: number }>
  /** Start a cancellable render of a page at an exact scale into a display surface. */
  startRender(pageNumber: number, scale: number): PageSurfaceRender
}

/** Measured CSS box the page must fit into + device pixel ratio. */
export type DisplayGeometry = { box: { width: number; height: number }; dpr: number }

export type ScaleFn = (vp1: { width: number; height: number }, box: { width: number; height: number }, dpr: number) => number

export type RenderControllerOptions = {
  cacheCapacity?: number
  computeScale?: ScaleFn
  /** Total pages in the document — bounds neighbor prefetch. */
  pageCount?: number
}

export type RenderControllerEvents = {
  /** Current foreground page surface is ready (from cache or freshly rendered). */
  onForeground(surface: CachedSurface, fromCache: boolean): void
  /** Foreground render state — drives the "正在渲染第 x 页…" hint. */
  onRenderState(rendering: boolean): void
  /** A foreground page failed to render (NOT a cancellation). */
  onPageError(pageNumber: number): void
}

function releaseSurface(p: PageSurface): void {
  const s = p.surface as unknown as { close?: unknown }
  if (typeof s.close === 'function') { try { (p.surface as ImageBitmap).close() } catch { /* ignore */ } }
}

function toCached(p: PageSurface): CachedSurface {
  return {
    surface: p.surface, width: p.width, height: p.height, scale: p.scale, pageNumber: p.pageNumber,
    dispose() { releaseSurface(p) },
  }
}

export type RenderControllerStats = {
  /** Foreground page renders started. */
  renders: number
  /** Low-priority neighbor prefetch renders started. */
  prefetchRenders: number
  /** RenderHandles that were .cancel()ed (stale foreground + prefetch). */
  cancels: number
  /** Current-page surfaces served from the bounded cache (no re-render). */
  cacheHits: number
  /** Current-page renders that had to hit the renderer (not cached). */
  cacheMisses: number
}

export class ReaderRenderController {
  private readonly cache: BoundedPageCache<CachedSurface>
  private readonly backend: RenderBackend
  private readonly events: RenderControllerEvents
  private readonly computeScale: ScaleFn
  private readonly onEvict: (v: CachedSurface) => void
  private gen = 0
  private fgHandle: PageSurfaceRender | null = null
  private fgPage = 0
  private readonly prefetchHandles = new Map<number, PageSurfaceRender>()
  private geometry: DisplayGeometry | null = null
  private pageCount: number
  private disposed = false
  private readonly stats: RenderControllerStats = { renders: 0, prefetchRenders: 0, cancels: 0, cacheHits: 0, cacheMisses: 0 }

  constructor(backend: RenderBackend, options: RenderControllerOptions, events: RenderControllerEvents) {
    this.backend = backend
    this.events = events
    this.computeScale = options.computeScale ?? computeDisplayScale
    this.pageCount = options.pageCount ?? 0
    this.onEvict = (v) => v.dispose()
    this.cache = new BoundedPageCache<CachedSurface>(options.cacheCapacity ?? 5, (_v, _k) => this.onEvict(_v))
  }

  setGeometry(geometry: DisplayGeometry | null): void { this.geometry = geometry }
  setPageCount(n: number): void { this.pageCount = n }
  getCurrentPage(): number { return this.fgPage }
  hasCached(pageNumber: number): boolean { return this.cache.has(String(pageNumber)) }
  /** Cumulative structural stats — used by tests / the dev benchmark (C11/C12). */
  getStats(): RenderControllerStats { return { ...this.stats } }

  /** The user navigated to a page — this page is now the highest-priority target. */
  requestForeground(pageNumber: number): void {
    if (this.disposed || pageNumber < 1) return
    const gen = ++this.gen
    this.fgPage = pageNumber
    const geometry = this.geometry
    if (!geometry) return // not measured yet; the hook re-requests once geometry is known
    // Cache hit: blit it, no re-render (C5 "10 → 11 → 10" gate).
    const cached = this.cache.get(String(pageNumber))
    if (cached) {
      this.stats.cacheHits++
      this.cancelAllInFlight()
      this.events.onRenderState(false)
      this.events.onForeground(cached, true)
      // Keep the prefetch chain alive even when the current page was a prefetched cache
      // hit — so sequential forward reading stays backed by an already-ready next page.
      this.prefetchNeighbors(pageNumber)
      return
    }
    this.stats.cacheMisses++
    this.cancelAllInFlight()
    void this.startForeground(pageNumber, gen)
  }

  /** Low-priority neighbor prefetch (page+1 first, then page-1) — never foreground priority. */
  prefetchNeighbors(centerPage: number): void {
    if (this.disposed || this.pageCount <= 0) return
    const targets: number[] = []
    if (centerPage + 1 <= this.pageCount) targets.push(centerPage + 1)
    if (centerPage - 1 >= 1) targets.push(centerPage - 1)
    for (const target of targets) {
      if (this.cache.has(String(target)) || this.prefetchHandles.has(target)) continue
      const gen = this.gen
      void this.startPrefetch(target, gen)
    }
  }

  /** Free every surface + cancel every task. Document switch / reader close / unmount.
   *  Also bumps the generation so any foreground/prefetch render that is still awaiting
   *  its viewport read becomes STALE and never starts a render (a cancelled document
   *  must not have a late render sneak back in — C3 stale guard). */
  cancelAll(): void {
    this.gen++
    this.cancelAllInFlight()
    const keys = this.cache.keys()
    for (const k of keys) this.cache.delete(k)?.dispose()
  }

  private cancelAllInFlight(): void {
    if (this.fgHandle) { try { this.fgHandle.cancel(); this.stats.cancels++ } catch { /* ignore */ } this.fgHandle = null }
    for (const [, h] of this.prefetchHandles) { try { h.cancel(); this.stats.cancels++ } catch { /* ignore */ } }
    this.prefetchHandles.clear()
  }

  private async startForeground(pageNumber: number, gen: number): Promise<void> {
    const geometry = this.geometry
    if (!geometry) return
    this.events.onRenderState(true)
    try {
      const vp1 = await this.backend.readViewport1(pageNumber)
      if (gen !== this.gen || this.disposed || this.fgPage !== pageNumber) return
      const scale = this.computeScale(vp1, geometry.box, geometry.dpr)
      this.stats.renders++
      const handle = this.backend.startRender(pageNumber, scale)
      this.fgHandle = handle
      const surf = await handle.promise
      if (gen !== this.gen || this.disposed || this.fgPage !== pageNumber) {
        releaseSurface(surf) // stale surface — free it
        return
      }
      const cached = toCached(surf)
      this.cache.put(String(pageNumber), cached)
      this.fgHandle = null
      this.events.onForeground(cached, false)
      this.events.onRenderState(false)
      this.prefetchNeighbors(pageNumber)
    } catch (e) {
      this.fgHandle = null
      if (gen !== this.gen || this.disposed) return // cancelled / superseded — silent
      this.events.onRenderState(false)
      this.events.onPageError(pageNumber)
    }
  }

  private async startPrefetch(pageNumber: number, gen: number): Promise<void> {
    const geometry = this.geometry
    if (!geometry || gen !== this.gen || this.disposed) return
    try {
      const vp1 = await this.backend.readViewport1(pageNumber)
      if (gen !== this.gen || this.disposed || this.cache.has(String(pageNumber))) return
      const scale = this.computeScale(vp1, geometry.box, geometry.dpr)
      this.stats.prefetchRenders++
      const handle = this.backend.startRender(pageNumber, scale)
      this.prefetchHandles.set(pageNumber, handle)
      const surf = await handle.promise
      this.prefetchHandles.delete(pageNumber)
      if (gen === this.gen && !this.disposed && !this.cache.has(String(pageNumber))) {
        this.cache.put(String(pageNumber), toCached(surf))
      } else {
        releaseSurface(surf)
      }
    } catch {
      this.prefetchHandles.delete(pageNumber) // prefetch failure is silent
    }
  }
}
