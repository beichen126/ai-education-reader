import { attachmentErrorLabel, AttachmentError, deleteAttachment, saveGeneratedImages, type GeneratedImageInput } from '../engine/attachment-service'
import { newStableId } from '../engine/types'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult } from '../pdf/pdf-types'
import { tx } from '../engine/locale'
import { addProjectAttachments } from './project-store'

export async function saveProjectMaterials(projectId: string, inputs: GeneratedImageInput[]) {
  const saved = await saveGeneratedImages(inputs)
  try {
    await addProjectAttachments(projectId, saved.map(item => item.id))
  } catch (error) {
    await Promise.allSettled(saved.map(item => deleteAttachment(item.id)))
    throw error
  }
}

export async function saveProjectPdf(projectId: string, payload: PdfAddPayload): Promise<PdfAddResult> {
  if (payload.isCancelled?.()) return { ok: false, count: 0, error: '' }
  try {
    const groupId = newStableId()
    if (payload.selection.contextMode === 'ocr' && payload.pages.some(page => !page.ocr || page.previewDeferred)) {
      throw new Error(tx('此范围的图片或 OCR 尚未准备完成。', 'Images or OCR for this range are still being prepared.'))
    }
    await saveProjectMaterials(projectId, payload.pages.map(page => ({
      blob: page.blob,
      name: pdfPageAttachmentName(payload.fileName, page.pageNumber),
      ocr: payload.selection.contextMode === 'ocr' ? page.ocr : undefined,
      source: { type: 'pdf-page', groupId, documentId: payload.documentId, fileName: payload.fileName, pageNumber: page.pageNumber, selection: payload.selection },
    })))
    return { ok: true, count: payload.pages.length, error: '' }
  } catch (error) {
    const message = error instanceof AttachmentError ? attachmentErrorLabel(error.kind) :
      error instanceof Error ? error.message : tx('项目资料保存失败。', 'Could not save project materials.')
    return { ok: false, count: 0, error: message }
  }
}
