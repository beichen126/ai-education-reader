// Shared PDF Context render/safety policy (Stage 9.2B2). One implementation used by
// BOTH the Composer PdfPanel and the Document Reader — no second render policy.
//
// Core responsibilities: normalize ranges, bounds check, unique-page count, 120-page
// hard limit, single-page sequential rendering, 24 MiB raw-byte budget, all-or-nothing
// failure, progress reporting, cancellation checks. The caller supplies renderPage
// (PdfPanel singleton or a Reader-owned PdfSession) and owns preview object URLs.
import { normalizePdfRanges, countPdfRangePages, expandPdfRangePages, exceedsPdfContextHardLimit, exceedsPdfGroupByteBudget, MAX_PDF_GROUP_RAW_BYTES, MAX_PDF_CONTEXT_PAGES, type PdfRange, type RenderedPdfPage } from './pdf-types'

export type PdfContextRenderErrorKind = 'empty' | 'out-of-range' | 'hard-limit' | 'byte-budget' | 'render-failed' | 'cancelled'

export class PdfContextRenderError extends Error {
  readonly kind: PdfContextRenderErrorKind
  constructor(kind: PdfContextRenderErrorKind, message: string) { super(message); this.name = 'PdfContextRenderError'; this.kind = kind }
}

export type ContextRenderProgress = { done: number; total: number; bytes: number }

export type PdfContextRenderOptions = {
  ranges: PdfRange[]
  pageCount: number
  renderPage: (pageNumber: number) => Promise<{ blob: Blob; width: number; height: number; mimeType: string }>
  onProgress?: (p: ContextRenderProgress) => void
  isCancelled?: () => boolean
}

export type PdfContextRenderResult = { pages: RenderedPdfPage[] }

/** Render the normalized unique page set of a selection into Blobs, all-or-nothing. */
export async function renderPdfContextRanges(opts: PdfContextRenderOptions): Promise<PdfContextRenderResult> {
  const norm = normalizePdfRanges(opts.ranges)
  if (norm.length === 0) throw new PdfContextRenderError('empty', 'no ranges')
  for (const r of norm) {
    if (r.startPage < 1 || r.endPage > opts.pageCount) throw new PdfContextRenderError('out-of-range', 'range out of bounds')
  }
  const total = countPdfRangePages(norm)
  if (exceedsPdfContextHardLimit(total)) throw new PdfContextRenderError('hard-limit', '当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请选择较小的页码范围。')
  const pageNumbers = expandPdfRangePages(norm)
  const pages: RenderedPdfPage[] = []
  let bytes = 0
  let failingPage = pageNumbers[0]
  for (let i = 0; i < pageNumbers.length; i++) {
    if (opts.isCancelled && opts.isCancelled()) throw new PdfContextRenderError('cancelled', 'context render cancelled')
    const n = pageNumbers[i]
    failingPage = n
    let r
    try { r = await opts.renderPage(n) } catch { throw new PdfContextRenderError('render-failed', '第 ' + n + ' 页处理失败，本次范围未加入对话。') }
    bytes += r.blob.size
    pages.push({ pageNumber: n, ...r })
    opts.onProgress && opts.onProgress({ done: pages.length, total, bytes })
    if (exceedsPdfGroupByteBudget(bytes)) throw new PdfContextRenderError('byte-budget', '该范围生成的图片数据过大，已超过当前单次 PDF Context 的安全限制（' + (MAX_PDF_GROUP_RAW_BYTES / (1024 * 1024)).toFixed(0) + ' MiB）。请减少选择的页面范围后重试。')
  }
  return { pages }
}

export { MAX_PDF_GROUP_RAW_BYTES }
