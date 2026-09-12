import type { StableId } from '../engine/types'

/**
 * StudyCard — 学习卡片 (v2.2.0 §1.1 / §7.1).
 *
 * A card freezes the body of ONE completed assistant reply. It is NOT a StudyArtifact:
 *   - StudyArtifact is generated (prompt-bound, can be generating/error, retryable);
 *   - StudyCard is collected (message-bound, ready the moment it is saved);
 * they can be shown in the same learning centre, but they must not share a persistence
 * shape. Nothing here fabricates a prompt or a status to pass the artifact validator.
 */

export const STUDY_CARD_SCHEMA_VERSION = 1

export type StudyCardTitleMode = 'auto' | 'custom'
export type StudyCardDocumentRelation = 'turn' | 'prior-context'

export type StudyCardDocumentRef = {
  /** Missing only for genuinely legacy attachments that never had a document id. */
  documentId?: string
  /** Always present so a deleted document can still be explained. */
  fileNameSnapshot: string
  /** 1-based, unique, ascending. */
  pageNumbers: number[]
  relation: StudyCardDocumentRelation
  chapterTitleSnapshot?: string
}

export type StudyCardSource = {
  conversationId: StableId
  branchId?: StableId
  userMessageId?: StableId
  assistantMessageId: StableId
  conversationTitleSnapshot: string
  capturedAt: number
}

export type StudyCard = {
  schemaVersion: typeof STUDY_CARD_SCHEMA_VERSION
  id: StableId
  title: string
  titleMode: StudyCardTitleMode
  /** Monotonic per source conversation; deleted ordinals are never reused. */
  autoTitleOrdinal: number
  bodyMarkdown: string
  source: StudyCardSource
  documentRefs: StudyCardDocumentRef[]
  /** Derived from the refs that carry a documentId; backs the multiEntry index. */
  documentIds: string[]
  createdAt: number
  updatedAt: number
  lastOpenedAt?: number
}

/** Derived index row so "cards about this page" never scans every card (§10.4). */
export type StudyCardPageRef = {
  id: string
  documentId: string
  pageNumber: number
  cardId: string
}

export type StudyCardListSort = 'created-desc' | 'created-asc' | 'updated-desc' | 'last-opened-desc' | 'random'

/** Which PDF source the library is filtered by. Same-named documents are never merged. */
export type StudyCardFilterKey =
  | { kind: 'all' }
  | { kind: 'no-pdf' }
  | { kind: 'document'; documentId: string }
  | { kind: 'unlocated' }

export type StudyCardPreferences = {
  sort?: StudyCardListSort
  /** Last PDF filter; null/undefined means 全部来源. */
  documentFilter?: StudyCardFilterKey | null
}

export const MAX_STUDY_CARD_TITLE_LENGTH = 80
/** Matches the practical assistant-message ceiling used by the composer/stream path. */
export const MAX_STUDY_CARD_BODY_LENGTH = 200000
export const MAX_STUDY_CARD_DOCUMENT_REFS = 64
export const MAX_STUDY_CARD_PAGES_PER_REF = 2000

export function studyCardPageRefId(documentId: string, pageNumber: number, cardId: string): string {
  return documentId + ':' + pageNumber + ':' + cardId
}

/** 1-based unique ascending page numbers, bounded to the validated limit. */
export function normalizeStudyCardPages(pages: readonly number[]): number[] {
  const unique = new Set<number>()
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1) continue
    unique.add(page)
  }
  return [...unique].sort((a, b) => a - b)
}
