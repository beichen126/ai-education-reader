import type { ArtifactKind } from '../artifacts/artifact-types'
import type { StableId } from '../engine/types'

/** The four prompt domains. A definition's kind is also its request scope. */
export type PromptKind = 'conversation-mode' | 'artifact' | 'quick-follow-up' | 'protocol'

export type PromptSource = 'builtin' | 'custom' | 'experimental'

export type PromptBase = {
  id: StableId
  name: string
  description: string
  source: PromptSource
  enabled: boolean
  createdAt: number
  updatedAt: number
  revision: number
}

export type ConversationModePrompt = PromptBase & {
  kind: 'conversation-mode'
  systemPrompt: string
}

export type ArtifactPrompt = PromptBase & {
  kind: 'artifact'
  artifactKind: ArtifactKind
  userPrompt: string
  protocolId?: StableId
}

export type QuickFollowUpPrompt = PromptBase & {
  kind: 'quick-follow-up'
  label: string
  userPrompt: string
  pinned: boolean
  sortOrder: number
}

export type ProtocolDomain = 'ai-toc-transcription' | 'ai-toc-structure' | 'quiz-output' | string

export type PromptValidatorMetadata = {
  name: string
  description: string
}

export type ProtocolPrompt = PromptBase & {
  kind: 'protocol'
  domain: ProtocolDomain
  systemPrompt: string
  outputContract?: string
  validator?: PromptValidatorMetadata
  overridePolicy: 'read-only' | 'experimental'
  baseProtocolId?: StableId
}

export type PromptDefinition =
  | ConversationModePrompt
  | ArtifactPrompt
  | QuickFollowUpPrompt
  | ProtocolPrompt

export type PromptSnapshotSource = PromptSource | 'legacy'

/** Shared immutable fields captured for history; it never points back to a definition. */
export type PromptSnapshotBase = {
  profileId?: StableId
  name: string
  content: string
  revision?: number
  source: PromptSnapshotSource
  capturedAt: number
}

export type ConversationModeSnapshot = PromptSnapshotBase & {
  kind: 'conversation-mode'
}

export type ArtifactPromptSnapshot = PromptSnapshotBase & {
  kind: 'artifact'
  artifactKind: ArtifactKind
  protocolId?: StableId
}

export type QuickFollowUpSnapshot = PromptSnapshotBase & {
  kind: 'quick-follow-up'
  label: string
  pinned: boolean
  sortOrder: number
}

export type ProtocolPromptSnapshot = PromptSnapshotBase & {
  kind: 'protocol'
  protocolDomain: ProtocolDomain
  outputContract?: string
  validator?: PromptValidatorMetadata
  overridePolicy: 'read-only' | 'experimental'
  baseProtocolId?: StableId
}

/** Discriminated, domain-bound metadata used by history, compilation, and backup. */
export type PromptSnapshot =
  | ConversationModeSnapshot
  | ArtifactPromptSnapshot
  | QuickFollowUpSnapshot
  | ProtocolPromptSnapshot

export type PromptTransition = {
  id: StableId
  afterMessageId: StableId | null
  snapshot: PromptSnapshot
  createdAt: number
}

export type ArtifactPromptBundleSnapshot = {
  template?: PromptSnapshot
  userPrompt: string
  protocol?: PromptSnapshot
  resolvedAt: number
}

export type PromptScope = PromptKind

export type PromptRequestDomain =
  | 'conversation'
  | 'conversation-quick-follow-up'
  | 'artifact-note'
  | 'artifact-quiz'
  | 'artifact-summary'
  | 'artifact-study-guide'
  | 'artifact-custom'
  | 'ai-toc-transcription'
  | 'ai-toc-structure'

export type PromptScopeMatrixEntry = {
  allowed: readonly PromptScope[]
  required: readonly PromptScope[]
}

export type PromptScopeMatrix = Readonly<Record<PromptRequestDomain, PromptScopeMatrixEntry>>

export type PromptUserPreferences = {
  version: 1
  defaultConversationModeId: StableId
  hiddenBuiltinPromptIds: StableId[]
  activeProtocolOverrideByDomain: Record<string, StableId>
  sortPreference?: PromptSortPreference
}

export type PromptSortPreference = 'updatedAt-desc' | 'name-asc'
