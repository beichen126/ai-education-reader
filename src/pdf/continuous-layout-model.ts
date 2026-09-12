/**
 * Pure continuous-scroll layout model (Stage 2, task §5.2).
 *
 * The model owns page heights, offsets and the virtual window. It has NO React, DOM or
 * PDF.js dependency, so a 10000-page synthetic document can be exercised in a plain
 * domain test and the scroll hot path never touches the DOM.
 *
 * Heights are estimated from a default aspect ratio until the real page viewport is
 * known. Measurements are recorded per page; a measurement above the current anchor
 * reports the scroll correction needed to keep the view visually still.
 *
 * Geometry contract: pages are stacked with `gap` between neighbours, so
 *   offset(page) = sum(height(1..page-1)) + gap * (page - 1)
 * and the stack is
 *   [topSpacer][page startPage] ... [page endPage][bottomSpacer].
 */

export type PageMetric = { page: number; estimatedHeight: number; measuredHeight?: number }

export type VirtualWindow = {
  startPage: number
  endPage: number
  /** Height of the spacer before `startPage`. */
  topSpacer: number
  /** Height of the spacer after `endPage`. */
  bottomSpacer: number
  /** The mounted pages, in order. */
  pages: number[]
}

export type AnchorCorrection = {
  /** Page whose visual stability the correction protects. */
  anchorPage: number
  /** Value to ADD to the scroll container's scrollTop. 0 when nothing above moved. */
  scrollDelta: number
}

export type ContinuousLayoutOptions = {
  pageCount: number
  /** Available width for a page, in CSS pixels. */
  contentWidth: number
  /** width / height of an unmeasured page. A4 portrait is ~0.707. */
  defaultAspectRatio?: number
  /** Vertical gap between two pages. */
  gap?: number
  /** Extra height rendered above and below the viewport. */
  overscanPx?: number
  /** Hard cap on mounted page sections. */
  maxWindowPages?: number
}

type Geometry = { contentWidth: number; viewportHeight: number; overscanPx: number }

const DEFAULT_ASPECT_RATIO = 0.707
const DEFAULT_GAP = 12
const DEFAULT_MAX_WINDOW_PAGES = 11

function clampPage(page: number, pageCount: number): number {
  const safe = Math.trunc(page)
  if (!Number.isFinite(safe)) return 1
  return Math.max(1, Math.min(Math.max(1, pageCount), safe))
}

export class ContinuousLayoutModel {
  private pageCount: number
  private contentWidth: number
  private viewportHeight = 0
  private overscanPx = 0
  private readonly defaultAspectRatio: number
  private readonly gap: number
  private readonly maxWindowPages: number
  /** page -> measured height in CSS px. */
  private readonly measuredHeights = new Map<number, number>()
  /** prefix[i] = offset of page i+1 (0-based index i). Length = pageCount + 1. */
  private prefix: number[] = [0]

  constructor(options: ContinuousLayoutOptions) {
    this.pageCount = Math.max(0, Math.trunc(options.pageCount))
    this.contentWidth = Math.max(1, options.contentWidth)
    this.defaultAspectRatio = options.defaultAspectRatio && options.defaultAspectRatio > 0 ? options.defaultAspectRatio : DEFAULT_ASPECT_RATIO
    this.gap = options.gap ?? DEFAULT_GAP
    this.overscanPx = Math.max(0, options.overscanPx ?? 0)
    this.maxWindowPages = Math.max(1, Math.trunc(options.maxWindowPages ?? DEFAULT_MAX_WINDOW_PAGES))
    this.rebuildPrefix()
  }

  getPageCount(): number { return this.pageCount }
  getContentWidth(): number { return this.contentWidth }
  getGap(): number { return this.gap }
  getMaxWindowPages(): number { return this.maxWindowPages }
  getViewportHeight(): number { return this.viewportHeight }
  getOverscanPx(): number { return this.overscanPx }

  estimatedHeight(): number { return Math.max(1, this.contentWidth / this.defaultAspectRatio) }

  setPageCount(pageCount: number): void {
    const next = Math.max(0, Math.trunc(pageCount))
    if (next === this.pageCount) return
    this.pageCount = next
    for (const page of [...this.measuredHeights.keys()]) if (page > next) this.measuredHeights.delete(page)
    this.rebuildPrefix()
  }

  setGeometry(geometry: Partial<Geometry>): void {
    let changed = false
    if (geometry.contentWidth !== undefined) {
      const width = Math.max(1, geometry.contentWidth)
      if (width !== this.contentWidth) { this.contentWidth = width; changed = true }
    }
    if (geometry.viewportHeight !== undefined) this.viewportHeight = Math.max(0, geometry.viewportHeight)
    if (geometry.overscanPx !== undefined) this.overscanPx = Math.max(0, geometry.overscanPx)
    // A width change rescales every measured height: keep the aspect ratio, drop the pixels.
    if (changed) { this.measuredHeights.clear(); this.rebuildPrefix() }
  }

  /** Drop all measurements (document switch). The caller keeps the geometry. */
  clearMeasurements(): void {
    if (this.measuredHeights.size === 0) return
    this.measuredHeights.clear()
    this.rebuildPrefix()
  }

