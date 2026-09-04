import type { Attachment, Conversation } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import type { LearningDocument } from '../documents/document-types'

export type BackupSettings = { apiBaseUrl: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean }
/** Persisted composer-draft user data (unsent text + images). Must survive a complete backup. */
export type BackupDraft = { conversationId: string; text: string; imageIds: string[] }
export type BackupAppearance = 'system' | 'light' | 'dark'
export type BackupAttachment = { id: string; meta: Attachment; mimeType: string; data: string }
/** Original document: metadata (WITHOUT the Blob) + mimeType + base64-encoded source file. */
export type BackupDocument = { id: string; meta: Omit<LearningDocument, 'sourceBlob'>; mimeType: string; data: string }
/** Stage 4-9.3 single-document backup shape — accepted for import forever. */
export type BackupV1 = {
  format: 'ai-education-reader-backup'
  version: 1
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
}
/** Stage 9.2A+ shape: adds a globally-owned local Document Library. */
export type BackupV2 = {
  format: 'ai-education-reader-backup'
  version: 2
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
  documents: BackupDocument[]
}
/** V3: adds persisted Draft user data + appearance ('complete backup' includes unsent). */
export type BackupV3 = {
  format: 'ai-education-reader-backup'
  version: 3
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
  documents: BackupDocument[]
  drafts: BackupDraft[]
  appearance: BackupAppearance
}
export type Backup = BackupV1 | BackupV2 | BackupV3
export const BACKUP_FORMAT = 'ai-education-reader-backup'
/** Stage 0-6 product backups used this identifier; imports must still accept it. */
export const LEGACY_BACKUP_FORMAT = 'dsh-eink-backup'
export const BACKUP_VERSION = 3