export type LocalPdfDocument = {
  fileName: string
  fileSize: number
  pageCount: number
}

export type RenderedPdfPage = {
  pageNumber: number
  blob: Blob
  /** Only created for pages the UI actually previews (large contexts show a few). */
  previewUrl?: string
  width: number
  height: number
  mimeType: string
}

/** One contiguous physical page range (1-based inclusive). */
export type PdfRange = { startPage: number; endPage: number }

/** Product safety limits for a single PDF context (NOT DeepSeek/API limits). */
export const PDF_CONTEXT_SOFT_WARNING_PAGES = 30
export const MAX_PDF_CONTEXT_PAGES = 120
export const MAX_PDF_GROUP_RAW_BYTES = 24 * 1024 * 1024
export const PDF_GROUP_PREVIEW_BATCH = 24
/** Preview thumbnails shown at the panel for large contexts: first 3 + last 3. */
export const PDF_LARGE_PREVIEW_COUNT = 3

/** Page-count soft warning: allow but ask for confirmation (>30, <=120). */
export function needsPdfContextSoftConfirm(pageCount: number): boolean {
  return pageCount > PDF_CONTEXT_SOFT_WARNING_PAGES && pageCount <= MAX_PDF_CONTEXT_PAGES
}
/** Page-count hard product limit (>120): block outright. */
export function exceedsPdfContextHardLimit(pageCount: number): boolean {
  return pageCount > MAX_PDF_CONTEXT_PAGES
}
/** Real accumulated raw-byte budget for one generated group (24 MiB). */
export function exceedsPdfGroupByteBudget(totalBytes: number): boolean {
  return totalBytes > MAX_PDF_GROUP_RAW_BYTES
}

export const PDF_FILE_MIME = 'application/pdf'
export const PDF_FILE_ACCEPT = '.pdf,application/pdf'
/** Stable, readable generated-attachment name: <stem>-pNNNN.jpg (zero-padded page). */
export function pdfPageAttachmentName(fileName: string, pageNumber: number): string {
  const stem = fileName.replace(/\.pdf$/i, '')
  return stem + '-p' + String(pageNumber).padStart(4, '0') + '.jpg'
}
/** Sorted, deduped list of normalized page ranges. Overlapping AND adjacent input
 * ranges are merged (the rendered page set is identical), so no two output ranges
 * overlap or touch. */
export function normalizePdfRanges(ranges: PdfRange[]): PdfRange[] {
  const valid = ranges
    .filter(r => Number.isInteger(r.startPage) && Number.isInteger(r.endPage) && r.startPage >= 1 && r.endPage >= r.startPage)
    .map(r => ({ startPage: r.startPage, endPage: r.endPage }))
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage)
  const out: PdfRange[] = []
  for (const r of valid) {
    const last = out[out.length - 1]
    // Overlapping (20-60 + 30-40) and adjacent (20-40 + 41-60) ranges merge: the
    // rendered page set is identical, and duplicate pages must never be sent twice.
    if (last && r.startPage <= last.endPage + 1) last.endPage = Math.max(last.endPage, r.endPage)
    else out.push({ ...r })
  }
  return out
}

/** Number of unique physical pages covered by normalized ranges (deduped). */
export function countPdfRangePages(ranges: PdfRange[]): number {
  return normalizePdfRanges(ranges).reduce((s, r) => s + (r.endPage - r.startPage + 1), 0)
}

/** Every physical page in normalized range order (each page rendered exactly once). */
export function expandPdfRangePages(ranges: PdfRange[]): number[] {
  const out: number[] = []
  for (const r of normalizePdfRanges(ranges)) { for (let n = r.startPage; n <= r.endPage; n++) out.push(n) }
  return out
}

/** Compact display text for a normalized range list: `PDF 7–8, 100–118` (`第 N 页` for singles). */
export function pdfRangesText(ranges: PdfRange[]): string {
  const rs = normalizePdfRanges(ranges)
  if (rs.length === 0) return ''
  return 'PDF ' + rs.map(r => r.startPage === r.endPage ? '第 ' + r.startPage + ' 页' : r.startPage + '–' + r.endPage).join(', ')
}

/** Human-readable title for a selection — single chapter keeps its own title;
 * multiple chapters join ALL selected node titles with '、' (callers pass them in
 * PDF outline order, NOT click order). Cap/truncation is a display concern. */
export function pdfSelectionTitle(titles: string[]): string {
  const list = titles.filter(t => t != null && t.trim() !== '')
  if (list.length === 0) return ''
  return list.join('、')
}

/** Minimal provenance of the user's PDF selection, stored on every page Attachment.
 * Multi-range from Stage 9.1: chapters may be non-contiguous; `ranges` is the
 * normalized, deduped page set; `selectedChapterIds` keeps the original chapter refs. */
export type PdfSelection = {
  kind: 'outline' | 'manual'
  title?: string
  ranges: PdfRange[]
  selectedChapterIds?: string[]
}

/** Payload handed from the PDF panel to the engine when the user clicks 加入对话. */
export type PdfAddPayload = {
  fileName: string
  selection: PdfSelection
  pages: RenderedPdfPage[]
}