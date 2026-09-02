// React-side orchestration for the PDF preview panel. Keeps PDF.js out of the
// UI; owns the component state machine, page-range validation, objectURL and
// document lifecycle. Does NOT touch attachments/draft/messages/API.
import { useCallback, useEffect, useRef, useState } from 'react'
import { openPdf, renderPdfPage, closePdf, pdfErrorMessage, PdfError } from './pdf-service'
import { MAX_PREVIEW_PAGES, type LocalPdfDocument, type RenderedPdfPage } from './pdf-types'

/**
 * Validate the user-entered page range. Returns a user-facing error string, or
 * null when the range is acceptable.
 */
export function validatePdfRange(startText: string, endText: string, pageCount: number): string | null {
  const startRaw = startText.trim()
  const endRaw = endText.trim()
  if (startRaw === '' || endRaw === '') return '请输入开始页和结束页。'
  const start = Number(startRaw)
  const end = Number(endRaw)
  if (!Number.isInteger(start) || !Number.isInteger(end)) return '页码必须是整数。'
  if (start < 1 || end < 1) return '页码不能小于 1。'
  if (start > pageCount) return '开始页超出范围，该 PDF 共 ' + pageCount + ' 页。'
  if (end > pageCount) return '结束页超出范围，该 PDF 共 ' + pageCount + ' 页。'
  if (start > end) return '开始页不能大于结束页。'
  if (end - start + 1 > MAX_PREVIEW_PAGES) return '本阶段单次最多预览 ' + MAX_PREVIEW_PAGES + ' 页，请缩小页码范围。'
  return null
}

export type PdfPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PdfProgress = { done: number; total: number }

export type PdfPreviewApi = {
  doc: LocalPdfDocument | null
  pages: RenderedPdfPage[]
  status: PdfPreviewStatus
  error: string | undefined
  progress: PdfProgress | undefined
  selectFile: (file: File) => Promise<void>
  generate: (startText: string, endText: string) => Promise<void>
  reset: () => Promise<void>
}

export function usePdfPreview(): PdfPreviewApi {
  const [doc, setDoc] = useState<LocalPdfDocument | null>(null)
  const [pages, setPages] = useState<RenderedPdfPage[]>([])
  const [status, setStatus] = useState<PdfPreviewStatus>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState<PdfProgress | undefined>(undefined)
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

  // Unmount -> clear objectURLs + destroy the document.
  useEffect(() => () => { void cleanup() }, [cleanup])

  const selectFile = useCallback(async (file: File) => {
    genRef.current++
    const gen = genRef.current
    revokeAll()
    setDoc(null); setPages([]); setStatus('loading'); setError(undefined); setProgress(undefined)
    try {
      const d = await openPdf(file)
      if (gen !== genRef.current) return // superseded by a newer select/close
      setDoc(d); setStatus('ready')
    } catch (e: unknown) {
      if (gen !== genRef.current) return
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : 'PDF 处理失败。')
      setStatus('error')
    }
  }, [revokeAll])

  const generate = useCallback(async (startText: string, endText: string) => {
    if (!doc) { setError('尚未打开 PDF 文件。'); return }
    const validation = validatePdfRange(startText, endText, doc.pageCount)
    if (validation) { setError(validation); return }
    const start = Number(startText.trim())
    const end = Number(endText.trim())
    const total = end - start + 1
    genRef.current++
    const gen = genRef.current
    revokeAll()
    setPages([]); setError(undefined); setProgress({ done: 0, total })
    const built: RenderedPdfPage[] = []
    try {
      for (let n = start; n <= end; n++) {
        if (gen !== genRef.current) return // stale: a newer generate/close superseded this
        const { blob, width, height, mimeType } = await renderPdfPage(n)
        if (gen !== genRef.current) return
        const previewUrl = URL.createObjectURL(blob)
        urlsRef.current.push(previewUrl)
        built.push({ pageNumber: n, blob, previewUrl, width, height, mimeType })
        setProgress({ done: built.length, total })
        setPages([...built])
      }
      if (gen === genRef.current) setProgress(undefined)
    } catch (e: unknown) {
      if (gen !== genRef.current) return
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : '页面渲染失败。')
      setPages([])
    }
  }, [doc, revokeAll])

  const reset = useCallback(async () => {
    await cleanup()
    setDoc(null); setPages([]); setStatus('idle'); setError(undefined); setProgress(undefined)
  }, [cleanup])

  return { doc, pages, status, error, progress, selectFile, generate, reset }
}
