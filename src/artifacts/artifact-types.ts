import type { MessageRole, StableId } from '../engine/types'

/** The kind of study output an Artifact represents. */
export type ArtifactKind = 'note' | 'quiz' | 'summary' | 'study-guide' | 'custom'

/** Lifecycle of an Artifact. */
export type ArtifactStatus = 'draft' | 'generating' | 'ready' | 'error'

/** A single, truthful provenance citation (only derivable from real attachment/source metadata). */
export type SourceCitation = {
  /** Source of the citation - never fabricated. */
  origin: 'pdf-page' | 'document' | 'image' | 'conversation'
  fileName?: string
  documentId?: string
  pageNumber?: number
  pages?: [number, number]
  title?: string
  chapterTitle?: string
}

/**
 * Immutable user-data snapshot frozen at the selected source point. An Artifact stays
 * readable even if the original conversation is later deleted. It never duplicates
 * whole PDF/image binaries - only role/text + attachment provenance metadata.
 */
export type ArtifactSourceSnapshot = {
  conversationId: StableId
  branchId?: StableId
  throughMessageId: StableId
  /** Unix ms when the snapshot was frozen. */
  createdAt: number
  /** Frozen messages (roles + text + image refs). No binaries, no later messages. */
  messages: { role: MessageRole; text: string; imageIds: StableId[] }[]
  /** Provenance citations derived from the attachments referenced by the frozen messages. */
  provenance: SourceCitation[]
  /** Human-readable provenance summary line. */
  sourceLabel: string
  /** True when the source conversation no longer exists (artifact still readable). */
  sourceDeleted: boolean
}

/** Live source pointer (for regeneration) plus the immutable frozen snapshot. */
export type ArtifactSource = {
  conversationId: StableId
  branchId?: StableId
  throughMessageId: StableId
  snapshot: ArtifactSourceSnapshot
}

/** A structured quiz question. All answer indexes are validated before persistence. */
export type QuizQuestion =
  | {
      id: StableId
      type: 'single-choice'
      question: string
      options: string[]
      answer: number
      explanation?: string
      source?: SourceCitation
    }
  | {
      id: StableId
      type: 'multiple-choice'
      question: string
      options: string[]
      answers: number[]
      explanation?: string
      source?: SourceCitation
    }
  | {
      id: StableId
      type: 'true-false'
      question: string
      answer: boolean
      explanation?: string
      source?: SourceCitation
    }
  | {
      id: StableId
      type: 'short-answer'
      question: string
      answer: string
      explanation?: string
      source?: SourceCitation
    }

export type QuizDocument = { questions: QuizQuestion[] }

/**
 * A user-owned study artifact (a 'special branch'). Distinct from a ChatBranch:
 *  - ChatBranch = another conversational future.
 *  - StudyArtifact = a reusable learning output derived from the past.
 * Not an ordinary assistant bubble; not stored as a fake Chat message.
 */
export type StudyArtifact = {
  id: StableId
  kind: ArtifactKind
  title: string
  source: ArtifactSource
  presetId?: string
  /** The ACTUAL prompt used for generation - stored so output is reproducible/auditable. */
  prompt: string
  createdAt: number
  updatedAt: number
  status: ArtifactStatus
  content?: string
  quiz?: QuizDocument
  error?: string
  /** The original model result, distinguishable from user-edited content (revision safety). */
  generatedContent?: string
}

/** Prompt preset registry entry. Default prompts live here, never scattered through JSX. */
export type TransformationPreset = {
  id: string
  kind: ArtifactKind
  label: string
  description: string
  defaultPrompt: string
}
