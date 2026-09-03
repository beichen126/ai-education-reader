// Explicit PDF session runtime (Stage 9.2B1). The full Reader must NOT depend on
// pdf-service's single activeDoc/activeLoadingTask singleton (which the PdfPanel
// owns): one Reader instance owns its own PdfSession, so opening/closing the
// reader can never disturb a Composer PDF panel (and vice versa).
import * as pdfjsLib from 'pdfjs-dist'
// Same worker wiring as pdf-service (static ES-module asset under the app base path).
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDF_FILE_MIME, type LocalPdfDocument } from './pdf-types.ts'
import { PdfError, pdfErrorMessage, renderPageForDocument, readOutlineForDocument, type RenderedPage } from './pdf-service.ts'
import type { PdfOutlineResult } from './pdf-outline.ts'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type PdfSession = {
  loadingTask: ReturnType<typeof pdfjsLib.getDocument>
  documentProxy: import('pdfjs-dist').PDFDocumentProxy
}

/** Open a Blob/File as an independent PDF session. Throws PdfError on failure. */
export async function openPdfSession(blob: Blob): Promise<{ session: PdfSession; doc: LocalPdfDocument }> {
  const looksLikePdf = blob.type === PDF_FILE_MIME
  if (!looksLikePdf) throw new PdfError('not-pdf', 'not a pdf')
  const task = pdfjsLib.getDocument({ data: await blob.arrayBuffer() })
  let proxy: import('pdfjs-dist').PDFDocumentProxy
  try { proxy = await task.promise } catch { try { await task.destroy() } catch { /* ignore */ } throw new PdfError('parse-failed', 'parse failed') }
  if (proxy.numPages < 1) { try { await task.destroy() } catch { /* ignore */ } throw new PdfError('empty', 'empty') }
  return {
    session: { loadingTask: task, documentProxy: proxy },
    doc: { fileName: (typeof (blob as any).name === 'string' ? (blob as any).name : 'document.pdf'), fileSize: blob.size, pageCount: proxy.numPages },
  }
}

/** Render one page of a session (shared core with the PdfPanel singleton). */
export async function renderSessionPage(session: PdfSession, pageNumber: number): Promise<RenderedPage> {
  return renderPageForDocument(session.documentProxy, pageNumber)
}

/** Read the native outline of a session. */
export async function readSessionOutline(session: PdfSession): Promise<PdfOutlineResult> {
  return readOutlineForDocument(session.documentProxy)
}

/** Destroy the session and release its worker. Safe to call multiple times. */
export async function closePdfSession(session: PdfSession | null): Promise<void> {
  if (!session) return
  try { await session.loadingTask.destroy() } catch { /* ignore */ }
}
export { pdfErrorMessage }
