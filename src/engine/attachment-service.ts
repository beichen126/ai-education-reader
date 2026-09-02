// attachmentService — the single authority for attachment lifecycle. The UI never touches IndexedDB, Blob, objectURL, or base64 directly.
import { newStableId, type Attachment, type PdfAttachmentSource, type StableId } from './types'
import { saveAttachments, getAttachmentRow, deleteAttachment as deleteAttachmentRow, attachmentExists } from '../storage/storage'

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
/** Product-side guard on the INLINE base64 image payload sent in one request.
 * Not a DeepSeek absolute limit — 30 MiB raw ≈ 40 MiB base64, leaving headroom
 * under the ~48 MiB HTTP body cap for JSON/text/data-URL prefixes. */
export const MAX_INLINE_IMAGE_RAW_BYTES = 30 * 1024 * 1024
const urlRegistry = new Map<string, { url: string; refs: number }>()

export function isSupportedImage(file: { type: string; size: number }): boolean { return SUPPORTED_MIME.has(file.type) && file.size > 0 }

/**
 * Persist a batch of files. All-or-nothing: we FIRST validate every file, and only if
 * all pass do we write them in ONE IndexedDB readwrite transaction. A single invalid
 * / too-large file aborts the whole batch and leaves no orphan blobs behind.
 */
export async function saveFiles(files: File[]): Promise<Attachment[]> {
  const now = Date.now()
  const metas: Attachment[] = []
  for (const f of files) {
    if (!isSupportedImage(f)) throw new AttachmentError('unsupported-format', 'unsupported image')
    if (f.size > MAX_IMAGE_BYTES) throw new AttachmentError('image-too-large', 'image too large')
    metas.push({ id: newStableId(), name: f.name, mimeType: f.type, size: f.size, createdAt: now, updatedAt: now })
  }
  if (metas.length) await saveAttachments(metas, files)
  return metas
}

/** Input for an app-generated image Blob (e.g. rendered PDF page).
 * source is OPTIONAL and supplied by the caller (the PDF flow) — the service
 * never guesses fileName/pageNumber/selection from names. */
export type GeneratedImageInput = { blob: Blob; name: string; source?: PdfAttachmentSource }

/**
 * Persist a batch of app-generated image Blobs (NOT user-picked files). Semantically
 * distinct from saveFiles(): these are produced internally (BMP/PDF page renders),
 * so they carry a generated name and must be pre-validated here (the UI file input
 * never saw them). Both paths funnel through the same single-transaction
 * saveAttachments() write, so a failed batch leaves zero orphan blobs.
 */
export async function saveGeneratedImages(images: GeneratedImageInput[]): Promise<Attachment[]> {
  if (!Array.isArray(images) || images.length === 0) throw new AttachmentError('read-failed', 'no generated images')
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
  await saveAttachments(metas, blobs)
  return metas
}

/** Sum the recorded raw byte size of a set of attachment ids (no base64/read). */
export async function sumAttachmentBytes(ids: StableId[]): Promise<number> {
  let total = 0
  for (const id of ids) {
    const a = await getAttachment(id)
    if (a) total += a.size
  }
  return total
}

/** True when the sum exceeds our inline-base64 request-size protection budget. */
export function isInlineImageOverBudget(totalBytes: number): boolean {
  return totalBytes > MAX_INLINE_IMAGE_RAW_BYTES
}

export async function getAttachment(id: StableId): Promise<Attachment | undefined> { const row = await getAttachmentRow(id); return row ? row.meta : undefined }
/** Load metadata for many attachment ids in order (missing ids are skipped). */
export async function getAttachments(ids: StableId[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const id of ids) { const a = await getAttachment(id); if (a) out.push(a) }
  return out
}
export async function existsAttachment(id: StableId): Promise<boolean> { return attachmentExists(id) }
async function blobOf(id: StableId): Promise<Blob> { const row = await getAttachmentRow(id); if (!row) throw new AttachmentError('missing-attachment', 'attachment missing'); try { if (!(row.blob instanceof Blob)) throw new Error('not blob'); return row.blob } catch { throw new AttachmentError('read-failed', 'read failed') } }

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
  await deleteAttachmentRow(id)
}
export function releaseAllPreviews(): void { for (const [id, e] of urlRegistry) { URL.revokeObjectURL(e.url); urlRegistry.delete(id) } }
