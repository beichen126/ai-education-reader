// Shared PDF Context -> Draft commit service (Stage 9.2B2). ONE implementation for
// both the Composer PdfPanel and the Document Reader:
//   ONE groupId -> atomic attachment + draft ownership commit, no orphans.
import { getDraft, addDraftImages, updateDraftMemory } from '../engine/draft-store'
import { saveGeneratedImagesAndDraft } from '../engine/attachment-service'
import { getConversation } from '../storage/storage'
import { newStableId } from '../engine/types'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult } from './pdf-types'
import { tx } from '../engine/locale'

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
    // ATOMIC ownership: stage OPFS binaries, then ONE IndexedDB txn commits the attachment
    // metadata rows AND the draft:<conversationId> row together (P0-4). Staged OPFS binaries
    // are cleaned on any failure. No intermediate durable state leaves attachment metadata
    // committed without the draft referencing it (or vice versa).
    const existing = getDraft(conversationId)
    const atts = await saveGeneratedImagesAndDraft(inputs, { conversationId, text: existing.text, existingImageIds: existing.imageIds })
    // The durable draft row was already committed in the same txn; update memory WITHOUT a
    // second DB mutation (no duplicate persist).
    updateDraftMemory(conversationId, { text: existing.text, imageIds: [...new Set([...existing.imageIds, ...atts.map(a => a.id)])] })
    return { ok: true, count: atts.length, error: '' }
  } catch (e) {
    return { ok: false, count: 0, error: tx('无法将 PDF 页面加入对话。', 'Unable to add the PDF pages to the chat.') }
  }
}
