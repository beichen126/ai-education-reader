import type { Attachment, Conversation } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'

export type BackupSettings = { apiBaseUrl: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean }
export type BackupAttachment = { id: string; meta: Attachment; mimeType: string; data: string }
export type BackupV1 = {
  format: 'ai-education-reader-backup'
  version: 1
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
}
export const BACKUP_FORMAT = 'ai-education-reader-backup'
/** Stage 0-6 product backups used this identifier; imports must still accept it. */
export const LEGACY_BACKUP_FORMAT = 'dsh-eink-backup'
export const BACKUP_VERSION = 1