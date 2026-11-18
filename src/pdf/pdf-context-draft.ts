// Shared PDF Context -> Draft commit service (Stage 9.2B2). ONE implementation for
// both the Composer PdfPanel and the Document Reader:
//   ONE groupId -> atomic attachment + draft ownership commit, no orphans.
import { getDraft, addDraftImages, updateDraftMemory, branchThreadKey } from '../engine/draft-store'
import { saveGeneratedImagesAndDraft, saveGeneratedImagesAndBranchDraft } from '../engine/attachment-service'
import { getConversation } from '../storage/storage'
import { newStableId } from '../engine/types'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult } from './pdf-types'
import { tx } from '../engine/locale'
import { ensurePageOcr } from '../documents/document-ocr'
import type { OcrPage } from '../api/deepseek-ocr'

export type DraftCommitDeps = { /** Test seam: simulate a failing draft-store commit. */
  addDraftImages?: typeof addDraftImages }

export async function addPdfContextToDraft(conversationId: string, payload: PdfAddPayload, deps: DraftCommitDeps = {}): Promise<PdfAddResult> {
  try {
    // One user PDF selection = one context group (never auto-merged by fileName).
    // Adding local pages is not an API request. Do not reject a draft using a
    // guessed cross-provider byte budget; the selected endpoint decides at send.
    // Verify the target conversation still exists BEFORE committing metadata. Never allow
    // getDraft on a deleted conversation to silently create a durable orphan attachment graph.
    if (!(await getConversation(conversationId))) {
      return { ok: false, count: 0, error: tx('目标会话已不存在，无法加入。', 'The target chat no longer exists.') }
    }
    const ocr = new Map<number, OcrPage>()
    if (payload.selection.contextMode === 'ocr') {
      if (!payload.documentId) return { ok: false, count: 0, error: '请先将 PDF 保存到资料库，以便缓存每页 OCR。' }
      payload.onOcrProgress?.(0, payload.pages.length)
      for (const page of payload.pages) {
        if (payload.isCancelled?.()) return { ok: false, count: 0, error: '' }
        ocr.set(page.pageNumber, page.ocr ?? await ensurePageOcr(payload.documentId, page.pageNumber, async () => page.blob))
        payload.onOcrProgress?.(ocr.size, payload.pages.length)
      }
    }
    if (payload.isCancelled?.()) return { ok: false, count: 0, error: '' }
    const groupId = newStableId()
    const inputs = payload.pages.map(p => ({
      blob: p.blob,
      ...(ocr.has(p.pageNumber) ? { ocr: ocr.get(p.pageNumber)! } : {}),
      name: pdfPageAttachmentName(payload.fileName, p.pageNumber),
      source: {
        type: 'pdf-page' as const,
        ...(p.previewDeferred ? { previewDeferred: true } : {}),
        groupId,
        ...(payload.documentId ? { documentId: payload.documentId } : {}),
        fileName: payload.fileName,
        pageNumber: p.pageNumber,
        selection: payload.selection,
      },
    }))
    // ATOMIC ownership: stage OPFS binaries, then ONE IndexedDB txn commits the attachment
    // metadata rows AND the draft:<conversationId> row together (P0-4). Staged OPFS binaries
    // are cleaned on any failure. No intermediate durable state leaves attachment metadata
    // committed without the draft referencing it (or vice versa).
    const key = payload.branchId ? branchThreadKey(payload.branchId) : conversationId
    const existing = getDraft(key)
    const draftCommit = { getCurrentDraft: () => getDraft(key) }
    const atts = payload.branchId
      ? await saveGeneratedImagesAndBranchDraft(inputs, { branchId: payload.branchId, text: existing.text, existingImageIds: existing.imageIds }, draftCommit)
      : await saveGeneratedImagesAndDraft(inputs, { conversationId, text: existing.text, existingImageIds: existing.imageIds }, draftCommit)
    // The durable draft row was already committed in the same txn; update memory WITHOUT a
    // second DB mutation (no duplicate persist).
    const latest = getDraft(key)
    updateDraftMemory(key, { text: latest.text, imageIds: [...new Set([...latest.imageIds, ...atts.map(a => a.id)])] })
    return { ok: true, count: atts.length, error: '' }
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : tx('无法将 PDF 页面加入对话。', 'Unable to add the PDF pages to the chat.') }
  }
}
