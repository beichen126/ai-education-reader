import { waitForPdfOperation } from './pdf-abort'
import { ensurePageOcr } from '../documents/document-ocr'
import { renderPdfContextRanges, type PdfContextRenderOptions } from './pdf-context-render'

/** A tiny durable placeholder; the source page is resolved only when previewed. */
export function deferredPdfPreview(): Blob {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0))
  return new Blob([bytes], { type: 'image/png' })
}

export async function prepareOcrPages(documentId: string, opts: PdfContextRenderOptions, keepPreview = false) {
  return renderPdfContextRanges({ ...opts, renderPage: async page => {
    let rendered: Awaited<ReturnType<typeof opts.renderPage>> | undefined
    const ocr = await waitForPdfOperation(ensurePageOcr(documentId, page, async () => {
      if (opts.isCancelled?.()) throw new Error('已取消')
      rendered = await opts.renderPage(page)
      if (opts.isCancelled?.()) throw new Error('已取消')
      return rendered.blob
    }), opts.signal)
    if (keepPreview && !rendered) rendered = await opts.renderPage(page)
    return { ...(rendered ?? { blob: deferredPdfPreview(), width: 1, height: 1, mimeType: 'image/png' }), ocr, previewDeferred: !rendered }
  } })
}
