import { idbGet, idbGetAll, idbPut, idbDelete, idbUpdate } from '../storage/idb'
import { persistBinary, readBinary, deleteBinary, binaryExists, type StoredBinary } from '../storage/binary-store'
import type { LearningDocument, DocumentChapterSource, ChapterNode } from './document-types'
import { computeContentHash, computeFastFingerprint } from './document-hash'

export type StoredDocumentRecord = {
  id: string; kind: 'pdf'; fileName: string; mimeType: 'application/pdf'; fileSize: number
  pageCount: number; chapters: ChapterNode[]; chapterSource: DocumentChapterSource; lastReadPage: number
  lastReadAt: number
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
  contentHash?: string; fastFingerprint?: string
  createdAt: number; updatedAt: number; source: StoredBinary; recordVersion: 3
}

export class DocumentNotFoundError extends Error {
  constructor(id: string) { super('document not found: ' + id); this.name = 'DocumentNotFoundError' }
}
export class DocumentBinaryMissingError extends Error {
  constructor(id: string) { super('local document binary missing: ' + id); this.name = 'DocumentBinaryMissingError' }
}

function isRowMissing(e: unknown): boolean { return e instanceof Error && e.message.startsWith('row not found') }
function isLegacyRow(row: any): row is Record<string, unknown> & { sourceBlob: Blob } { return row && typeof row.sourceBlob === 'object' && row.sourceBlob instanceof Blob }
function hasSourceRef(row: any): row is StoredDocumentRecord { return row && row.source && typeof row.source === 'object' }

/** Backfill lastReadAt for pre-v1.1.1 records that never stored it (B2 migration fallback). */
function lastReadAtOf(row: any): number {
  const v = row && typeof row.lastReadAt === 'number' ? row.lastReadAt : undefined
  if (v !== undefined) return v
  return (row && typeof row.updatedAt === 'number' ? row.updatedAt : (row && typeof row.createdAt === 'number' ? row.createdAt : 0))
}

function hydrate(row: any): Promise<LearningDocument> {
  const base = {
    id: row.id as string, kind: 'pdf' as const, fileName: row.fileName as string,
    mimeType: 'application/pdf' as const, fileSize: row.fileSize as number,
    pageCount: row.pageCount as number, chapters: (row.chapters ?? []) as ChapterNode[],
    chapterSource: (row.chapterSource ?? 'none') as DocumentChapterSource,
    lastReadPage: row.lastReadPage as number,
    lastReadAt: lastReadAtOf(row),
    ...(row.importSource ? { importSource: row.importSource } : {}),
    ...(row.contentHash ? { contentHash: row.contentHash as string } : {}),
    ...(row.fastFingerprint ? { fastFingerprint: row.fastFingerprint as string } : {}),
    createdAt: row.createdAt as number, updatedAt: row.updatedAt as number,
  };
  if (hasSourceRef(row)) {
    return readBinary(row.source).then(blob => ({ ...base, sourceBlob: blob })).catch(e => {
      if (e && typeof e === 'object' && (e as {name?:string}).name === 'BinaryStorageError') throw new DocumentBinaryMissingError(row.id);
      throw e;
    });
  }
  if (isLegacyRow(row)) return Promise.resolve({ ...base, sourceBlob: row.sourceBlob });
  throw new DocumentBinaryMissingError(row.id);
}

/** Metadata-only view that surfaces lastReadAt + the lazy-computed hash fields. */
export type NewDocumentInput = { id: string; fileName: string; mimeType: 'application/pdf'; fileSize: number; pageCount: number; sourceBlob: Blob; importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }; contentHash?: string; fastFingerprint?: string }

export async function createDocument(input: NewDocumentInput): Promise<LearningDocument> {
  const now = Date.now();
  const source = await persistBinary('documents', input.id, input.sourceBlob);
  const record: StoredDocumentRecord = {
    id: input.id, kind: 'pdf', fileName: input.fileName, mimeType: input.mimeType,
    fileSize: input.sourceBlob.size, pageCount: input.pageCount,
    chapters: [], chapterSource: 'none', lastReadPage: 0, lastReadAt: now,
    ...(input.importSource ? { importSource: input.importSource } : {}),
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    ...(input.fastFingerprint ? { fastFingerprint: input.fastFingerprint } : {}),
    createdAt: now, updatedAt: now, source, recordVersion: 3,
  };
  try { await idbPut('documents', record); }
  catch (e) { try { await deleteBinary(source) } catch { /* orphan */ } throw e; }
  return { ...recordToDomain(record), sourceBlob: input.sourceBlob };
}