  hasMeasurement(page: number): boolean { return this.measuredHeights.has(page) }
  measurementCount(): number { return this.measuredHeights.size }

  heightFor(page: number): number {
    const measured = this.measuredHeights.get(page)
    return measured !== undefined ? measured : this.estimatedHeight()
  }

  metricFor(page: number): PageMetric {
    const safe = clampPage(page, this.pageCount)
    return { page: safe, estimatedHeight: this.estimatedHeight(), measuredHeight: this.measuredHeights.get(safe) }
  }

  /** Top offset of a page inside the stack. */
  offsetOf(page: number): number {
    if (this.pageCount <= 0) return 0
    const safe = clampPage(page, this.pageCount)
    return this.prefix[safe - 1]
  }

  totalHeight(): number {
    if (this.pageCount <= 0) return 0
    return this.offsetOf(this.pageCount) + this.heightFor(this.pageCount)
  }

  /** Scroll offset that puts a page at the top of the viewport, or centres it. */
  offsetForPage(page: number, align: 'start' | 'center' = 'start'): number {
    if (this.pageCount <= 0) return 0
    const safe = clampPage(page, this.pageCount)
    const top = this.offsetOf(safe)
    if (align !== 'center') return top
    return Math.max(0, top - Math.max(0, (this.viewportHeight - this.heightFor(safe)) / 2))
  }

  /** Page that owns the vertical centre of the viewport. */
  pageAtViewportCenter(scrollTop: number): number {
    if (this.pageCount <= 0) return 1
    return this.pageAtOffset(scrollTop + this.viewportHeight / 2)
  }

  /**
   * The mounted page window for a scroll position. Never returns more than
   * `maxWindowPages` pages, whatever the overscan or viewport size.
   */
  getVirtualWindow(scrollTop: number): VirtualWindow {
    if (this.pageCount <= 0) return { startPage: 1, endPage: 0, topSpacer: 0, bottomSpacer: 0, pages: [] }
    const top = Math.max(0, scrollTop - this.overscanPx)
    const bottom = scrollTop + this.viewportHeight + this.overscanPx
    let startPage = this.pageAtOffset(top)
    if (startPage < this.pageCount && this.offsetOf(startPage) + this.heightFor(startPage) <= top) startPage++
    let endPage = Math.max(startPage, this.pageAtOffset(bottom))
    const span = endPage - startPage + 1
    if (span > this.maxWindowPages) {
      const centre = this.pageAtViewportCenter(scrollTop)
      const half = Math.floor(this.maxWindowPages / 2)
      startPage = Math.max(1, Math.min(this.pageCount - this.maxWindowPages + 1, centre - half))
      endPage = startPage + this.maxWindowPages - 1
    }
    const pages: number[] = []
    for (let page = startPage; page <= endPage; page++) pages.push(page)
    const topSpacer = this.offsetOf(startPage)
    const bottomSpacer = Math.max(0, this.totalHeight() - this.offsetOf(endPage) - this.heightFor(endPage))
    return { startPage, endPage, topSpacer, bottomSpacer, pages }
  }

  /**
   * Record the real aspect ratio of a rendered page. Returns the scroll correction the
   * caller must apply so a size change above the current anchor does not visibly jump.
   */
  recordPageAspect(page: number, aspectRatio: number, anchorPage: number): AnchorCorrection {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return { anchorPage, scrollDelta: 0 }
    return this.recordPageHeight(page, this.contentWidth / aspectRatio, anchorPage)
  }

  recordPageHeight(page: number, height: number, anchorPage: number): AnchorCorrection {
    if (this.pageCount <= 0) return { anchorPage, scrollDelta: 0 }
    const safe = clampPage(page, this.pageCount)
    const next = Math.max(1, height)
    const previous = this.measuredHeights.get(safe)
    if (previous !== undefined && Math.abs(previous - next) < 0.5) return { anchorPage, scrollDelta: 0 }
    const before = previous ?? this.estimatedHeight()
    this.measuredHeights.set(safe, next)
    this.rebuildPrefix()
    // Everything after `page` moved by (next - before). Only a page ABOVE the anchor
    // shifts the content the user is looking at, so only then is a correction needed.
    const scrollDelta = safe < clampPage(anchorPage, this.pageCount) ? next - before : 0
    return { anchorPage, scrollDelta }
  }

  /** Page containing a vertical offset inside the stack. */
  private pageAtOffset(offset: number): number {
    if (offset <= 0) return 1
    let low = 1
    let high = this.pageCount
    let result = 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (this.offsetOf(mid) <= offset) { result = mid; low = mid + 1 } else { high = mid - 1 }
    }
    return result
  }

  private rebuildPrefix(): void {
    const count = this.pageCount
    const prefix = new Array<number>(count + 1)
    prefix[0] = 0
    const estimated = this.estimatedHeight()
    for (let index = 0; index < count; index++) {
      const page = index + 1
      const height = this.measuredHeights.get(page) ?? estimated
      // prefix[index] is the offset of page index+1; adding this page's height and the
      // following gap gives the offset of the next page.
      prefix[index + 1] = prefix[index] + height + this.gap
    }
    this.prefix = prefix
  }
}
