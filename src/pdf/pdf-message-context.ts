import { normalizeMessagePdfContexts, type Message, type PdfContext, type StableId } from '../engine/types'
import { getAttachmentRows } from '../storage/storage'

/** Derive durable document/page provenance from the PDF page attachments in a message. */
export async function derivePdfContexts(imageIds: StableId[], createdAt: number): Promise<PdfContext[]> {
  if (imageIds.length === 0) return []
  let rows: Awaited<ReturnType<typeof getAttachmentRows>>
  try { rows = await getAttachmentRows(imageIds) } catch { return [] }
  const byDocument = new Map<string, number[]>()
  for (const row of rows) {
    const source = row?.meta?.source
    if (!source || source.type !== 'pdf-page' || !source.documentId || !Number.isInteger(source.pageNumber)) continue
    const pages = byDocument.get(source.documentId) ?? []
    pages.push(source.pageNumber)
    byDocument.set(source.documentId, pages)
  }
  return [...byDocument.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([documentId, pages]) => ({ documentId, pageNumbers: [...new Set(pages)].sort((a, b) => a - b), createdAt }))
    .filter(ctx => ctx.pageNumbers.length > 0)
}

/** v1.3.0 compatibility helper for callers that only understand one context. */
export async function derivePdfContext(imageIds: StableId[], createdAt: number): Promise<PdfContext | undefined> {
  return (await derivePdfContexts(imageIds, createdAt))[0]
}

/** Shared root/branch message builder: every new user message writes canonical provenance. */
export async function attachPdfContexts(message: Message, imageIds: StableId[], createdAt: number): Promise<Message> {
  const contexts = await derivePdfContexts(imageIds, createdAt)
  const normalized = normalizeMessagePdfContexts(message)
  return contexts.length > 0 ? { ...normalized, pdfContexts: contexts } : normalized
}