function recordToDomain(record: StoredDocumentRecord): Omit<LearningDocument, 'sourceBlob'> {
  return { id: record.id, kind: 'pdf', fileName: record.fileName, mimeType: record.mimeType, fileSize: record.fileSize, pageCount: record.pageCount, chapters: record.chapters, chapterSource: record.chapterSource, lastReadPage: record.lastReadPage, lastReadAt: lastReadAtOf(record), ...(record.importSource ? { importSource: record.importSource } : {}), ...(record.contentHash ? { contentHash: record.contentHash } : {}), ...(record.fastFingerprint ? { fastFingerprint: record.fastFingerprint } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export async function getDocument(id: string): Promise<LearningDocument | undefined> {
  const row = await idbGet('documents', id);
  if (!row) return undefined;
  return hydrate(row);
}

export async function readDocumentSourceBlob(id: string): Promise<Blob> {
  const row = await idbGet('documents', id);
  if (!row) throw new DocumentNotFoundError(id);
  if (isLegacyRow(row)) return row.sourceBlob;
  if (hasSourceRef(row)) return readBinary(row.source);
  throw new DocumentBinaryMissingError(id);
}

/** TEST-ONLY / internal: hydrates EVERY document's full source Blob into memory. The
 *  runtime UI MUST use listDocumentSummaries() (metadata-only) instead. Do not call this
 *  from product code — a large library would load an entire PDF corpus into memory.
 *  Marked so a future UI refactor can't accidentally hydrate everything. */
export async function listDocuments(): Promise<LearningDocument[]> {
  const all = await idbGetAll('documents');
  const out: LearningDocument[] = [];
  for (const row of all) { try { out.push(await hydrate(row)) } catch { /* skip unreadable */ } }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type DocumentSummary = { id: string; fileName: string; fileSize: number; pageCount: number; chapterSource: DocumentChapterSource; chapterCount: number; lastReadPage: number; lastReadAt: number; createdAt: number; updatedAt: number; importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }; contentHash?: string; fastFingerprint?: string }

function countChapters(chapters: ChapterNode[]): number { let n = 0; for (const c of chapters) { n++; n += countChapters(c.children) } return n }

function toSummaryFromRecord(row: any): DocumentSummary {
  return { id: row.id, fileName: row.fileName, fileSize: row.fileSize, pageCount: row.pageCount, chapterSource: row.chapterSource ?? 'none', chapterCount: countChapters(row.chapters ?? []), lastReadPage: row.lastReadPage ?? 0, lastReadAt: lastReadAtOf(row), createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.importSource ? { importSource: row.importSource } : {}), ...(row.contentHash ? { contentHash: row.contentHash } : {}), ...(row.fastFingerprint ? { fastFingerprint: row.fastFingerprint } : {}) };
}

export async function listDocumentSummaries(): Promise<DocumentSummary[]> {
  const all = await idbGetAll('documents');
  // Service keeps a deterministic DEFAULT order (updatedAt DESC) for consumers that
  // don't apply a user sort (e.g. the Context picker). The Library UI re-sorts by the
  // persisted sort preference (B1) — it never relies on this hard-coded order alone.
  return (all as any[]).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map(toSummaryFromRecord);
}

/** Persisted document RECORD metadata (full chapters, no binary read) for backup / exporters.
 *  Iterates ONE record at a time in memory and NEVER hydrates any source Blob, so a backup
 *  can read each document's binary exactly once. */
export type DocumentRecordMeta = Omit<LearningDocument, 'sourceBlob'>

export async function listDocumentRecords(): Promise<{ id: string; meta: DocumentRecordMeta }[]> {
  const all = (await idbGetAll('documents') as any[]).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const out: { id: string; meta: DocumentRecordMeta }[] = []
  for (const row of all) {
    const meta: DocumentRecordMeta = {
      id: row.id, kind: 'pdf', fileName: row.fileName, mimeType: row.mimeType,
      fileSize: row.fileSize, pageCount: row.pageCount, chapters: (row.chapters ?? []) as ChapterNode[],
      chapterSource: row.chapterSource ?? 'none', lastReadPage: row.lastReadPage ?? 0,
      lastReadAt: lastReadAtOf(row),
      ...(row.importSource ? { importSource: row.importSource } : {}),
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(row.fastFingerprint ? { fastFingerprint: row.fastFingerprint } : {}),
      createdAt: row.createdAt ?? 0, updatedAt: row.updatedAt ?? 0,
    }
    out.push({ id: row.id, meta })
  }
  return out
}

/** Metadata descriptor for a single persisted Document WITHOUT reading the source Blob.
 *  Used by the Document -> Context picker (never hydrates the OPFS PDF binary). */
export type DocumentContextDescriptor = {
  id: string
  fileName: string
  pageCount: number
  chapters: ChapterNode[]
  chapterSource: DocumentChapterSource
  importSource?: { kind: 'pdf' | 'ppt' | 'pptx'; originalFileName: string }
}

export async function getDocumentContextDescriptor(id: string): Promise<DocumentContextDescriptor | null> {
  const row = await idbGet('documents', id)
  if (!row) return null
  return {
    id: row.id, fileName: row.fileName, pageCount: row.pageCount,
    chapters: (row.chapters ?? []) as ChapterNode[], chapterSource: row.chapterSource ?? 'none',
    ...(row.importSource ? { importSource: row.importSource } : {}),
  }
}

export function toDocumentSummary(doc: LearningDocument): DocumentSummary {
  return { id: doc.id, fileName: doc.fileName, fileSize: doc.fileSize, pageCount: doc.pageCount, chapterSource: doc.chapterSource, chapterCount: countChapters(doc.chapters), lastReadPage: doc.lastReadPage, lastReadAt: doc.lastReadAt, createdAt: doc.createdAt, updatedAt: doc.updatedAt, ...(doc.importSource ? { importSource: doc.importSource } : {}), ...(doc.contentHash ? { contentHash: doc.contentHash } : {}), ...(doc.fastFingerprint ? { fastFingerprint: doc.fastFingerprint } : {}) };
}

export function toStoredRecord(doc: LearningDocument, source: StoredBinary): StoredDocumentRecord {
  return { id: doc.id, kind: 'pdf', fileName: doc.fileName, mimeType: doc.mimeType, fileSize: doc.fileSize, pageCount: doc.pageCount, chapters: doc.chapters, chapterSource: doc.chapterSource, lastReadPage: doc.lastReadPage, lastReadAt: doc.lastReadAt, ...(doc.importSource ? { importSource: doc.importSource } : {}), ...(doc.contentHash ? { contentHash: doc.contentHash } : {}), ...(doc.fastFingerprint ? { fastFingerprint: doc.fastFingerprint } : {}), createdAt: doc.createdAt, updatedAt: doc.updatedAt, source, recordVersion: 3 };
}

export async function updateDocumentChapters(id: string, chapters: ChapterNode[], chapterSource: DocumentChapterSource): Promise<void> {
  try { await idbUpdate('documents', id, (cur: any) => ({ ...cur, chapters, chapterSource, updatedAt: Date.now(), recordVersion: 3 })); }
  catch (e) { if (isRowMissing(e)) throw new DocumentNotFoundError(id); throw e; }
}

export function assertValidLastReadPage(page: number, pageCount: number): void {
  if (!Number.isInteger(page) || page < 0 || page > pageCount) throw new RangeError('invalid lastReadPage ' + String(page) + ' for document with ' + pageCount + ' pages');
}

/** Reading progress: updates lastReadPage + lastReadAt. It intentionally does NOT bump
 *  updatedAt any more (B2: updatedAt = metadata mutation; lastReadAt = reading activity). */
export async function updateLastReadPage(id: string, page: number): Promise<void> {
  try { await idbUpdate('documents', id, (cur: any) => { assertValidLastReadPage(page, cur.pageCount); return { ...cur, lastReadPage: page, lastReadAt: Date.now() }; }); }
  catch (e) { if (isRowMissing(e)) throw new DocumentNotFoundError(id); throw e; }
}

/** B4 rename: only fileName + updatedAt change. The import provenance
 *  (importSource.originalFileName) is NEVER touched — it stays the original import name. */
export async function renameDocument(id: string, newName: string): Promise<void> {
  const name = newName.trim()
  if (!name) throw new Error('document name must be non-empty after trim')
  try { await idbUpdate('documents', id, (cur: any) => ({ ...cur, fileName: name, updatedAt: Date.now(), recordVersion: 3 })); }
  catch (e) { if (isRowMissing(e)) throw new DocumentNotFoundError(id); throw e; }
}

/** Lazy-hash computation for a single document (B8): computes + persists contentHash and
 *  fastFingerprint when missing. Reads the source Blob exactly once per compute. Returns the
 *  hashes (may already exist → no re-read). Throws DocumentNotFoundError / BinaryMissing. */
export async function ensureDocumentHash(id: string): Promise<{ contentHash?: string; fastFingerprint?: string }> {
  const row = await idbGet('documents', id)
  if (!row) throw new DocumentNotFoundError(id)
  if (row.contentHash && row.fastFingerprint) return { contentHash: row.contentHash, fastFingerprint: row.fastFingerprint }
  const blob = await readDocumentSourceBlob(id)
  const contentHash = await computeContentHash(blob)
  const fastFingerprint = await computeFastFingerprint(blob)
  try { await idbUpdate('documents', id, (cur: any) => ({ ...cur, contentHash, fastFingerprint })) }
  catch (e) { if (isRowMissing(e)) throw new DocumentNotFoundError(id); /* metadata-only write; keep hashes in memory */ }
  return { contentHash, fastFingerprint }
}

/** Internal: read a raw persisted record (no binary hydration). */
export async function getStoredDocumentRecord(id: string): Promise<StoredDocumentRecord | null> {
  const row = await idbGet('documents', id)
  if (!row) return null
  if (!hasSourceRef(row)) return null
  return row as StoredDocumentRecord
}

export async function deleteDocument(id: string): Promise<void> {
  const row = await idbGet('documents', id);
  await idbDelete('documents', id);
  if (row && hasSourceRef(row) && row.source.storage === 'opfs') { try { await deleteBinary(row.source) } catch { /* orphan */ } }
}

export async function cleanupStaleDocument(id: string): Promise<void> { try { await deleteDocument(id) } catch { /* best-effort */ } }

export async function documentBinaryExists(id: string): Promise<boolean> {
  const row = await idbGet('documents', id);
  if (!row) return false;
  if (hasSourceRef(row)) return binaryExists(row.source);
  if (isLegacyRow(row)) return row.sourceBlob.size > 0;
  return false;
}