// attachmentService — the single authority for attachment lifecycle. The UI never
// touches IndexedDB, OPFS, Blob, objectURL, or base64 directly.
import { newStableId, type Attachment, type PdfAttachmentSource, type StableId } from './types'
import { saveAttachmentRow, saveAttachmentRows, getAttachmentRow, deleteAttachment as deleteAttachmentRow, attachmentExists, listAllAttachmentRows, listConversations, type StoredAttachmentRow } from '../storage/storage'
import { idbScan, idbGetAll, idbRunTxn } from '../storage/idb'
import { allBranches } from '../branches/branch-store'
import { persistBinary, readBinary, deleteBinary, type StoredBinary } from '../storage/binary-store'

export type AttachmentErrorKind = 'unsupported-format' | 'read-failed' | 'missing-attachment' | 'image-too-large' | 'vision-unsupported'
export class AttachmentError extends Error { readonly kind: AttachmentErrorKind; constructor(kind: AttachmentErrorKind, m: string) { super(m); this.kind = kind } }
export function attachmentErrorLabel(kind: AttachmentErrorKind): string {
  switch (kind) {
    case 'unsupported-format': return '不支持的图片格式（支持 JPEG/PNG/GIF/WebP）。'
    case 'read-failed': return '图片读取失败，请重试。'
    case 'missing-attachment': return '图片附件已丢失，请重新添加。'
    case 'image-too-large': return '图片过大，请换一张较小的图片。'
    case 'vision-unsupported': return '当前模型不支持图片，请切换到支持 Vision 的模型。'
    default: return '图片处理失败。'
  }
}

const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_INLINE_IMAGE_RAW_BYTES = 30 * 1024 * 1024
const urlRegistry = new Map<string, { url: string; refs: number }>()

export function isSupportedImage(file: { type: string; size: number }): boolean { return SUPPORTED_MIME.has(file.type) && file.size > 0 }

// ---- batch write with all-or-nothing semantics (Stage 9.4D.1) ----------------
// Binary bytes are persisted to OPFS FIRST (each gets a unique app path), refs are
// collected, then ALL metadata rows are committed in ONE IndexedDB transaction.
// If ANY binary write fails, the whole batch falls back to storage:'idb' (every blob
// goes inline in IndexedDB), so a transient OPFS failure never fails the upload and
// there is never a mix of partial-OPFS + partial-IDB for a single batch. Only a
// Quota / IndexedDB-write failure surfaces as an error (after cleaning staged OPFS).
async function stageAttachmentRows(metas: Attachment[], blobs: Blob[]): Promise<StoredAttachmentRow[]> {
  if (metas.length === 0) return []
  for (const m of metas) {
    if (!(m && typeof m.id === 'string')) throw new AttachmentError('read-failed', 'invalid attachment meta')
  }
  const written: StoredBinary[] = []
  const needIdbFallback = await persistAllOpfs('attachments', metas, blobs, written)
  let refs: StoredBinary[]
  if (!needIdbFallback) refs = written
  else {
    for (const w of written) { try { await deleteBinary(w) } catch { /* orphan */ } }
    refs = blobs.map(b => ({ storage: 'idb', blob: b, size: b.size, mimeType: b.type || 'application/octet-stream' }))
  }
  return metas.map((m, i) => ({ id: m.id, meta: m, binary: refs[i], recordVersion: 2 }))
}

async function writeBatch(namespace: 'attachments', metas: Attachment[], blobs: Blob[]): Promise<StoredAttachmentRow[]> {
  if (metas.length === 0) return []
  const rows = await stageAttachmentRows(metas, blobs)
  try { await saveAttachmentRows(rows) }
  catch (e) { for (const rrow of rows) { if (rrow.binary && rrow.binary.storage === 'opfs') { try { await deleteBinary(rrow.binary) } catch { /* orphan */ } } } throw e }
  return rows
}

/** Try to persist every blob to OPFS (requireOpfsWhenAvailable). Returns true if ANY write */
function persistAllOpfs(namespace: 'attachments', metas: Attachment[], blobs: Blob[], written: StoredBinary[]): Promise<boolean> {
  return (async () => {
    try {
      for (let i = 0; i < metas.length; i++) {
        const ref = await persistBinary(namespace, metas[i].id, blobs[i], { requireOpfsWhenAvailable: true })
        written.push(ref)
      }
      return false
    } catch {
      return true
    }
  })()
}

