import { listConversations, getAnnotationsByConversation, getAttachmentRow, getSetting } from '../storage/storage'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupAttachment, type BackupV1 } from './backup-types'

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''; const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any)
  return btoa(bin)
}

/** Build a full BackupV1 from current local data. The DeepSeek API key is EXCLUDED. */
export async function buildBackup(): Promise<BackupV1> {
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
        if (row && row.meta && row.blob) {
          attachments.push({ id: row.meta.id, meta: row.meta, mimeType: row.meta.mimeType, data: await blobToBase64(row.blob) })
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
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), settings, conversations, annotations, attachments }
}
