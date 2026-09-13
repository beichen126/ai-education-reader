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
  /**
   * One identity token per pending viewport read/render. A page may leave the
   * virtual window and re-enter before PDF.js settles the cancelled render; the
   * token prevents that old promise from deleting or publishing the replacement
   * operation for the same page.
   */
  private readonly operations = new Map<number, { token: symbol; handle?: { cancel(): void } }>()
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
      this.cancelOperations()
      // A viewport read cannot be cancelled before PDF.js creates its render
      // task. Its identity token makes the old read stale while a fresh read can
      // start immediately for the new geometry.
      this.clearCache()
      this.startTargets()
    } else if (!previous && geometry) {
      // Preview can create the controller before its first layout measurement;
      // targets may already exist when the initial geometry arrives.
      this.startTargets()
    }
  }

  getStats(): { renders: number; inFlight: number; cacheSize: number; cacheCapacity: number } {
    return { renders: this.renderCount, inFlight: this.renderingCount(), cacheSize: this.cache.size, cacheCapacity: this.cache.capacity }
  }

  setTargetPages(pages: number[]): void {
    const next = new Set(pages.filter(page => Number.isInteger(page) && page >= 1 && page <= this.pageCount))
    this.targets = next
    for (const [page, operation] of this.operations) {
      if (!next.has(page)) {
        try { operation.handle?.cancel() } catch { /* ignore */ }
        this.operations.delete(page)
      }
    }
    this.events.onRendering(this.renderingCount() > 0)
    this.startTargets()
  }

  cancelAll(): void {
    this.disposed = true
    this.cancelOperations()
    this.clearCache()
    this.targets.clear()
    this.events.onRendering(false)
  }

  private cancelOperations(): void {
    for (const operation of this.operations.values()) { try { operation.handle?.cancel() } catch { /* ignore */ } }
    this.operations.clear()
    this.events.onRendering(false)
  }

  private renderingCount(): number {
    let count = 0
    for (const operation of this.operations.values()) if (operation.handle) count++
    return count
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
      if (!this.operations.has(page)) void this.startPage(page)
    }
  }

  private async startPage(pageNumber: number): Promise<void> {
    const geometry = this.geometry
    if (!geometry || this.disposed || !this.targets.has(pageNumber)) return
    const token = Symbol('continuous-render')
    const operation: { token: symbol; handle?: { cancel(): void } } = { token }
    this.operations.set(pageNumber, operation)
    this.events.onRenderStart?.(pageNumber)
    let handle: { promise: Promise<PageSurface>; cancel(): void } | null = null
    try {
      const viewport = await this.backend.readViewport1(pageNumber)
      if (this.disposed || !this.targets.has(pageNumber) || this.geometry !== geometry || this.operations.get(pageNumber)?.token !== token) return
      this.events.onPageViewport(pageNumber, viewport)
      const scale = this.computeScale(viewport, geometry.box, geometry.dpr)
      handle = this.backend.startRender(pageNumber, scale)
      operation.handle = handle
      this.renderCount++
      this.events.onRendering(true)
      const rendered = await handle.promise
      if (this.disposed || !this.targets.has(pageNumber) || this.geometry !== geometry || this.operations.get(pageNumber)?.token !== token) {
        releaseSurface(rendered)
        return
      }
      this.operations.delete(pageNumber)
      const surface = toCached(rendered)
      this.cache.put(String(pageNumber), surface)
      this.events.onPageReady(pageNumber, surface, false)
    } catch {
      const current = this.operations.get(pageNumber)?.token === token
      if (current) this.operations.delete(pageNumber)
      if (current && !this.disposed && this.targets.has(pageNumber) && this.geometry === geometry) this.events.onPageError(pageNumber)
    } finally {
      if (this.operations.get(pageNumber)?.token === token) this.operations.delete(pageNumber)
      this.events.onRendering(this.renderingCount() > 0)
    }
  }
}
