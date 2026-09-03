// React-side orchestration for the PDF preview panel. Keeps PDF.js out of the
// UI; owns the component state machine, page-range validation, objectURL and
// document lifecycle. Also reads the document outline (same active document).
// Stage 6: large-context safety — sequential render with a real accumulated
// raw-byte budget (stop >24 MiB), all-or-nothing on page failure, and a
// "first-3 + last-3" preview strategy for >30 page contexts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { openPdf, renderPdfPage, closePdf, readPdfOutline, pdfErrorMessage, PdfError } from './pdf-service'
export { validatePdfRange } from './pdf-types'

import { PdfOutlineError, type PdfOutlineResult } from './pdf-outline'
import { renderPdfContextRanges, PdfContextRenderError } from './pdf-context-render'
import { createDocument, updateDocumentChapters, cleanupStaleDocument } from '../documents/document-service'
import { chapterNodesFromPdfOutline } from '../documents/chapter-model'
import { newStableId } from '../engine/types'
import {
  PDF_CONTEXT_SOFT_WARNING_PAGES, MAX_PDF_CONTEXT_PAGES, PDF_LARGE_PREVIEW_COUNT,
  normalizePdfRanges,
  type LocalPdfDocument, type RenderedPdfPage, type PdfRange,
} from './pdf-types'


export type PdfPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PdfProgress = { done: number; total: number; bytes: number }
export type PdfOutlineStatus = 'idle' | 'loading' | 'ready' | 'error'

export type PdfPreviewApi = {
  doc: LocalPdfDocument | null
  pages: RenderedPdfPage[]
  status: PdfPreviewStatus
  error: string | undefined
  progress: PdfProgress | undefined
  outline: PdfOutlineResult | null
  outlineStatus: PdfOutlineStatus
  outlineError: string | undefined
  /** Persistent local Document id for the currently opened PDF (undefined when unsaved). */
  documentId: string | undefined
  /** Non-fatal warning: the PDF works temporarily but could NOT be saved locally. */
  documentSaveError: string | undefined
  selectFile: (file: File) => Promise<void>
  generateRanges: (ranges: PdfRange[]) => Promise<void>
  clearPreview: () => void
  reset: () => Promise<void>
}

