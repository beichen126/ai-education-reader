import { prepareOcrPages } from '../pdf/pdf-ocr-pages'
import { tx } from '../engine/locale'
import { waitForPdfOperation } from '../pdf/pdf-abort'
import { countPdfRangePages, exceedsPdfContextHardLimit, expandPdfRangePages } from '../pdf/pdf-types'
import { validOcrPage } from '../api/deepseek-ocr'
import { idbGet } from '../storage/idb'

// Document -> Context execution service (Stage 9.5 / v1.0.0, Part 0.7). One shared
// implementation used by the DocumentContextPicker (Library / Composer) AND the Reader.
// Owns the temporary PdfSession lifecycle for the Library/Composer path, reuses a
// caller-owned session when provided (Reader), renders via the shared render policy,
// commits via the shared draft service, and rolls back on failure / cancellation.
import { renderPdfContextRanges, PdfContextRenderError, type ContextRenderProgress } from '../pdf/pdf-context-render'
import { addPdfContextToDraft } from '../pdf/pdf-context-draft'
import { saveProjectPdf } from '../projects/project-materials'
import { openPdfSession, closePdfSession, renderSessionPage, type PdfSession } from '../pdf/pdf-session'
import { readDocumentSourceBlob, DocumentBinaryMissingError } from './document-service'
import type { PdfAddPayload, PdfSelection } from '../pdf/pdf-types'

export type DocumentContextDestination =
  | { targetConversationId: string; targetBranchId?: string; targetProjectId?: never }
  | { targetProjectId: string; targetConversationId?: never; targetBranchId?: never }

export type DocumentContextExecuteOptions = DocumentContextDestination & {
  documentId: string
  fileName: string
  pageCount: number
  selection: PdfSelection
  /** Caller-owned session (Reader): the service NEVER closes it. */
  existingSession?: PdfSession
  onProgress?: (p: ContextRenderProgress) => void
  signal?: AbortSignal
  isCancelled?: () => boolean
  /** Optional generation token: when it no longer matches the caller's current
   *  generation, the operation aborts (blocker 0.4 — conversation-switch ownership). */
  isStale?: () => boolean
}

export type DocumentContextExecuteResult = { ok: boolean; count: number; error: string }

/** Execute one Document -> Context snapshot. All-or-nothing: a failure or cancellation
 *  leaves no Draft group and no orphan attachments.
 *
 *  Session ownership contract (blocker 0.2):
 *    - caller-owned existingSession (Reader): the service NEVER reads the source Blob
 *      and NEVER closes it.
 *    - otherwise the service OPENS its own temp session from the source Blob, uses it,
 *      and ALWAYS closes it in `finally`. */
export async function executeDocumentContext(opts: DocumentContextExecuteOptions): Promise<DocumentContextExecuteResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()
  const cancelled = () => !!(opts.signal?.aborted || opts.isCancelled?.() || opts.isStale?.())
  const cancellationWatch = setInterval(() => { if (cancelled()) controller.abort() }, 100)
  let session = opts.existingSession
  let pageCount = opts.pageCount
  const ranges = opts.selection.ranges
  const total = countPdfRangePages(ranges)
  let previewDecodeBudget: number | undefined
  try {
    const ensureSession = async (signal: AbortSignal) => {
      if (!session) {
        const blob = await waitForPdfOperation(readDocumentSourceBlob(opts.documentId), signal)
        const opened = await openPdfSession(blob, signal, previewDecodeBudget)
        session = opened.session
        pageCount = opened.doc.pageCount
      }
      return session
    }
    if (!session || opts.selection.contextMode === 'ocr') {
      const doc = await idbGet('documents', opts.documentId)
      if (!doc) throw new DocumentBinaryMissingError(opts.documentId)
      pageCount = doc.pageCount
      if (opts.targetProjectId !== undefined && opts.selection.contextMode === 'ocr' &&
        !exceedsPdfContextHardLimit(total) && expandPdfRangePages(ranges).every(page => {
          const cached = doc.ocrPages?.[page]
          return validOcrPage(cached) && cached.finishReason === 'stop'
        })) {
        // Only lower the JPEG2000 decode budget when no page needs OCR input.
        previewDecodeBudget = 12 * 1024 * 1024
      }
    }
    let progress: ContextRenderProgress = { done: 0, total, bytes: 0 }
    const renderOptions = {
      ranges, pageCount, signal: controller.signal,
      renderPage: async (pageNumber: number, maxEdge?: number) => {
        opts.onProgress?.({ ...progress, pageNumber })
        const attempt = new AbortController()
        const cancelAttempt = () => attempt.abort()
        const timer = setTimeout(cancelAttempt, 45_000)
        controller.signal.addEventListener('abort', cancelAttempt, { once: true })
        if (controller.signal.aborted) cancelAttempt()
        try {
          const pdf = await ensureSession(attempt.signal)
          return await renderSessionPage(pdf, pageNumber, attempt.signal, !opts.existingSession, maxEdge)
        } catch (error) {
          if (attempt.signal.aborted && !cancelled()) {
            throw new Error(tx('渲染超时，请重试。', 'Rendering timed out. Try again.'))
          }
          throw error
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', cancelAttempt)
          opts.onProgress?.(progress)
        }
      },
      onProgress: (value: ContextRenderProgress) => { progress = value; opts.onProgress?.(value) },
      isCancelled: cancelled,
    }
    const res = opts.selection.contextMode === 'ocr' ? await prepareOcrPages(opts.documentId, renderOptions, opts.targetProjectId !== undefined) : await renderPdfContextRanges(renderOptions)
    // Ownership gate: after a possibly-long render, NEVER write into a target that is
    // no longer the caller's active conversation (blocker 0.4).
    if (cancelled()) return { ok: false, count: 0, error: '' }
    const payload: PdfAddPayload = {
      branchId: opts.targetBranchId, documentId: opts.documentId, fileName: opts.fileName, selection: opts.selection, pages: res.pages, onOcrProgress: (done, total) => opts.onProgress?.({ done, total, bytes: res.pages.reduce((sum, p) => sum + p.blob.size, 0) }), isCancelled: cancelled,
    }
    return opts.targetProjectId !== undefined
      ? await saveProjectPdf(opts.targetProjectId, payload)
      : await addPdfContextToDraft(opts.targetConversationId, payload)
  } catch (e) {
    if (cancelled()) return { ok: false, count: 0, error: '' }
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'DocumentBinaryMissingError') return { ok: false, count: 0, error: '这份本地文件已不存在，请重新选择。' }
    if (e instanceof PdfContextRenderError) {
      // A cancellation / stale guard is a SILENT stop (the caller shows its own state).
      if (e.kind === 'cancelled') return { ok: false, count: 0, error: '' }
      return { ok: false, count: 0, error: e.message }
    }
    return { ok: false, count: 0, error: e instanceof Error ? e.message : '无法生成上下文。' }
  } finally {
    clearInterval(cancellationWatch)
    opts.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (!opts.existingSession && session) void closePdfSession(session)
  }
}
