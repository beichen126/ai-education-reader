import type { PdfContext, StableId } from '../engine/types'
import { getAttachmentRows } from '../storage/storage'

/** Derive durable document/page provenance from the PDF page attachments in a message. */
export async function derivePdfContext(imageIds: StableId[], createdAt: number): Promise<PdfContext | undefined> {
  if (imageIds.length === 0) return undefined
  let rows: Awaited<ReturnType<typeof getAttachmentRows>>
  try { rows = await getAttachmentRows(imageIds) } catch { return undefined }
  const byDocument = new Map<string, number[]>()
  for (const row of rows) {
    const source = row?.meta?.source
    if (!source || source.type !== 'pdf-page' || !source.documentId || !Number.isInteger(source.pageNumber)) continue
    const pages = byDocument.get(source.documentId) ?? []
    pages.push(source.pageNumber)
    byDocument.set(source.documentId, pages)
  }
  if (byDocument.size === 0) return undefined
  // A message normally contains one PDF selection. If multiple documents are
  // attached, keep the largest group as the single-context compatibility shape.
  let selectedId = ''
  let selectedPages: number[] = []
  for (const [documentId, pages] of byDocument) {
    if (pages.length > selectedPages.length) { selectedId = documentId; selectedPages = pages }
  }
  return { documentId: selectedId, pageNumbers: [...new Set(selectedPages)].sort((a, b) => a - b), createdAt }
}
