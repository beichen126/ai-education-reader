import { listConversations, getAnnotationsByConversation, getAttachmentRow, getSetting } from '../storage/storage'
import { listDocuments, readDocumentSourceBlob } from '../documents/document-service'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupAttachment, type BackupDocument, type BackupV2 } from './backup-types'
import { readBinary } from '../storage/binary-store'

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''; const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any)
  return btoa(bin)
}

// Read an attachment's bytes via the binary store (OPFS-first), so the external Backup V2
// stays backend-agnostic: it NEVER leaks OPFS path / StoredBinary / recordVersion.
async function attachmentBlobOf(id: string): Promise<Blob | null> {
  const row = await getAttachmentRow(id);
  if (!row) return null;
  if (row.binary) { try { return await readBinary(row.binary) } catch { return null } }
  if (row.blob instanceof Blob) return row.blob;
  return null;
}

export async function buildBackup(): Promise<BackupV2> {
  const conversations = await listConversations()
  const annotations: Annotation[] = []
  const attachments: BackupAttachment[] = []
  const seen = new Set<string>()
  for (const conv of conversations) {
    const cAnns = await getAnnotationsByConversation(conv.id)
    annotations.push(...cAnns)
    for (const m of conv.messages) {
      for (const imgId of m.images) {
        if (seen.has(imgId)) continue; seen.add(imgId)
        const row = await getAttachmentRow(imgId)
        if (row && row.meta) {
          const blob = await attachmentBlobOf(imgId);
          if (blob) attachments.push({ id: row.meta.id, meta: row.meta, mimeType: row.meta.mimeType, data: await blobToBase64(blob) });
        }
      }
    }
  }
  const [apiBaseUrl, model, customSystemPrompt, customSystemPromptEnabled] = await Promise.all([
    getSetting('apiBaseUrl'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled'),
  ])
  const settings = {
    apiBaseUrl: (typeof apiBaseUrl === 'string' ? apiBaseUrl : 'https://api.deepseek.com'),
    model: (typeof model === 'string' ? model : 'deepseek-chat'),
    customSystemPrompt: (typeof customSystemPrompt === 'string' ? customSystemPrompt : ''),
    customSystemPromptEnabled: customSystemPromptEnabled === 'true',
  }
  const documents: BackupDocument[] = []
  for (const doc of await listDocuments()) {
    try {
      const blob = await readDocumentSourceBlob(doc.id);
      const { sourceBlob, ...meta } = doc;
      documents.push({ id: doc.id, meta: meta as BackupDocument['meta'], mimeType: blob.type || doc.mimeType || 'application/pdf', data: await blobToBase64(blob) });
    } catch { /* skip a document whose binary is missing */ }
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), settings, conversations, annotations, attachments, documents }
}
