import { BoundedPageCache } from './pdf-page-cache'
import { computeDisplayScale } from './pdf-render-policy'
import type { PageSurface } from './pdf-service'
import type { CachedSurface, DisplayGeometry, RenderBackend, ScaleFn } from './reader-render-controller'

export type ContinuousRenderEvents = {
  onPageReady(pageNumber: number, surface: CachedSurface, fromCache: boolean): void
  onPageEvicted(pageNumber: number): void
  onPageViewport(pageNumber: number, viewport: { width: number; height: number }): void
  onPageError(pageNumber: number): void
  onRendering(rendering: boolean): void
  onRenderStart?(pageNumber: number): void
}

export type ContinuousRenderOptions = {
  cacheCapacity?: number
  pageCount?: number
  computeScale?: ScaleFn
}

function releaseSurface(page: PageSurface): void {
  const s = page.surface as unknown as { close?: unknown }
  if (typeof s.close === 'function') { try { (page.surface as ImageBitmap).close() } catch { /* ignore */ } }
}

function toCached(page: PageSurface): CachedSurface {
  return {
    surface: page.surface,
    width: page.width,
    height: page.height,
    scale: page.scale,
    pageNumber: page.pageNumber,
    dispose() { releaseSurface(page) },
  }
}

/**
 * Bounded multi-page counterpart to ReaderRenderController. It only renders the
 * requested virtual window, keeps at most `cacheCapacity` surfaces, and cancels
 * work that leaves the window. It deliberately has no React or DOM dependency.
 */
export class ContinuousRenderController {
  private readonly backend: RenderBackend
  private readonly events: ContinuousRenderEvents
  private readonly computeScale: ScaleFn
  private readonly cache: BoundedPageCache<CachedSurface>
  private readonly inFlight = new Map<number, { cancel(): void }>()
  private readonly pendingViewport = new Set<number>()
  private geometry: DisplayGeometry | null = null
  private pageCount: number
  private targets = new Set<number>()
  private disposed = false
  private renderCount = 0

  constructor(backend: RenderBackend, options: ContinuousRenderOptions, events: ContinuousRenderEvents) {
    this.backend = backend
    this.events = events
    this.computeScale = options.computeScale ?? computeDisplayScale
    this.pageCount = options.pageCount ?? 0
    this.cache = new BoundedPageCache<CachedSurface>(options.cacheCapacity ?? 11, (surface, key) => {
      surface.dispose()
      this.events.onPageEvicted(Number(key))
    })
  }

  setPageCount(pageCount: number): void {
    this.pageCount = Math.max(0, Math.trunc(pageCount))
    this.setTargetPages([...this.targets])
  }

  setGeometry(geometry: DisplayGeometry | null): void {
    const previous = this.geometry
    const changed = previous && geometry && (
      previous.box.width !== geometry.box.width ||
      previous.box.height !== geometry.box.height ||
      previous.dpr !== geometry.dpr
    )
    this.geometry = geometry
    if (changed) {
      this.cancelInFlight()
      // A viewport read cannot be cancelled before PDF.js creates its render
      // task. Let old reads finish as stale, then start a fresh read for the
      // new geometry instead of suppressing it with the old pending marker.
      this.pendingViewport.clear()
      this.clearCache()
      this.startTargets()
    } else if (!previous && geometry) {
      // Preview can create the controller before its first layout measurement;
      // targets may already exist when the initial geometry arrives.
      this.startTargets()
    }
  }

  getStats(): { renders: number; inFlight: number; cacheSize: number; cacheCapacity: number } {
    return { renders: this.renderCount, inFlight: this.inFlight.size, cacheSize: this.cache.size, cacheCapacity: this.cache.capacity }
  }

  setTargetPages(pages: number[]): void {
    const next = new Set(pages.filter(page => Number.isInteger(page) && page >= 1 && page <= this.pageCount))
    this.targets = next
    for (const [page, handle] of this.inFlight) {
      if (!next.has(page)) {
        try { handle.cancel() } catch { /* ignore */ }
        this.inFlight.delete(page)
      }
    }
    this.events.onRendering(this.inFlight.size > 0)
    this.startTargets()
  }

  cancelAll(): void {
    this.disposed = true
    this.cancelInFlight()
    this.pendingViewport.clear()
    this.clearCache()
    this.targets.clear()
    this.events.onRendering(false)
  }

  private cancelInFlight(): void {
    for (const handle of this.inFlight.values()) { try { handle.cancel() } catch { /* ignore */ } }
    this.inFlight.clear()
    this.events.onRendering(false)
  }

  private clearCache(): void {
    for (const key of this.cache.keys()) {
      const page = Number(key)
      const surface = this.cache.delete(key)
      if (surface) { surface.dispose(); this.events.onPageEvicted(page) }
    }
  }

  private startTargets(): void {
    if (this.disposed || !this.geometry) return
    for (const page of this.targets) {
      const cached = this.cache.get(String(page))
      if (cached) { this.events.onPageReady(page, cached, true); continue }
      if (!this.inFlight.has(page) && !this.pendingViewport.has(page)) void this.startPage(page)
    }
  }

  private async startPage(pageNumber: number): Promise<void> {
    const geometry = this.geometry
    if (!geometry || this.disposed || !this.targets.has(pageNumber)) return
    this.pendingViewport.add(pageNumber)
    this.events.onRenderStart?.(pageNumber)
    let handle: { promise: Promise<PageSurface>; cancel(): void } | null = null
    try {
      const viewport = await this.backend.readViewport1(pageNumber)
      if (this.disposed || !this.targets.has(pageNumber) || this.geometry !== geometry) return
      this.events.onPageViewport(pageNumber, viewport)
      const scale = this.computeScale(viewport, geometry.box, geometry.dpr)
      handle = this.backend.startRender(pageNumber, scale)
      this.inFlight.set(pageNumber, handle)
      this.renderCount++
      this.events.onRendering(true)
      const rendered = await handle.promise
      this.inFlight.delete(pageNumber)
      if (this.disposed) { releaseSurface(rendered); return }
      const surface = toCached(rendered)
      this.cache.put(String(pageNumber), surface)
      this.events.onPageReady(pageNumber, surface, false)
    } catch {
      this.inFlight.delete(pageNumber)
      if (!this.disposed && this.targets.has(pageNumber)) this.events.onPageError(pageNumber)
    } finally {
      this.pendingViewport.delete(pageNumber)
      this.events.onRendering(this.inFlight.size > 0)
    }
  }
}
