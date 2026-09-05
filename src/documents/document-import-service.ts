// Document import service (Agent B, B9). Extraction of the growing import logic out of the
// DocumentLibrary React component. Owns: validation, duplicate candidate lookup (layered),
// fingerprint/content-hash, exact-duplicate detection, name-conflict resolution metadata,
// and document creation. The React component only renders state and hands the file over.
import { createDocument, updateDocumentChapters, listDocumentSummaries, ensureDocumentFastFingerprint, ensureDocumentContentHash, type DocumentSummary } from './document-service'
import { computeContentHash, computeFastFingerprint, isHashAvailable, type DocumentHashes } from './document-hash'
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
  /** Full SHA-256 of the source binary. OPTIONAL: absent when Web Crypto is unavailable (H1) or
   *  when no potential duplicate candidate existed (H3 — the full hash is computed lazily). */
  contentHash?: string
  /** Cheap head+tail fingerprint (stage-2 candidate filter). Optional for the same reasons. */
  fastFingerprint?: string
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
 * Layered, IO-staged duplicate detection (Agent H, H2). Stage 1 filters by fileSize. Stage 2
 * ensures each candidate's CHEAP fast fingerprint and EXCLUDES fingerprint-mismatched candidates
 * BEFORE any full content-hash read. Stage 3 computes the FULL content hash only for a
 * fingerprint-matching candidate (the ONLY value that may assert an exact duplicate — a
 * fingerprint match is never treated as a duplicate). When Web Crypto is unavailable (H1) the
 * whole hash layer is skipped: a valid import still succeeds and only filename conflicts apply.
 */
export async function resolveImportConflict(input: { fileName: string; fileSize: number; contentHash?: string; fastFingerprint?: string }, summaries?: DocumentSummary[]): Promise<ImportConflict> {
  const all = summaries ?? (await listDocumentSummaries())
  const candidates = all.filter(s => s.fileSize === input.fileSize)
  const hashAvailable = isHashAvailable()
  for (const c of candidates) {
    if (!hashAvailable) break // H1: no hashing -> can never assert an exact duplicate
    // Stage 2: ensure candidate fingerprint (cheap head+tail). Mismatch -> exclude, no full read.
    let cFp = c.fastFingerprint
    if (!cFp) { try { cFp = (await ensureDocumentFastFingerprint(c.id)).fastFingerprint } catch { /* unreadable — skip */ } }
    if (cFp && input.fastFingerprint && cFp !== input.fastFingerprint) continue
    // Stage 3: fingerprint matched (or input fingerprint unavailable) — only NOW the full hash.
    const cHash = c.contentHash ?? (cFp ? (await ensureDocumentContentHash(c.id)).contentHash : undefined)
    if (input.contentHash && cHash && cHash === input.contentHash) {
      return { kind: 'exact-duplicate', existingDocumentId: c.id, existingFileName: c.fileName }
    }
  }
  const sameName = all.find(s => s.fileName === input.fileName)
  if (sameName) {
    const existing = new Set(all.map(s => s.fileName))
    return { kind: 'name-conflict', baseFileName: input.fileName, suggestedName: nextAvailableName(input.fileName, existing) }
  }
  return { kind: 'none' }
}

// ---- import analysis + creation ----
/** Open the PDF once, read pageCount + native outline, run the (IO-staged) conflict check, and
 *  the temporary session is ALWAYS closed (idempotent) — the reader opens its own later (H1/H3).
 *  Hash is an ENHANCEMENT: only the cheap fingerprint is computed when Web Crypto is available,
 *  and the FULL content hash is computed ONLY when there is a potential same-size candidate (a
 *  plain first import never re-reads the whole file just to hash it). */
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
    const all = summaries ?? (await listDocumentSummaries())
    const hashAvailable = isHashAvailable()
    const fastFingerprint = hashAvailable ? await computeFastFingerprint(file) : undefined
    // Stage-3 full hash only when a potential (same-size) candidate exists — H3 lazy, H1 degrade.
    const hasSizeCandidate = all.some(s => s.fileSize === file.size)
    const contentHash = (hashAvailable && hasSizeCandidate) ? await computeContentHash(file) : undefined
    const conflict = await resolveImportConflict({ fileName: file.name, fileSize: file.size, contentHash, fastFingerprint }, all)
    return {
      fileName: file.name, pageCount: opened.doc.pageCount, chapters, chapterSource,
      ...(contentHash !== undefined ? { contentHash } : {}),
      ...(fastFingerprint !== undefined ? { fastFingerprint } : {}),
      conflict,
    }
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
  /** Optional: absent when Web Crypto is unavailable (H1) or no candidate existed (H3). */
  contentHash?: string
  fastFingerprint?: string
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
