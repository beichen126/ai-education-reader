
// Document -> Context execution service (Stage 9.5 / v1.0.0, Part 0.7). One shared
// implementation used by the DocumentContextPicker (Library / Composer) AND the Reader.
// Owns the temporary PdfSession lifecycle for the Library/Composer path, reuses a
// caller-owned session when provided (Reader), renders via the shared render policy,
// commits via the shared draft service, and rolls back on failure / cancellation.
import { renderPdfContextRanges, PdfContextRenderError, type ContextRenderProgress } from '../pdf/pdf-context-render'
import { addPdfContextToDraft } from '../pdf/pdf-context-draft'
import { openPdfSession, closePdfSession, renderSessionPage, type PdfSession } from '../pdf/pdf-session'
import { readDocumentSourceBlob, DocumentBinaryMissingError } from './document-service'
import type { PdfSelection } from '../pdf/pdf-types'
import type { PdfAddResult } from '../pdf/pdf-types'

export type DocumentContextExecuteOptions = {
  targetConversationId: string
  documentId: string
  fileName: string
  pageCount: number
  selection: PdfSelection
  /** Caller-owned session (Reader): the service NEVER closes it. */
  existingSession?: PdfSession
  onProgress?: (p: ContextRenderProgress) => void
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
  let session = opts.existingSession
  let ownsSession = false
  let tempSession: PdfSession | null = null
  let pageCount = opts.pageCount
  try {
    if (!session) {
      // Service-owned path (Library / Composer): read the source Blob and OPEN a session.
      let blob: Blob
      try { blob = await readDocumentSourceBlob(opts.documentId) }
      catch { return { ok: false, count: 0, error: '这份本地文件已不存在，请重新选择。' } }
      if (opts.isStale && opts.isStale()) return { ok: false, count: 0, error: '' }
      const opened = await openPdfSession(blob)
      session = opened.session
      tempSession = session
      ownsSession = true
      pageCount = opened.doc.pageCount
    }
    const ranges = opts.selection.ranges
    const res = await renderPdfContextRanges({
      ranges, pageCount,
      renderPage: (n) => renderSessionPage(session as PdfSession, n),
      onProgress: opts.onProgress,
      isCancelled: opts.isCancelled,
    })
    // Ownership gate: after a possibly-long render, NEVER write into a target that is
    // no longer the caller's active conversation (blocker 0.4).
    if (opts.isStale && opts.isStale()) return { ok: false, count: 0, error: '' }
    const draft: PdfAddResult = await addPdfContextToDraft(opts.targetConversationId, {
      documentId: opts.documentId, fileName: opts.fileName, selection: opts.selection, pages: res.pages,
    })
    return { ok: draft.ok, count: draft.count, error: draft.error }
  } catch (e) {
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'DocumentBinaryMissingError') return { ok: false, count: 0, error: '这份本地文件已不存在，请重新选择。' }
    if (e instanceof PdfContextRenderError) {
      // A cancellation / stale guard is a SILENT stop (the caller shows its own state).
      if (e.kind === 'cancelled') return { ok: false, count: 0, error: '' }
      return { ok: false, count: 0, error: e.message }
    }
    return { ok: false, count: 0, error: '无法生成上下文。' }
  } finally {
    if (ownsSession && tempSession) { try { await closePdfSession(tempSession) } catch { /* ignore */ } }
  }
}