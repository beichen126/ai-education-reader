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

export type PdfRange = { start: number; end: number }

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
/** Minimal provenance of the user's PDF selection, stored on every page Attachment. */
export type PdfSelection = {
  kind: 'outline' | 'manual'
  title?: string
  startPage: number
  endPage: number
}

/** Payload handed from the PDF panel to the engine when the user clicks 加入对话. */
export type PdfAddPayload = {
  fileName: string
  selection: PdfSelection
  pages: RenderedPdfPage[]
}