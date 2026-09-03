// Document Service — the ONLY way UI code touches the IndexedDB 'documents' store.
// A document is globally owned (no conversationId): deleting a conversation never
// deletes the original file, and a document may be used by many conversations.
//
// All field updates go through the ATOMIC idbUpdate primitive (one readwrite
// transaction: get -> updater -> put). Never hand-split into get+put — concurrent
// updates of different fields would otherwise lose one of them.
//
// Stage 9.2B constraint (Reader): lastReadPage must NOT be persisted on every page
// turn — the Reader should debounce page progress and flush on close/unmount.
import { idbGet, idbGetAll, idbPut, idbDelete, idbUpdate } from '../storage/idb'
import type { LearningDocument } from './document-types'

export class DocumentNotFoundError extends Error {
  constructor(id: string) { super('document not found: ' + id); this.name = 'DocumentNotFoundError' }
}

export type NewDocumentInput = {
  id: string
  fileName: string
  mimeType: 'application/pdf'
  /** Accepted for API symmetry; the persisted fileSize is ALWAYS sourceBlob.size. */
  fileSize: number
  pageCount: number
  sourceBlob: Blob
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
}

/** Persist a new document. Throws on IndexedDB failure (QuotaExceeded etc.) —
 * callers then continue WITHOUT a documentId rather than shipping half a row.
 * fileSize is taken from sourceBlob.size (single truth source, no caller mismatch). */
export async function createDocument(input: NewDocumentInput): Promise<LearningDocument> {
  const now = Date.now()
  const doc: LearningDocument = {
    id: input.id,
    kind: 'pdf',
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: input.sourceBlob.size,
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

/** Atomically update the persisted chapter structure (never loses other fields). */
export async function updateDocumentChapters(id: string, chapters: LearningDocument['chapters'], chapterSource: LearningDocument['chapterSource']): Promise<void> {
  await idbUpdate('documents', id, (cur: LearningDocument) => {
    if (!cur) throw new DocumentNotFoundError(id)
    return { ...cur, chapters, chapterSource, updatedAt: Date.now() }
  })
}

/**
 * lastReadPage invariant: 0 = not read yet; otherwise an integer in [1, pageCount].
 * Invalid input (negative / fraction / beyond pageCount / NaN / Infinity) THROWS —
 * it is a programming error, not a value to silently clamp.
 */
export function assertValidLastReadPage(page: number, pageCount: number): void {
  if (!Number.isInteger(page) || page < 0 || page > pageCount) {
    throw new RangeError('invalid lastReadPage ' + String(page) + ' for document with ' + pageCount + ' pages')
  }
}

/** Atomically bump the last-read page (never loses other fields). */
export async function updateLastReadPage(id: string, page: number): Promise<void> {
  await idbUpdate('documents', id, (cur: LearningDocument) => {
    if (!cur) throw new DocumentNotFoundError(id)
    assertValidLastReadPage(page, cur.pageCount)
    return { ...cur, lastReadPage: page, updatedAt: Date.now() }
  })
}

export async function deleteDocument(id: string): Promise<void> {
  await idbDelete('documents', id)
}
