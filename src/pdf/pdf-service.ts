// PDF.js integration boundary. UI never touches PDF.js directly.
// Responsibilities: document open/close, page render (Canvas -> Blob), worker config.
//
// Stage 1 invariant: rendered pages are Blobs used ONLY for local preview.
// They are never written to attachments / draft / messages / Gallery, and never
// sent to the AI. Stage 2 will feed these Blobs into the existing attachment service.
import * as pdfjsLib from 'pdfjs-dist'
// Emit the ES-module worker as a static asset; pdfjs v6 constructs a module
// worker (new Worker(url, { type: "module" })) and, being same-origin with the
// app, uses this URL directly (no CDN wrapper, no fake worker, no 404 under the
// /ai-education-reader/ base path).
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createPdfDocumentInit } from './pdf-runtime'
import { PDF_FILE_MIME, type LocalPdfDocument } from './pdf-types.ts'
import { parsePdfOutline, type PdfOutlineResult } from './pdf-outline.ts'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

import { MAX_RENDER_EDGE, MAX_SCALE, MAX_RENDER_PIXELS, clampRenderScale, isPasswordError } from './pdf-render-policy'
export { MAX_RENDER_EDGE, MAX_SCALE, MAX_RENDER_PIXELS, clampRenderScale, isPasswordError } from './pdf-render-policy'
/** Output image format for Stage 1 preview pages. */
export const OUTPUT_IMAGE_MIME = 'image/jpeg'
export const JPEG_QUALITY = 0.88

export type PdfErrorKind =
  | 'not-pdf' | 'read-failed' | 'parse-failed' | 'empty'
  | 'not-open' | 'render-failed' | 'password'

export class PdfError extends Error {
  readonly kind: PdfErrorKind
  constructor(kind: PdfErrorKind, message: string) { super(message); this.kind = kind }
}

export function pdfErrorMessage(kind: PdfErrorKind): string {
  switch (kind) {
    case 'not-pdf': return '这不是一个 PDF 文件。'
    case 'read-failed': return 'PDF 文件读取失败，请重试。'
    case 'parse-failed': return '无法解析该 PDF，文件可能已损坏或格式不支持。'
    case 'empty': return '该 PDF 没有页面。'
    case 'not-open': return '尚未打开 PDF 文件。'
    case 'render-failed': return '页面渲染失败。'
    case 'password': return '此 PDF 需要密码，当前版本暂未支持打开受密码保护的文件。'
    default: return 'PDF 处理失败。'
  }
}

let activeDoc: import('pdfjs-dist').PDFDocumentProxy | null = null
let activeLoadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null

/**
 * Destroy any loaded document + loading task. Called before opening a new PDF,
 * when closing the panel, and on unmount, so multiple large PDFs never linger.
 */
export async function closePdf(): Promise<void> {
  const task = activeLoadingTask
  activeLoadingTask = null
  activeDoc = null
  // Destroying the loading task also tears down the underlying document + worker
  // (the .d.ts exposes destroy() on the loading task, not on PDFDocumentProxy).
  if (task) { try { await task.destroy() } catch { /* ignore */ } }
}

/**
 * Open a File with PDF.js and return its metadata. Destroys the previously
 * opened document first. Not exported as "PDFDocumentProxy" to UI: the UI only
 * ever sees LocalPdfDocument. Throws PdfError on any failure.
 */
export async function openPdf(file: File): Promise<LocalPdfDocument> {
  await closePdf()
  const looksLikePdf = file.type === PDF_FILE_MIME || /.pdf$/i.test(file.name)
  if (!looksLikePdf) throw new PdfError('not-pdf', 'not a pdf')
  let data: ArrayBuffer
  try { data = await file.arrayBuffer() } catch { throw new PdfError('read-failed', 'read failed') }
  const task = pdfjsLib.getDocument(createPdfDocumentInit(data))
  activeLoadingTask = task
  let doc: import('pdfjs-dist').PDFDocumentProxy
  try { doc = await task.promise } catch (err) {
    activeLoadingTask = null
    if (isPasswordError(err)) throw new PdfError('password', 'password protected')
    throw new PdfError('parse-failed', 'parse failed')
  }
  if (doc.numPages < 1) { try { await task.destroy() } catch { /* ignore */ } activeLoadingTask = null; throw new PdfError('empty', 'empty') }
  activeDoc = doc
  // Keep the loading task so closePdf() can destroy this document later.
  return { fileName: file.name, fileSize: file.size, pageCount: doc.numPages }
}

export type RenderedPage = { blob: Blob; width: number; height: number; mimeType: string }

/** PdfPanel singleton path: render one page of the currently active document. */
export async function renderPdfPage(pageNumber: number): Promise<RenderedPage> {
  const doc = activeDoc
  if (!doc) throw new PdfError('not-open', 'not open')
  return renderPageForDocument(doc, pageNumber)
}

/** Shared render core used by BOTH the PdfPanel singleton and explicit PDF sessions. */
export async function renderPageForDocument(doc: import('pdfjs-dist').PDFDocumentProxy, pageNumber: number): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber)
  const vp1 = page.getViewport({ scale: 1 })
  const scale = clampRenderScale(vp1)
  const vp = page.getViewport({ scale })
  const width = Math.max(1, Math.floor(vp.width))
  const height = Math.max(1, Math.floor(vp.height))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  try {
    await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise
  } catch {
    canvas.width = 0
    canvas.height = 0
    throw new PdfError('render-failed', 'render failed')
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new PdfError('render-failed', 'toBlob failed'))),
      OUTPUT_IMAGE_MIME,
      JPEG_QUALITY,
    )
  })
  // Release the large Canvas backing store now that the Blob is produced.
  canvas.width = 0
  canvas.height = 0
  return { blob, width, height, mimeType: OUTPUT_IMAGE_MIME }
}

/**
 * Read the OUTLINE of the currently open document into a parsed chapter tree.
 * Stage 3: parser only, wired for tests / future Stage 4 UI. Shares the SAME
 * open document as rendering (no second load). Throws PdfError('not-open') when
 * no document is open; PdfOutlineError when the outline itself fails to load.
 */
export async function readPdfOutline(): Promise<PdfOutlineResult> {
  const doc = activeDoc
  if (!doc) throw new PdfError('not-open', 'not open')
  return readOutlineForDocument(doc)
}

/** Shared outline core for BOTH the PdfPanel singleton and explicit PDF sessions. */
export async function readOutlineForDocument(doc: import('pdfjs-dist').PDFDocumentProxy): Promise<PdfOutlineResult> {
  return parsePdfOutline(doc)
}