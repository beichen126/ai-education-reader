// Document import service (Agent B, B9). Extraction of the growing import logic out of the
// DocumentLibrary React component. Owns: validation, duplicate candidate lookup (layered),
// fingerprint/content-hash, exact-duplicate detection, name-conflict resolution metadata,
// and document creation. The React component only renders state and hands the file over.
import { createDocument, updateDocumentChapters, listDocumentSummaries, ensureDocumentHash, type DocumentSummary } from './document-service'
import { computeDocumentHashes, type DocumentHashes } from './document-hash'
import { chapterNodesFromPdfOutline } from './chapter-model'
import type { PdfSession } from '../pdf/pdf-session'
import { newStableId } from '../engine/types'
import type { ChapterNode } from './document-types'

export type ImportConflict =
  | { kind: 'none' }
  | { kind: 'exact-duplicate'; existingDocumentId: string; existingFileName: string }
  | { kind: 'name-conflict'; baseFileName: string; suggestedName: string }

export type ImportAnalysis = {
  fileName: string
  pageCount: number
  chapters: ChapterNode[]
  chapterSource: 'none' | 'native'
  contentHash: string
  fastFingerprint: string
  conflict: ImportConflict
}

// ---- name policy (B4/B6) ----
const DANGEROUS = /[\\/:*?"<>|\u0000-\u001f]/g

/** Trim + strip filesystem-hostile chars + collapse whitespace; never empty. */
export function sanitizeFileName(name: string): string {
  let n = (name ?? '').trim().replace(DANGEROUS, '_').replace(/\s+/g, ' ')
  if (!n) n = 'document'
  return n
}

export function splitFileName(name: string): { stem: string; ext: string } {
  const trimmed = name.trim()
  const idx = trimmed.lastIndexOf('.')
  if (idx <= 0) return { stem: trimmed, ext: '' }
  return { stem: trimmed.slice(0, idx), ext: trimmed.slice(idx) }
}

/** Deterministic conflict-free name: name.pdf -> name (2).pdf -> name (3).pdf ... (B6). */
export function nextAvailableName(baseName: string, existing: ReadonlySet<string>): string {
  const { stem, ext } = splitFileName(baseName)
  let candidate = baseName
  let n = 2
  while (existing.has(candidate)) {
    candidate = stem + ' (' + n + ')' + ext
    n++
  }
  return candidate
}

// ---- layered duplicate detection (B8) ----
/**
 * Stage 1 filters by fileSize; Stage 2 lazily ensures the candidate fast fingerprint; Stage 3
 * compares the full contentHash (the ONLY value that may assert "exact duplicate"). Never
 * precomputes hashes for the whole library — only size-matched candidates get a lazy hash.
 */
export async function resolveImportConflict(input: { fileName: string; fileSize: number; contentHash: string; fastFingerprint: string }, summaries?: DocumentSummary[]): Promise<ImportConflict> {
  const all = summaries ?? (await listDocumentSummaries())
  const candidates = all.filter(s => s.fileSize === input.fileSize)
  for (const c of candidates) {
    if (!c.contentHash || !c.fastFingerprint) {
      try { const h = await ensureDocumentHash(c.id); c.contentHash = h.contentHash; c.fastFingerprint = h.fastFingerprint }
      catch { /* unreadable candidate — skip, never block an import */ }
    }
  }
  const exact = candidates.find(c => c.contentHash === input.contentHash)
  if (exact) return { kind: 'exact-duplicate', existingDocumentId: exact.id, existingFileName: exact.fileName }
  const sameName = all.find(s => s.fileName === input.fileName)
  if (sameName) {
    const existing = new Set(all.map(s => s.fileName))
    return { kind: 'name-conflict', baseFileName: input.fileName, suggestedName: nextAvailableName(input.fileName, existing) }
  }
  return { kind: 'none' }
}

// ---- import analysis + creation ----
/** Open the PDF once, read pageCount + native outline, hash it, and run the conflict check.
 *  The temporary session is ALWAYS closed (idempotent) — the reader opens its own later. */
export async function analyzeImport(file: File, summaries?: DocumentSummary[]): Promise<ImportAnalysis> {
  const { openPdfSession, readSessionOutline, closePdfSession } = await import('../pdf/pdf-session')
  let session: PdfSession | null = null
  try {
    const opened = await openPdfSession(file)
    session = opened.session
    let chapters: ChapterNode[] = []
    let chapterSource: 'none' | 'native' = 'none'
    try {
      const o = await readSessionOutline(session)
      if (o.items.length > 0) { chapters = chapterNodesFromPdfOutline(o.items); chapterSource = 'native' }
    } catch { /* no outline -> none */ }
    const hashes = await computeDocumentHashes(file)
    const conflict = await resolveImportConflict({ fileName: file.name, fileSize: file.size, contentHash: hashes.contentHash, fastFingerprint: hashes.fastFingerprint }, summaries)
    return { fileName: file.name, pageCount: opened.doc.pageCount, chapters, chapterSource, contentHash: hashes.contentHash, fastFingerprint: hashes.fastFingerprint, conflict }
  } finally {
    if (session) { try { await closePdfSession(session) } catch { /* ignore */ } }
  }
}

export type FinalizeImportInput = {
  /** User display name (already resolved — could be the original or a (2) auto-rename). */
  fileName: string
  /** Provenance: the ORIGINAL imported filename (never mutated by rename / dedup naming). */
  originalFileName: string
  pageCount: number
  chapters: ChapterNode[]
  chapterSource: 'none' | 'native'
  sourceBlob: Blob
  contentHash: string
  fastFingerprint: string
}

/** Create the document record + persist any native outline. Returns the new document id. */
export async function createDocumentFromImport(input: FinalizeImportInput): Promise<string> {
  const id = newStableId()
  await createDocument({
    id, fileName: input.fileName, mimeType: 'application/pdf', fileSize: input.sourceBlob.size,
    pageCount: input.pageCount, sourceBlob: input.sourceBlob,
    importSource: { kind: 'pdf', originalFileName: input.originalFileName },
    contentHash: input.contentHash, fastFingerprint: input.fastFingerprint,
  })
  if (input.chapters.length > 0) { try { await updateDocumentChapters(id, input.chapters, input.chapterSource) } catch { /* metadata only */ } }
  return id
}

export type { DocumentHashes }
