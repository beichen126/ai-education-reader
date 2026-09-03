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
import type { LearningDocument, DocumentChapterSource } from './document-types'

export class DocumentNotFoundError extends Error {
  constructor(id: string) { super('document not found: ' + id); this.name = 'DocumentNotFoundError' }
}

/** idbUpdate rejects missing rows with a GENERIC error (it only knows store+key).
 * The service converts that into the domain error so callers can rely on the
 * documented DocumentNotFoundError contract. */
function isRowMissing(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('row not found')
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

/** List-friendly projection: NO sourceBlob, NO full chapter tree — just what the
 * library cards need. The library list must never hold every PDF Blob in React state. */
export type DocumentSummary = {
  id: string
  fileName: string
  fileSize: number
  pageCount: number
  chapterSource: DocumentChapterSource
  chapterCount: number
  lastReadPage: number
  createdAt: number
  updatedAt: number
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
}

export function toDocumentSummary(doc: LearningDocument): DocumentSummary {
  return {
    id: doc.id,
    fileName: doc.fileName,
    fileSize: doc.fileSize,
    pageCount: doc.pageCount,
    chapterSource: doc.chapterSource,
    chapterCount: countChapters(doc.chapters),
    lastReadPage: doc.lastReadPage,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.importSource ? { importSource: doc.importSource } : {}),
  }
}

/** Lightweight library list (updatedAt DESC). The React list stores only summaries;
 * note idbGetAll does read full rows (Blob references, not byte copies) — the
 * real metadata-query optimization for huge libraries is a later concern. */
export async function listDocumentSummaries(): Promise<DocumentSummary[]> {
  const all = await idbGetAll('documents')
  return (all as LearningDocument[]).sort((a, b) => b.updatedAt - a.updatedAt).map(toDocumentSummary)
}

function countChapters(chapters: LearningDocument['chapters']): number {
  let n = 0
  for (const c of chapters) { n++; n += countChapters(c.children) }
  return n
}

/** Atomically update the persisted chapter structure (never loses other fields). */
export async function updateDocumentChapters(id: string, chapters: LearningDocument['chapters'], chapterSource: LearningDocument['chapterSource']): Promise<void> {
  try {
    await idbUpdate('documents', id, (cur: LearningDocument) => ({ ...cur, chapters, chapterSource, updatedAt: Date.now() }))
  } catch (e) {
    if (isRowMissing(e)) throw new DocumentNotFoundError(id)
    throw e
  }
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
  try {
    await idbUpdate('documents', id, (cur: LearningDocument) => {
      assertValidLastReadPage(page, cur.pageCount)
      return { ...cur, lastReadPage: page, updatedAt: Date.now() }
    })
  } catch (e) {
    if (isRowMissing(e)) throw new DocumentNotFoundError(id)
    throw e
  }
}

export async function deleteDocument(id: string): Promise<void> {
  await idbDelete('documents', id)
}

/**
 * Contract for canceled/superseded PDF imports (Stage 9.2B1): when the import
 * generation is already stale by the time createDocument() resolved, the just
 * created Document must NOT stay behind. Best-effort — a failed cleanup is
 * never allowed to break the UI (a ghost row is preferable to a broken flow).
 * Note the distinction: an import that FINISHED and was then voluntarily
 * re-selected keeps its old Document; only never-current generations are removed.
 */
export async function cleanupStaleDocument(id: string): Promise<void> {
  try { await deleteDocument(id) } catch { /* best-effort */ }
}
