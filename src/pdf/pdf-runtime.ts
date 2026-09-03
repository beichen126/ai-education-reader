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
// NOTE: keep this module React-free and free of any pdfjs-dist import needed only
// for rendering — it is imported by the PDF.js-facing services.
const PDFJS_ASSET_DIR = 'pdfjs/'

export type PdfDocumentInit = Parameters<typeof import('pdfjs-dist').getDocument>[0]

/** Absolute base (with trailing slash) under which the app is served. */
function assetBase(): string {
  // Vite injects import.meta.env.BASE_URL = "/ai-education-reader/"; works in
  // dev, preview and GitHub Pages. Never hardcode a root URL.
  const base = (import.meta.env.BASE_URL || '/') as string
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
