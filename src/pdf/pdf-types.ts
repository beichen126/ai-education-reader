export type LocalPdfDocument = {
  fileName: string
  fileSize: number
  pageCount: number
}

export type RenderedPdfPage = {
  pageNumber: number
  blob: Blob
  previewUrl: string
  width: number
  height: number
  mimeType: string
}

export type PdfRange = { start: number; end: number }

/** Stage 1 safety cap: a single preview render must not produce hundreds of pages. */
export const MAX_PREVIEW_PAGES = 30

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
