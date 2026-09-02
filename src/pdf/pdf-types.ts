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
