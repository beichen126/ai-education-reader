// Shared PDF Context -> Draft commit service (Stage 9.2B2). ONE implementation for
// both the Composer PdfPanel and the Document Reader:
//   budget guard -> ONE groupId -> saveGeneratedImages -> addDraftImages
//   (addDraftImages failure -> rollback the just-created attachments, no orphans).
import { getDraft, addDraftImages } from '../engine/draft-store'
import { saveGeneratedImages, deleteAttachment, sumAttachmentBytes, wouldExceedInlineBudget } from '../engine/attachment-service'
import { newStableId } from '../engine/types'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult } from './pdf-types'

export type DraftCommitDeps = { /** Test seam: simulate a failing draft-store commit. */
  addDraftImages?: typeof addDraftImages }

export async function addPdfContextToDraft(conversationId: string, payload: PdfAddPayload, deps: DraftCommitDeps = {}): Promise<PdfAddResult> {
  try {
    // One user PDF selection = one context group (never auto-merged by fileName).
    // Draft early guard: existing draft bytes + this group must fit the 30 MiB budget
    // (final runReplyStream guard stays authoritative; this avoids writing dozens of
    // attachments into IDB just to reject them at send time).
    const existingIds = getDraft(conversationId).imageIds
    const existingBytes = await sumAttachmentBytes(existingIds)
    const newBytes = payload.pages.reduce((s, p) => s + p.blob.size, 0)
    if (wouldExceedInlineBudget(existingBytes, newBytes)) {
      return { ok: false, count: 0, error: '当前消息中的图片内容已经较多。加入这一 PDF 范围后可能超过接口请求大小限制。请删除部分图片或减少 PDF 页面后重试。' }
    }
    const groupId = newStableId()
    const inputs = payload.pages.map(p => ({
      blob: p.blob,
      name: pdfPageAttachmentName(payload.fileName, p.pageNumber),
      source: {
        type: 'pdf-page' as const,
        groupId,
        ...(payload.documentId ? { documentId: payload.documentId } : {}),
        fileName: payload.fileName,
        pageNumber: p.pageNumber,
        selection: payload.selection,
      },
    }))
    const atts = await saveGeneratedImages(inputs)
    try {
      (deps.addDraftImages ?? addDraftImages)(conversationId, atts.map(a => a.id))
    } catch (e) {
      // Roll back this batch so a failed attach step never leaves orphan blobs.
      for (const a of atts) { try { await deleteAttachment(a.id) } catch { /* ignore */ } }
      throw e
    }
    return { ok: true, count: atts.length, error: '' }
  } catch (e) {
    return { ok: false, count: 0, error: '无法将 PDF 页面加入对话。' }
  }
}
