// attachmentService — the single authority for attachment lifecycle. The UI never touches IndexedDB, Blob, objectURL, or base64 directly.
import { newStableId, type Attachment, type StableId } from './types'
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

export async function getAttachment(id: StableId): Promise<Attachment | undefined> { const row = await getAttachmentRow(id); return row ? row.meta : undefined }
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
