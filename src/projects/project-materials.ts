import { attachmentErrorLabel, AttachmentError, saveGeneratedImagesWithSetting, type GeneratedImageInput } from '../engine/attachment-service'
import { newStableId } from '../engine/types'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult } from '../pdf/pdf-types'
import { tx } from '../engine/locale'
import { PROJECTS_KEY, readProjectRecords } from './project-records'
import { reloadProjects } from './project-store'

export async function saveProjectMaterials(projectId: string, inputs: GeneratedImageInput[], isCancelled?: () => boolean) {
  const saved = await saveGeneratedImagesWithSetting(inputs, PROJECTS_KEY, (value, ids) => {
    const projects = readProjectRecords(value)
    const project = projects.find(item => item.id === projectId)
    if (!project) throw new Error(tx('项目已删除。', 'The project was deleted.'))
    if (project.archivedAt !== undefined) throw new Error(tx('项目已归档。', 'The project is archived.'))
    return projects.map(item => item.id === projectId ? { ...item, attachmentIds: [...item.attachmentIds, ...ids] } : item)
  }, isCancelled)
  if (saved) await reloadProjects().catch(() => {})
  return saved
}

export async function saveProjectPdf(projectId: string, payload: PdfAddPayload): Promise<PdfAddResult> {
  if (payload.isCancelled?.()) return { ok: false, count: 0, error: '' }
  try {
    const groupId = newStableId()
    if (payload.selection.contextMode === 'ocr' && payload.pages.some(page => !page.ocr || page.previewDeferred)) {
      throw new Error(tx('此范围的图片或 OCR 尚未准备完成。', 'Images or OCR for this range are still being prepared.'))
    }
    const saved = await saveProjectMaterials(projectId, payload.pages.map(page => ({
      blob: page.blob,
      name: pdfPageAttachmentName(payload.fileName, page.pageNumber),
      ocr: payload.selection.contextMode === 'ocr' ? page.ocr : undefined,
      source: { type: 'pdf-page', groupId, documentId: payload.documentId, fileName: payload.fileName, pageNumber: page.pageNumber, selection: payload.selection },
    })), payload.isCancelled)
    if (!saved) return { ok: false, count: 0, error: '' }
    return { ok: true, count: payload.pages.length, error: '' }
  } catch (error) {
    const message = error instanceof AttachmentError ? attachmentErrorLabel(error.kind) :
      error instanceof Error ? error.message : tx('项目资料保存失败。', 'Could not save project materials.')
    return { ok: false, count: 0, error: message }
  }
}
