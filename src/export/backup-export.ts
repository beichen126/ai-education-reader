import { listConversations, getAnnotationsByConversation, getAttachmentRow, getSetting } from '../storage/storage'
import { idbGetAll } from '../storage/idb'
import { listDocumentRecords, readDocumentSourceBlob } from '../documents/document-service'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupAttachment, type BackupDocument, type BackupV3, type BackupDraft, type BackupV4, type BackupBranchDraft, type BackupActiveBranch } from './backup-types'
import { readBinary } from '../storage/binary-store'
import { BackupError, parseAndValidate } from './backup-import'
import { allBranches, getActiveBranch } from '../branches/branch-store'
import { listArtifacts } from '../artifacts/artifact-store'
import { listCustomActions } from '../artifacts/custom-action-store'

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''; const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any)
  return btoa(bin)
}

// Read an attachment's bytes via the binary store (OPFS-first). A referenced attachment that
// cannot be read makes the "complete backup" FAIL (never silently omit it).
async function attachmentBlobOf(id: string, mime: string): Promise<Blob> {
  const row = await getAttachmentRow(id)
  if (!row) throw new BackupError('本地文件数据不完整，无法生成完整备份：附件 ' + id.slice(0, 8) + ' 不存在')
  let blob: Blob | undefined
  if (row.binary) { try { blob = await readBinary(row.binary) } catch { blob = undefined } }
  else blob = row.blob instanceof Blob ? row.blob : undefined
  if (!blob) throw new BackupError('本地文件数据不完整，无法生成完整备份：附件 ' + id.slice(0, 8) + ' 数据缺失')
  // ReadBinary returns a MIME-corrected Blob; ensure the type is recorded for the backup.
  return blob.type ? blob : blob.slice(0, blob.size, mime || 'application/octet-stream')
}

export async function buildBackup(): Promise<BackupV4> {
  const conversations = await listConversations()
  const annotations: Annotation[] = []
  const attachments: BackupAttachment[] = []
  const seen = new Set<string>()
  // Collect attachment ids referenced by conversation messages.
  for (const conv of conversations) {
    const cAnns = await getAnnotationsByConversation(conv.id)
    annotations.push(...cAnns)
    for (const m of conv.messages) {
      for (const imgId of m.images) {
        if (!seen.has(imgId)) seen.add(imgId)
      }
    }
  }
  // Branch-local messages own attachments too (image / PDF Context / Document Context).
  const branches = await allBranches()
  for (const b of branches) {
    for (const m of b.messages) for (const imgId of m.images) if (!seen.has(imgId)) seen.add(imgId)
  }
  // V3: a complete backup must also include UNSENT Draft user data. Read the persisted
  // draft rows (settings key draft:<conversationId>) and UNION their attachment ids.
  const drafts: BackupDraft[] = []
  const branchDrafts: BackupBranchDraft[] = []
  const activeBranches: BackupActiveBranch[] = []
  const settingsRows = await idbGetAll('settings')
  for (const row of settingsRows) {
    if (typeof row.key !== 'string') continue
    if (row.key.indexOf('draft:') === 0) {
      const convId = row.key.slice('draft:'.length)
      const v = row.value
      if (v && typeof v.text === 'string' && Array.isArray(v.imageIds)) {
        drafts.push({ conversationId: convId, text: v.text, imageIds: v.imageIds.filter((x: any) => typeof x === 'string') })
        for (const imgId of v.imageIds) if (!seen.has(imgId)) seen.add(imgId)
      }
    } else if (row.key.indexOf('draft-branch:') === 0) {
      const branchId = row.key.slice('draft-branch:'.length)
      const v = row.value
      if (v && typeof v.text === 'string' && Array.isArray(v.imageIds)) {
        branchDrafts.push({ branchId, text: v.text, imageIds: v.imageIds.filter((x: any) => typeof x === 'string') })
        for (const imgId of v.imageIds) if (!seen.has(imgId)) seen.add(imgId)
      }
    } else if (row.key.indexOf('activeBranch:') === 0) {
      const conversationId = row.key.slice('activeBranch:'.length)
      if (typeof row.value === 'string' && row.value) activeBranches.push({ conversationId, branchId: row.value })
    }
  }
  // A missing / unreadable referenced attachment (message OR draft) fails the WHOLE export.
  for (const imgId of seen) {
    const row = await getAttachmentRow(imgId)
    if (!row) throw new BackupError('本地文件数据不完整，无法生成完整备份：附件 ' + imgId.slice(0, 8) + ' 不存在')
    if (!row.meta) throw new BackupError('本地文件数据不完整，无法生成完整备份：附件 ' + imgId.slice(0, 8) + ' 元数据缺失')
    const blob = await attachmentBlobOf(imgId, row.meta.mimeType)
    attachments.push({ id: row.meta.id, meta: row.meta, mimeType: row.meta.mimeType, data: await blobToBase64(blob) })
  }
  const [apiBaseUrl, model, customSystemPrompt, customSystemPromptEnabled, appearance] = await Promise.all([
    getSetting('apiBaseUrl'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled'), getSetting('appearance'),
  ])
  const settings = {
    apiBaseUrl: (typeof apiBaseUrl === 'string' ? apiBaseUrl : 'https://api.deepseek.com'),
    model: (typeof model === 'string' ? model : 'deepseek-chat'),
    customSystemPrompt: (typeof customSystemPrompt === 'string' ? customSystemPrompt : ''),
    customSystemPromptEnabled: customSystemPromptEnabled === 'true',
    customArtifactActions: await listCustomActions(),
  }
  const appearanceOut: 'system' | 'light' | 'dark' = (appearance === 'light' || appearance === 'dark') ? appearance : 'system'
  // Local Document Library: iterate ONE record at a time (metadata, one binary read, base64,
  // next) — never hydrate the whole library first. A document binary that cannot be read
  // makes the backup FAIL (complete backups must be complete).
  const documents: BackupDocument[] = []
  for (const rec of await listDocumentRecords()) {
    let blob: Blob
    try { blob = await readBinaryForExport(rec.id) }
    catch { throw new BackupError('本地文件数据不完整，无法生成完整备份：文档 ' + rec.id.slice(0, 8) + ' 数据缺失') }
    documents.push({ id: rec.id, meta: rec.meta as BackupDocument['meta'], mimeType: blob.type || rec.meta.mimeType || 'application/pdf', data: await blobToBase64(blob) })
  }
  const artifacts = await listArtifacts()
  const backup: BackupV4 = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), settings, conversations, annotations, attachments, documents, drafts, appearance: appearanceOut, branches, branchDrafts, artifacts, activeBranches }
  // Final self-validation (finding 9.4D.2-0.2): the assembled object MUST pass the SAME
  // pure reference-integrity validator used for import (no JSON round-trip). A "complete"
  // backup that references a missing attachment/document/draft is rejected here, not shipped.
  parseAndValidate(backup)
  return backup
}

// Read exactly ONE document's source Blob (imported here to avoid a hard circular import
// at module load — backup-import imports binary-store; this stays a lazy boundary hook.
async function readBinaryForExport(id: string): Promise<Blob> {
  const { readDocumentSourceBlob } = await import('../documents/document-service');
  return readDocumentSourceBlob(id)
}