export function usePdfPreview(): PdfPreviewApi {
  const [doc, setDoc] = useState<LocalPdfDocument | null>(null)
  const [pages, setPages] = useState<RenderedPdfPage[]>([])
  const [status, setStatus] = useState<PdfPreviewStatus>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState<PdfProgress | undefined>(undefined)
  const [outline, setOutline] = useState<PdfOutlineResult | null>(null)
  const [outlineStatus, setOutlineStatus] = useState<PdfOutlineStatus>('idle')
  const [outlineError, setOutlineError] = useState<string | undefined>(undefined)
  const [documentId, setDocumentId] = useState<string | undefined>(undefined)
  const [documentSaveError, setDocumentSaveError] = useState<string | undefined>(undefined)
  const urlsRef = useRef<string[]>([])
  const genRef = useRef(0)

  const revokeAll = useCallback(() => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u)
    urlsRef.current = []
  }, [])

  const cleanup = useCallback(async () => {
    genRef.current++
    revokeAll()
    await closePdf()
  }, [revokeAll])

  useEffect(() => () => { void cleanup() }, [cleanup])

  const selectFile = useCallback(async (file: File) => {
    genRef.current++
    const gen = genRef.current
    revokeAll()
    setDoc(null); setPages([]); setStatus('loading'); setError(undefined); setProgress(undefined)
    setOutline(null); setOutlineStatus('loading'); setOutlineError(undefined)
    setDocumentId(undefined); setDocumentSaveError(undefined)
    try {
      const d = await openPdf(file)
      if (gen !== genRef.current) return
      setDoc(d); setStatus('ready')
      // Stage 9.2A: persistent local Document — the original file becomes a
      // first-class object. A storage failure never breaks the temporary workflow.
      let docId: string | undefined
      try {
        const created = await createDocument({
          id: newStableId(),
          fileName: d.fileName,
          mimeType: 'application/pdf',
          fileSize: d.fileSize,
          pageCount: d.pageCount,
          sourceBlob: file,
          importSource: { kind: 'pdf', originalFileName: file.name },
        })
        if (gen !== genRef.current) {
          // Import superseded while the write was in flight: never leave a ghost Document.
          void cleanupStaleDocument(created.id)
          return
        }
        docId = created.id
        setDocumentId(created.id)
      } catch {
        if (gen !== genRef.current) return
        setDocumentSaveError('该 PDF 可以继续临时使用，但无法保存到本地文件库（存储空间不足或写入失败）。')
      }
      try {
        const o = await readPdfOutline()
        if (gen !== genRef.current) return
        setOutline(o); setOutlineStatus('ready'); setOutlineError(undefined)
        if (docId && o.items.length > 0) {
          // Persist the chapter tree; failure only loses future reader metadata,
          // never the already-created document or the current preview flow.
          void updateDocumentChapters(docId, chapterNodesFromPdfOutline(o.items), 'native').catch(() => {})
        }
      } catch (e) {
        if (gen !== genRef.current) return
        setOutlineStatus('error')
        setOutlineError(e instanceof PdfOutlineError ? e.message : '无法读取该 PDF 的书签。')
      }
    } catch (e: unknown) {
      if (gen !== genRef.current) return
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : 'PDF 处理失败。')
      setStatus('error'); setOutlineStatus('idle')
    }
  }, [revokeAll])

  // Stage 9.1/9.2B2: ALL safety/render policy lives in the shared render core
  // (renderPdfContextRanges) — the same one the Document Reader uses. This hook
  // only keeps UI orchestration: preview URL ownership (first-3/last-3), pages
  // state, progress display and user-facing error mapping.
  const generateRanges = useCallback(async (ranges: PdfRange[]) => {
    if (!doc) { setError('尚未打开 PDF 文件。'); return }
    if (normalizePdfRanges(ranges).length === 0) { setError('请先选择页面范围。'); return }
    genRef.current++
    const gen = genRef.current
    revokeAll()
    setPages([]); setError(undefined)
    const built: RenderedPdfPage[] = []
    const previewIdx = new Set<number>()
    const markPreview = (total: number) => {
      previewIdx.clear()
      if (total <= PDF_CONTEXT_SOFT_WARNING_PAGES) { for (let k = 0; k < total; k++) previewIdx.add(k) }
      else { for (let k = 0; k < PDF_LARGE_PREVIEW_COUNT; k++) { previewIdx.add(k); previewIdx.add(total - 1 - k) } }
    }
    try {
      const result = await renderPdfContextRanges({
        ranges,
        pageCount: doc.pageCount,
        renderPage: renderPdfPage,
        isCancelled: () => gen !== genRef.current,
        onProgress: (p) => { if (gen === genRef.current) setProgress(p) },
        onPage: (page, index, total) => {
          if (gen !== genRef.current) return
          if (built.length === 0) markPreview(total)
          const previewUrl = previewIdx.has(index) ? URL.createObjectURL(page.blob) : undefined
          if (previewUrl) urlsRef.current.push(previewUrl)
          built.push({ ...page, ...(previewUrl ? { previewUrl } : {}) })
          setPages([...built])
        },
      })
      if (gen === genRef.current) setProgress(undefined)
    } catch (e: unknown) {
      if (gen !== genRef.current) return // stale / cancelled -> silent
      genRef.current++
      revokeAll()
      setPages([]); setProgress(undefined)
      if (e instanceof PdfContextRenderError) {
        if (e.kind === 'hard-limit') setError('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请减少选择的页面范围后重试。')
        else if (e.kind === 'byte-budget') setError('该范围生成的图片数据过大，已超过当前单次 PDF Context 的安全限制。请减少选择的页面范围后重试。（本次处理到第 ' + (e.pageNumber ?? '') + ' 页时超过限制。）')
        else if (e.kind === 'render-failed') setError('第 ' + (e.pageNumber ?? '') + ' 页处理失败，本次范围未加入对话。你可以重新尝试，或切换到“选页”模式缩小范围。')
        else if (e.kind === 'out-of-range') setError('页码范围超出范围，该 PDF 共 ' + doc.pageCount + ' 页。')
        else setError(e.message)
      } else {
        setError('PDF 处理失败。')
      }
    } finally {
      if (gen === genRef.current) setProgress(undefined)
    }
  }, [doc, revokeAll])

  const clearPreview = useCallback(() => {
    genRef.current++
    revokeAll()
    setPages([]); setProgress(undefined)
  }, [revokeAll])

  const reset = useCallback(async () => {
    await cleanup()
    setDoc(null); setPages([]); setStatus('idle'); setError(undefined); setProgress(undefined)
    setOutline(null); setOutlineStatus('idle'); setOutlineError(undefined)
    setDocumentId(undefined); setDocumentSaveError(undefined)
  }, [cleanup])

  return { doc, pages, status, error, progress, outline, outlineStatus, outlineError, documentId, documentSaveError, selectFile, generateRanges, clearPreview, reset }
}
