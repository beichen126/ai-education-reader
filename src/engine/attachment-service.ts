// attachmentService — the single authority for attachment lifecycle. The UI never
// touches IndexedDB, OPFS, Blob, objectURL, or base64 directly.
import { newStableId, type Attachment, type PdfAttachmentSource, type StableId } from './types'
import { saveAttachmentRow, saveAttachmentRows, getAttachmentRow, deleteAttachment as deleteAttachmentRow, attachmentExists, listAllAttachmentRows, type StoredAttachmentRow } from '../storage/storage'
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
async function writeBatch(namespace: 'attachments', metas: Attachment[], blobs: Blob[]): Promise<StoredAttachmentRow[]> {
  if (metas.length === 0) return []
  const written: StoredBinary[] = []
  const needIdbFallback = await persistAllOpfs(namespace, metas, blobs, written)
  let refs: StoredBinary[]
  if (!needIdbFallback) {
    refs = written
  } else {
    // Clean up every staged OPFS file, then rebuild the ENTIRE batch as inline IDB refs.
    for (const w of written) { try { await deleteBinary(w) } catch { /* orphan */ } }
    refs = []
    for (const b of blobs) refs.push({ storage: 'idb', blob: b, size: b.size, mimeType: b.type || 'application/octet-stream' })
  }
  const rows: StoredAttachmentRow[] = metas.map((m, i) => ({ id: m.id, meta: m, binary: refs[i], recordVersion: 2 }))
  // ONE metadata transaction. A failure here is a genuine storage error (no partial).
  try { await saveAttachmentRows(rows) }
  catch (e) { for (const r of refs) { if (r.storage === 'opfs') { try { await deleteBinary(r) } catch { /* orphan */ } } } throw e }
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