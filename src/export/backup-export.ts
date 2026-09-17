import { listConversations, getAnnotationsByConversation, getAttachmentRow, getSetting } from '../storage/storage'
import { idbGetAll } from '../storage/idb'
import { listDocumentRecords, readDocumentSourceBlob } from '../documents/document-service'
import { listDocumentNotes } from '../documents/document-note-service'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import { BACKUP_FORMAT, BACKUP_VERSION, PORTABLE_ARCHIVE_FORMAT, type BackupAttachment, type BackupDocument, type BackupDraft, type BackupV7, type BackupBranchDraft, type BackupActiveBranch, type PortableBackupManifest, type PortableBackupV7 } from './backup-types'
import { readBinary } from '../storage/binary-store'
import { BackupError, parseAndValidate } from './backup-import'
import { allBranches, getActiveBranch } from '../branches/branch-store'
import { listArtifacts } from '../artifacts/artifact-store'
import { listCustomActions } from '../artifacts/custom-action-store'
import { listPromptRecords } from '../prompts/prompt-store'
import { getPromptPreferences } from '../prompts/prompt-preferences'
import { normalizePdfNavigationMode } from '../engine/pdf-navigation-settings'
import { listStudyCards } from '../study-cards/study-card-service'
import { validateStudyCard } from '../study-cards/study-card-validation'
import { STUDY_CARD_PREFERENCES_KEY } from '../study-cards/learning-ui-store'
import { LAYOUT_PREFERENCES_KEY, normalizeLayoutPreferences } from '../engine/layout-store'
import { loadSortPreference } from '../documents/document-sort'

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

type PortableBinaryEntry = { entry: string; blob: Blob }
export type PortableBackupPlan = { manifest: PortableBackupManifest; binaries: PortableBinaryEntry[] }