export async function saveFiles(files: File[]): Promise<Attachment[]> {
  const now = Date.now()
  const metas: Attachment[] = []
  const blobs: Blob[] = []
  for (const f of files) {
    if (!isSupportedImage(f)) throw new AttachmentError('unsupported-format', 'unsupported image');
    if (f.size > MAX_IMAGE_BYTES) throw new AttachmentError('image-too-large', 'image too large');
    metas.push({ id: newStableId(), name: f.name, mimeType: f.type, size: f.size, createdAt: now, updatedAt: now });
    blobs.push(f);
  }
  await writeBatch('attachments', metas, blobs);
  return metas;
}

export type GeneratedImageInput = { blob: Blob; name: string; source?: PdfAttachmentSource }

export type DraftOwnership = { conversationId: string; text: string; existingImageIds: string[] }

/**
 * Commit a set of generated attachment binaries PLUS their Draft ownership ATOMICALLY.
 * Binary bytes are staged to OPFS first (never in the IDB txn), then ONE readwrite
 * transaction across ['attachments','settings'] commits the attachment metadata rows AND
 * the draft:<conversationId> row together (resolve on transaction.oncomplete). A failure
 * commits NEITHER; staged OPFS binaries are deleted best-effort. This is the true
 * write-first/stage/commit/cleanup shape for PDF Context / Document->Context / image uploads.
 */
export type DraftCommitDeps = { /** Test seam: force the metadata transaction to abort (inspect IDB immediately after). */
  failTxn?: boolean }
export async function saveGeneratedImagesAndDraft(images: GeneratedImageInput[], draft: DraftOwnership, deps: DraftCommitDeps = {}): Promise<Attachment[]> {
  const now = Date.now()
  const metas: Attachment[] = []
  const blobs: Blob[] = []
  for (const g of images) {
    if (!(g.blob instanceof Blob) || g.blob.size <= 0) throw new AttachmentError('read-failed', 'empty blob')
    if (!SUPPORTED_MIME.has(g.blob.type)) throw new AttachmentError('unsupported-format', 'unsupported image')
    if (g.blob.size > MAX_IMAGE_BYTES) throw new AttachmentError('image-too-large', 'image too large')
    metas.push({ id: newStableId(), name: g.name || 'generated.jpg', mimeType: g.blob.type, size: g.blob.size, createdAt: now, updatedAt: now, ...(g.source ? { source: g.source } : {}) })
    blobs.push(g.blob)
  }
  const rows = await stageAttachmentRows(metas, blobs)
  try {
    await idbRunTxn(['attachments', 'settings'], (txn) => {
      // Test seam: abort the metadata transaction (used by failure-injection tests to prove
      // neither attachment rows nor draft refs commit, and staged OPFS binaries are cleaned).
      if (deps.failTxn) { txn.abort(); return }
      const aos = txn.objectStore('attachments')
      for (const row of rows) aos.put(row)
      const sos = txn.objectStore('settings')
      const newIds = rows.map(r => r.id)
      const imageIds = [...new Set([...(draft.existingImageIds || []), ...newIds])]
      if (draft.text !== '' || imageIds.length > 0) {
        sos.put({ key: 'draft:' + draft.conversationId, value: { version: 1, text: draft.text, imageIds } })
      } else {
        sos.delete('draft:' + draft.conversationId)
      }
    })
  } catch (e) {
    // Best-effort cleanup of staged OPFS binaries after a failed metadata transaction.
    for (const row of rows) { if (row.binary && row.binary.storage === 'opfs') { try { await deleteBinary(row.binary) } catch { /* orphan */ } } }
    throw e
  }
  return rows.map(r => r.meta)
}

export async function saveGeneratedImages(images: GeneratedImageInput[]): Promise<Attachment[]> {
  if (!Array.isArray(images) || images.length === 0) throw new AttachmentError('read-failed', 'no generated images');
  const now = Date.now()
  const metas: Attachment[] = []
  const blobs: Blob[] = []
  for (const g of images) {
    if (!(g.blob instanceof Blob) || g.blob.size <= 0) throw new AttachmentError('read-failed', 'empty blob');
    if (!SUPPORTED_MIME.has(g.blob.type)) throw new AttachmentError('unsupported-format', 'unsupported image');
    if (g.blob.size > MAX_IMAGE_BYTES) throw new AttachmentError('image-too-large', 'image too large');
    metas.push({ id: newStableId(), name: g.name || 'generated.jpg', mimeType: g.blob.type, size: g.blob.size, createdAt: now, updatedAt: now, ...(g.source ? { source: g.source } : {}) });
    blobs.push(g.blob);
  }
  await writeBatch('attachments', metas, blobs);
  return metas;
}

export async function sumAttachmentBytes(ids: StableId[]): Promise<number> {
  let total = 0
  for (const id of ids) { const a = await getAttachment(id); if (a) total += a.size }
  return total
}

