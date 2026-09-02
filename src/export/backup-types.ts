import type { Attachment, Conversation } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'

export type BackupSettings = { apiBaseUrl: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean }
export type BackupAttachment = { id: string; meta: Attachment; mimeType: string; data: string }
export type BackupV1 = {
  format: 'dsh-eink-backup'
  version: 1
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
}
export const BACKUP_FORMAT = 'dsh-eink-backup'
export const BACKUP_VERSION = 1