async function buildBackupData(portable: false): Promise<BackupV7>
async function buildBackupData(portable: true): Promise<PortableBackupPlan>
async function buildBackupData(portable: boolean): Promise<BackupV7 | PortableBackupPlan> {
  const conversations = (await listConversations()).map((conversation) => ({
    ...conversation,
    promptTransitions: conversation.promptTransitions ?? [],
  }))
  const annotations: Annotation[] = []
  const attachments: Array<BackupAttachment | { id: string; meta: Attachment; mimeType: string; entry: string }> = []
  const binaries: PortableBinaryEntry[] = []
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
  const branches = (await allBranches()).map((branch) => ({
    ...branch,
    promptTransitions: branch.promptTransitions ?? [],
  }))
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
    if (portable) {
      const entry = 'attachments/' + encodeURIComponent(row.meta.id)
      attachments.push({ id: row.meta.id, meta: row.meta, mimeType: row.meta.mimeType, entry })
      binaries.push({ entry, blob })
    } else {
      attachments.push({ id: row.meta.id, meta: row.meta, mimeType: row.meta.mimeType, data: await blobToBase64(blob) })
    }
  }
  const [apiBaseUrl, model, customSystemPrompt, customSystemPromptEnabled, appearance, visionCapability, pdfNavigationMode, uiLanguage, layoutPreferences, productGuideSeenVersion, lastConversationId] = await Promise.all([
    getSetting('apiBaseUrl'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled'), getSetting('appearance'), getSetting('visionCapability'), getSetting('pdfNavigationMode'), getSetting('uiLanguage'), getSetting(LAYOUT_PREFERENCES_KEY), getSetting('productGuideSeenVersion'), getSetting('lastConversationId'),
  ])
  const settings = {
    apiBaseUrl: (typeof apiBaseUrl === 'string' ? apiBaseUrl : 'https://api.deepseek.com'),
    model: (typeof model === 'string' ? model : 'deepseek-chat'),
    customSystemPrompt: (typeof customSystemPrompt === 'string' ? customSystemPrompt : ''),
    customSystemPromptEnabled: customSystemPromptEnabled === 'true',
    customArtifactActions: await listCustomActions(),
    visionCapability: (visionCapability === 'supports-image' || visionCapability === 'text-only') ? visionCapability : 'auto',
    pdfNavigationMode: normalizePdfNavigationMode(pdfNavigationMode),
    uiLanguage: uiLanguage === 'en' ? 'en' as const : 'zh-CN' as const,
    layoutPreferences: normalizeLayoutPreferences(layoutPreferences),
    documentSort: loadSortPreference(),
    ...(typeof productGuideSeenVersion === 'string' ? { productGuideSeenVersion } : {}),
    ...(typeof lastConversationId === 'string' ? { lastConversationId } : {}),
  }
  const appearanceOut: 'system' | 'light' | 'dark' = (appearance === 'light' || appearance === 'dark') ? appearance : 'system'
  // Local Document Library: iterate ONE record at a time (metadata, one binary read, base64,
  // next) — never hydrate the whole library first. A document binary that cannot be read
  // makes the backup FAIL (complete backups must be complete).
  const documents: Array<BackupDocument | { id: string; meta: BackupDocument['meta']; mimeType: string; entry: string }> = []
  for (const rec of await listDocumentRecords()) {
    let blob: Blob
    try { blob = await readBinaryForExport(rec.id) }
    catch { throw new BackupError('本地文件数据不完整，无法生成完整备份：文档 ' + rec.id.slice(0, 8) + ' 数据缺失') }
    const mimeType = blob.type || rec.meta.mimeType || 'application/pdf'
    if (portable) {
      const entry = 'documents/' + encodeURIComponent(rec.id) + '.pdf'
      documents.push({ id: rec.id, meta: rec.meta as BackupDocument['meta'], mimeType, entry })
      binaries.push({ entry, blob })
    } else {
      documents.push({ id: rec.id, meta: rec.meta as BackupDocument['meta'], mimeType, data: await blobToBase64(blob) })
    }
  }
  const documentNotes = await listDocumentNotes()
  const artifacts = await listArtifacts()
  const prompts = await listPromptRecords()
  const promptPreferences = await getPromptPreferences()
  // Study cards are exported as primary data. The derived page index is NOT exported: it is
  // rebuilt from the cards on import. A card that no longer validates FAILS the whole export
  // and names itself, so a "complete" backup can never silently drop user data.
  const studyCards = (await listStudyCards()).map(card => {
    try { return validateStudyCard(card) }
    catch { throw new BackupError('学习卡片数据不合法，无法生成完整备份：卡片 ' + card?.id?.slice(0, 8)) }
  })
  const studyCardPreferences = await getSetting(STUDY_CARD_PREFERENCES_KEY)
  const backup = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), settings, conversations, annotations, attachments, documents, documentNotes, drafts, appearance: appearanceOut, branches, branchDrafts, artifacts, activeBranches, prompts, promptPreferences,
    studyCards,
    ...(studyCardPreferences && typeof studyCardPreferences === 'object' ? { studyCardPreferences: studyCardPreferences as BackupV7['studyCardPreferences'] } : {}),
  } as BackupV7 | PortableBackupV7
  // Final self-validation (finding 9.4D.2-0.2): the assembled object MUST pass the SAME
  // pure reference-integrity validator used for import (no JSON round-trip). A "complete"
  // backup that references a missing attachment/document/draft is rejected here, not shipped.
  if (portable) {
    return {
      manifest: { archiveFormat: PORTABLE_ARCHIVE_FORMAT, archiveVersion: 2, backup: backup as PortableBackupV7 },
      binaries,
    }
  }
  parseAndValidate(backup)
  return backup as BackupV7
}

export async function buildBackup(): Promise<BackupV7> { return buildBackupData(false) }

/** Build a lightweight manifest plus Blob handles. Blob bytes are not base64-encoded or
 * materialized here; the ZIP writer consumes each stream incrementally. */
export async function buildPortableBackupPlan(): Promise<PortableBackupPlan> { return buildBackupData(true) }

// Read exactly ONE document's source Blob (imported here to avoid a hard circular import
// at module load — backup-import imports binary-store; this stays a lazy boundary hook.
async function readBinaryForExport(id: string): Promise<Blob> {
  const { readDocumentSourceBlob } = await import('../documents/document-service');
  return readDocumentSourceBlob(id)
}
