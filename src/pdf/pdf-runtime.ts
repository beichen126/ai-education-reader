// Shared PDF.js runtime configuration (real-world PDF rendering support).
// Single source of truth for the auxiliary runtime assets that PDF.js needs to
// decode certain image codecs / fonts. BOTH the PdfPanel singleton (pdf-service)
// and the Reader's explicit PdfSession (pdf-session) MUST call createPdfDocumentInit
// so there is no runtime drift between them.
//
// Why: without these the PDF.js worker asks for auxiliary WASM (OpenJPEG for
// JPX/JPEG2000, JBIG2, qcms for ICC) / CMap / standard font files at the default
// path and throws "Ensure that the wasmUrl API parameter is provided." In the
// default non-stopAtErrors mode the worker swallows that and returns a BLANK
// canvas while still resolving the render promise — exactly the "some pages
// normal, many pages pure white" symptom. This module points those requests at
// the assets we publish under the app base path.
//
// Assets are committed under public/pdfjs/{wasm,cmaps,standard_fonts,iccs}
// (Vite copies public/ verbatim to dist and serves it at BASE_URL in dev and on
// GitHub Pages). They are redistributed under pdfjs-dist's own licensing
// (Apache-2.0 for pdf.js; the bundled OpenJPEG / JBIG2 / qcms wasm ship their own
// LICENSE files alongside, included in public/pdfjs/wasm).
//
import { readBlobBuffer } from '../engine/read-blob-buffer'
import { waitForPdfOperation } from './pdf-abort'
import type * as PdfJs from 'pdfjs-dist'

const PDFJS_ASSET_DIR = 'pdfjs/'
export const LARGE_PDF_BYTES = 32 * 1024 * 1024

export type PdfDocumentInit = Parameters<typeof import('pdfjs-dist').getDocument>[0]

/** Absolute base (with trailing slash) under which the app is served. */
function assetBase(): string {
  // Vite injects import.meta.env.BASE_URL = "/ai-education-reader/"; works in
  // dev, preview and GitHub Pages. Never hardcode a root URL.
  const base = (import.meta.env?.BASE_URL || '/') as string
  return base.endsWith('/') ? base : base + '/'
}

export const PDFJS_RUNTIME = {
  wasmUrl: assetBase() + PDFJS_ASSET_DIR + 'wasm/',
  cMapUrl: assetBase() + PDFJS_ASSET_DIR + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: assetBase() + PDFJS_ASSET_DIR + 'standard_fonts/',
  iccUrl: assetBase() + PDFJS_ASSET_DIR + 'iccs/',
}

/**
 * Build the PDF.js getDocument init for ANY document source with the full runtime
 * config wired consistently. Use for openPdf() and openPdfSession() alike.
 */
export function createPdfDocumentInit(data: ArrayBuffer): PdfDocumentInit {
  return {
    data,
    ...PDFJS_RUNTIME,
  }
}

/** Keep large local files disk-backed. PDF.js can then seek to the xref and read
 * only the data required for the current page instead of copying the whole book. */
export async function openLocalPdfTask(source: Blob, pdfjs: Pick<typeof PdfJs, 'getDocument' | 'PDFDataRangeTransport'>, signal?: AbortSignal) {
  if (source.size < LARGE_PDF_BYTES) return pdfjs.getDocument(createPdfDocumentInit(await waitForPdfOperation(readBlobBuffer(source), signal)))

  let abortRead: () => void
  class BlobTransport extends pdfjs.PDFDataRangeTransport {
    private stopped = false

    requestDataRange(begin: number, end: number) {
      if (this.stopped) return
      void readBlobBuffer(source.slice(begin, end)).then(buffer => {
        if (this.stopped) return
        if (buffer.byteLength !== end - begin) throw new Error('Incomplete PDF range')
        this.onDataRange(begin, new Uint8Array(buffer))
      }).catch(() => {
        if (!this.stopped) abortRead()
      })
    }

    abort() { this.stopped = true }
  }
  const range = new BlobTransport(source.size, new Uint8Array(), false)
  const task = pdfjs.getDocument({
    ...PDFJS_RUNTIME,
    range,
    // Fewer Blob reads when the worker seeks through adjacent scanned pages.
    rangeChunkSize: 256 * 1024,
    disableStream: true,
    disableAutoFetch: true,
  })
  abortRead = () => { range.abort(); void task.destroy().catch(() => {}) }
  return task
}
