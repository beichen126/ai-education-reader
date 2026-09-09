import type { Attachment, Conversation } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import type { LearningDocument, DocumentNote } from '../documents/document-types'
import type { ConversationBranch } from '../branches/branch-types'
import type { CustomArtifactAction, StudyArtifact } from '../artifacts/artifact-types'
import type { PromptDefinition, PromptUserPreferences } from '../prompts/prompt-types'
import type { PdfNavigationMode } from '../engine/pdf-navigation-settings'

export type BackupSettings = { apiBaseUrl: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean; customArtifactActions?: CustomArtifactAction[]; visionCapability?: 'auto' | 'supports-image' | 'text-only'; pdfNavigationMode?: PdfNavigationMode }
/** Persisted composer-draft user data (unsent text + images). Must survive a complete backup. */
export type BackupDraft = { conversationId: string; text: string; imageIds: string[] }
export type BackupAppearance = 'system' | 'light' | 'dark'
export type BackupAttachment = { id: string; meta: Attachment; mimeType: string; data: string }
/** Original document: metadata (WITHOUT the Blob) + mimeType + base64-encoded source file. */
export type BackupDocument = { id: string; meta: Omit<LearningDocument, 'sourceBlob'>; mimeType: string; data: string }
/** Stage 4-9.3 single-document backup shape - accepted for import forever. */
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
/** V4 (post-v1): adds branch graph + branch drafts + study artifacts + active branch. */
export type BackupBranchDraft = { branchId: string; text: string; imageIds: string[] }
export type BackupActiveBranch = { conversationId: string; branchId: string }
export type BackupV4 = {
  format: 'ai-education-reader-backup'
  version: 4
  exportedAt: number
  settings: BackupSettings
  conversations: Conversation[]
  annotations: Annotation[]
  attachments: BackupAttachment[]
  documents: BackupDocument[]
  drafts: BackupDraft[]
  appearance: BackupAppearance
  branches: ConversationBranch[]
  branchDrafts: BackupBranchDraft[]
  artifacts: StudyArtifact[]
  activeBranches: BackupActiveBranch[]
}
/** V5: adds page-level notes owned by the Document Library. */
export type BackupV5 = Omit<BackupV4, 'version'> & { version: 5; documentNotes: DocumentNote[] }
/** V6: Prompt domain data and v2 prompt metadata become first-class backup data. */
export type BackupV6 = Omit<BackupV5, 'version'> & {
  version: 6
  prompts: PromptDefinition[]
  promptPreferences: PromptUserPreferences
}
export type Backup = BackupV1 | BackupV2 | BackupV3 | BackupV4 | BackupV5 | BackupV6
export const BACKUP_FORMAT = 'ai-education-reader-backup'
/** Stage 0-6 product backups used this identifier; imports must still accept it. */
export const LEGACY_BACKUP_FORMAT = 'dsh-eink-backup'
export const BACKUP_VERSION = 6
