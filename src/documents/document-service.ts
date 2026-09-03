// Document Service — the ONLY way UI code touches the IndexedDB 'documents' store.
// A document is globally owned (no conversationId): deleting a conversation never
// deletes the original file, and a document may be used by many conversations.
import { idbGet, idbGetAll, idbPut, idbDelete } from '../storage/idb'
import type { LearningDocument } from './document-types'

export type NewDocumentInput = {
  id: string
  fileName: string
  mimeType: 'application/pdf'
  fileSize: number
  pageCount: number
  sourceBlob: Blob
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
}

/** Persist a new document. Throws on IndexedDB failure (QuotaExceeded etc.) —
 * callers then continue WITHOUT a documentId rather than shipping half a row. */
export async function createDocument(input: NewDocumentInput): Promise<LearningDocument> {
  const now = Date.now()
  const doc: LearningDocument = {
    id: input.id,
    kind: 'pdf',
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    pageCount: input.pageCount,
    sourceBlob: input.sourceBlob,
    chapters: [],
    chapterSource: 'none',
    lastReadPage: 0,
    ...(input.importSource ? { importSource: input.importSource } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await idbPut('documents', doc)
  return doc
}

export async function getDocument(id: string): Promise<LearningDocument | undefined> {
  return idbGet('documents', id)
}

export async function listDocuments(): Promise<LearningDocument[]> {
  const all = await idbGetAll('documents')
  return (all as LearningDocument[]).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Update the persisted chapter structure of an existing document. */
export async function updateDocumentChapters(id: string, chapters: LearningDocument['chapters'], chapterSource: LearningDocument['chapterSource']): Promise<void> {
  const doc = await getDocument(id)
  if (!doc) throw new Error('document not found: ' + id)
  const next: LearningDocument = { ...doc, chapters, chapterSource, updatedAt: Date.now() }
  await idbPut('documents', next)
}

export async function updateLastReadPage(id: string, page: number): Promise<void> {
  const doc = await getDocument(id)
  if (!doc) throw new Error('document not found: ' + id)
  const next: LearningDocument = { ...doc, lastReadPage: page, updatedAt: Date.now() }
  await idbPut('documents', next)
}

export async function deleteDocument(id: string): Promise<void> {
  await idbDelete('documents', id)
}