export function isInlineImageOverBudget(totalBytes: number): boolean { return totalBytes > MAX_INLINE_IMAGE_RAW_BYTES }
export function wouldExceedInlineBudget(existingBytes: number, newBytes: number): boolean { return existingBytes + newBytes > MAX_INLINE_IMAGE_RAW_BYTES }

export async function getAttachment(id: StableId): Promise<Attachment | undefined> { const row = await getAttachmentRow(id); return row ? row.meta : undefined }
export async function getAttachments(ids: StableId[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const id of ids) { const a = await getAttachment(id); if (a) out.push(a) }
  return out
}
export async function existsAttachment(id: StableId): Promise<boolean> { return attachmentExists(id) }

async function blobOf(id: StableId): Promise<Blob> {
  const row = await getAttachmentRow(id);
  if (!row) throw new AttachmentError('missing-attachment', 'attachment missing');
  try {
    if (row.binary) return await readBinary(row.binary);
    if (row.blob instanceof Blob) return row.blob;
    throw new Error('no binary');
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError('missing-attachment', 'binary missing');
  }
}

export async function ensurePreviewUrl(id: StableId): Promise<string> {
  const existing = urlRegistry.get(id); if (existing) { existing.refs++; return existing.url }
  const blob = await blobOf(id)
  const url = URL.createObjectURL(blob)
  urlRegistry.set(id, { url, refs: 1 })
  return url
}
export function releasePreviewUrl(id: StableId): void {
  const e = urlRegistry.get(id); if (!e) return; e.refs--;
  if (e.refs <= 0) { URL.revokeObjectURL(e.url); urlRegistry.delete(id) }
}

export async function toDataUrl(id: StableId): Promise<string> {
  const blob = await blobOf(id)
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''; const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any)
  return 'data:' + blob.type + ';base64,' + btoa(bin)
}

export async function deleteAttachment(id: StableId): Promise<void> {
  const e = urlRegistry.get(id); if (e) { URL.revokeObjectURL(e.url); urlRegistry.delete(id) }
  const row = await getAttachmentRow(id);
  await deleteAttachmentRow(id);
  if (row && row.binary && row.binary.storage === 'opfs') { try { await deleteBinary(row.binary) } catch { /* orphan */ } }
}
export function releaseAllPreviews(): void { for (const [id, e] of urlRegistry) { URL.revokeObjectURL(e.url); urlRegistry.delete(id) } }

/**
 * Conservative attachment graph-reachability cleanup. Live attachment references are
 * those reachable from: conversation MESSAGES, or persisted DRAFTS. Attachment rows not
 * reachable from either graph AND older than `graceMs` (24h default) are deleted with
 * their binary. Never touches anything younger (in-flight/staged data), never enumerates
 * another app/origin directory (deleteBinary only removes this app's own namespace).
 * Best-effort: never throws; only reports the count of removed orphans.
 */
export async function cleanupOrphanAttachments(graceMs = 24 * 60 * 60 * 1000): Promise<{ removed: number }> {
  try {
    // Live set = ROOT message images + ROOT drafts + BRANCH message images + BRANCH drafts.
    const live = new Set<string>()
    for (const conv of await listConversations()) {
      for (const m of (conv.messages || [])) { for (const img of (m.images || [])) live.add(img) }
    }
    // Branch-local messages own attachments too (image / PDF Context / Document Context).
    for (const b of await allBranches()) {
      for (const m of (b.messages || [])) { for (const img of (m.images || [])) live.add(img) }
    }
    const draftRows = await idbGetAll('settings')
    for (const row of draftRows) {
      if (typeof row.key === 'string' && (row.key.indexOf('draft:') === 0 || row.key.indexOf('draft-branch:') === 0)) {
        const val = row.value
        if (val && Array.isArray(val.imageIds)) for (const img of val.imageIds) live.add(img)
      }
    }
    const cutoff = Date.now() - graceMs
    let removed = 0
    // idbScan walks the attachments store one row at a time; collect deletes, then batch.
    const toDelete: string[] = []
    await idbScan('attachments', (row: StoredAttachmentRow) => {
      if (!row || live.has(row.id)) return
      const created = row.meta && typeof row.meta.createdAt === 'number' ? row.meta.createdAt : 0
      if (created >= cutoff) return // too new — likely in-flight/staged
      toDelete.push(row.id)
    })
    for (const id of toDelete) {
      try {
        const rowr = await getAttachmentRow(id)
        await deleteAttachment(id)
        if (rowr && rowr.binary && rowr.binary.storage === 'opfs') { try { await deleteBinary(rowr.binary) } catch { /* orphan */ } }
        removed++
      } catch { /* best-effort, skip */ }
    }
    return { removed }
  } catch { return { removed: 0 } }
}