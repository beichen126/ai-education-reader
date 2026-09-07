import type { ProviderCapabilities, ResolvedSystemMessagePolicy } from '../api/provider-capabilities'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../api/provider-capabilities'
import type { ChatThreadRef } from '../branches/branch-types'
import { getBranch } from '../branches/branch-store'
import { buildContextMessages } from '../api/deepseek'
import type { Message, StableId } from '../engine/types'
import { newStableId } from '../engine/types'
import { BUILTIN_PROMPT_IDS } from './prompt-registry'
import { getPromptPreferences } from './prompt-preferences'
import { capturePromptSnapshot, listEffectivePromptDefinitions, resolvePromptDefinition, type PromptResolutionDiagnostic } from './prompt-resolution'
import { appendPromptTransition } from './prompt-timeline'
import { compileConversationLogicalContext, type LogicalPromptContext } from './prompt-compiler'
import { getPromptSnapshotIssues } from './prompt-validation'
import type { PromptSnapshot, PromptTransition } from './prompt-types'

export type CompilePolicySnapshot = {
  /** Resolved before acceptance; the stream never resolves provider policy again. */
  systemMessagePolicy: ResolvedSystemMessagePolicy
  providerCapabilities: ProviderCapabilities
}

/** The complete frozen hand-off from durable acceptance to the network stream. */
export type AcceptedSendContext = {
  threadRef: ChatThreadRef
  acceptedMessageId: StableId
  effectivePromptTimeline: PromptTransition[]
  compilePolicy: CompilePolicySnapshot
  /** Frozen logical messages include the accepted user message and the route path. */
  logical: LogicalPromptContext
  /** Send-time fallback/disabled diagnostics for Inspector and context surfaces. */
  modeResolutionDiagnostics: PromptResolutionDiagnostic[]
}

export type PreparedSendContext = {
  context: AcceptedSendContext
  /** Local transitions to write into the root conversation or current branch row. */
  nextLocalTransitions: PromptTransition[]
}

export type PrepareSendContextInput = {
  threadRef: ChatThreadRef
  messagesBeforeAcceptance: Message[]
  candidateMessages: Message[]
  effectiveTransitions: PromptTransition[]
  localTransitions: PromptTransition[]
  acceptedMessageId: StableId
  now?: number
  id?: () => StableId
  currentModeSnapshot?: PromptSnapshot
}

export class AcceptedSendContractError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AcceptedSendContractError'
  }
}

function rejectAcceptedSend(code: string, message: string): never {
  throw new AcceptedSendContractError(code, message)
}

async function validateAcceptedSendContract(input: PrepareSendContextInput): Promise<void> {
  if (!input.acceptedMessageId || typeof input.acceptedMessageId !== 'string') rejectAcceptedSend('accepted-message-missing', 'acceptedMessageId is required')
  if (!Array.isArray(input.messagesBeforeAcceptance) || !Array.isArray(input.candidateMessages)) rejectAcceptedSend('invalid-message-path', 'message paths must be arrays')

  const previousIds = input.messagesBeforeAcceptance.map((message) => message?.id)
  if (previousIds.some((id) => typeof id !== 'string' || !id)) rejectAcceptedSend('invalid-message-path', 'messagesBeforeAcceptance contains an invalid message id')
  if (new Set(previousIds).size !== previousIds.length) rejectAcceptedSend('duplicate-message-id', 'messagesBeforeAcceptance contains a duplicate message id')
  if (previousIds.includes(input.acceptedMessageId)) rejectAcceptedSend('accepted-message-already-exists', 'acceptedMessageId already exists before acceptance')
  const candidateIds = input.candidateMessages.map((message) => message?.id)
  if (candidateIds.some((id) => typeof id !== 'string' || !id) || new Set(candidateIds).size !== candidateIds.length) rejectAcceptedSend('duplicate-message-id', 'candidate messages contain a duplicate or invalid message id')
  if (input.candidateMessages.length !== input.messagesBeforeAcceptance.length + 1) rejectAcceptedSend('candidate-not-extension', 'candidate messages must extend the previous path by exactly one message')
  for (let index = 0; index < previousIds.length; index++) {
    if (input.candidateMessages[index]?.id !== previousIds[index]) rejectAcceptedSend('candidate-not-extension', 'candidate messages do not extend the previous path')
  }
  const accepted = input.candidateMessages[input.candidateMessages.length - 1]
  if (!accepted || accepted.id !== input.acceptedMessageId) rejectAcceptedSend('accepted-message-missing', 'candidate path does not contain the accepted message at its end')
  if (accepted.role !== 'user') rejectAcceptedSend('accepted-message-role', 'accepted message must be a user message')

  if (input.threadRef.type === 'branch') {
    const branch = await getBranch(input.threadRef.branchId)
    if (branch && branch.conversationId !== input.threadRef.conversationId) rejectAcceptedSend('thread-owner-mismatch', 'branch does not belong to the requested conversation')
  }

  if (input.currentModeSnapshot) {
    const issues = getPromptSnapshotIssues(input.currentModeSnapshot)
    if (issues.length > 0) rejectAcceptedSend('invalid-prompt-snapshot', issues[0].path + ': ' + issues[0].message)
  }
}

function sameSnapshot(a: PromptSnapshot, b: PromptSnapshot): boolean {
  return a.profileId === b.profileId
    && a.kind === b.kind
    && a.name === b.name
    && a.content === b.content
    && a.revision === b.revision
    && a.source === b.source
}

export type ConversationModeResolution = {
  snapshot?: PromptSnapshot
  definition: import('./prompt-types').ConversationModePrompt | undefined
  diagnostics: PromptResolutionDiagnostic[]
  usedFallback: boolean
}

/** Resolve the current conversation mode from the shared effective catalog. */
export async function resolveCurrentConversationModeResult(now = Date.now()): Promise<ConversationModeResolution> {
  const preferences = await getPromptPreferences()
  // Keep all kinds in the resolver input so a requested artifact/protocol id is
  // reported as kind-mismatch rather than being misreported as merely missing.
  const catalog = await listEffectivePromptDefinitions()
  const resolved = resolvePromptDefinition(
    preferences.defaultConversationModeId,
    catalog,
    { expectedKind: 'conversation-mode', fallbackId: BUILTIN_PROMPT_IDS.conversationDefault, fallbackSource: 'builtin' },
  )
  if (!resolved.definition || resolved.definition.kind !== 'conversation-mode') {
    return { definition: undefined, diagnostics: resolved.diagnostics, usedFallback: resolved.usedFallback }
  }
  return {
    definition: resolved.definition,
    diagnostics: resolved.diagnostics,
    usedFallback: resolved.usedFallback,
    snapshot: capturePromptSnapshot(resolved.definition, now),
  }
}

/** Backward-compatible snapshot-only API for existing send callers. */
export async function resolveCurrentConversationMode(now = Date.now()): Promise<PromptSnapshot> {
  const resolved = await resolveCurrentConversationModeResult(now)
  if (!resolved.snapshot) throw new Error('当前 conversation mode 不可用：' + resolved.diagnostics.map((item) => item.code).join(', '))
  return resolved.snapshot
}

function freezeTransition(transition: PromptTransition): PromptTransition {
  return { ...transition, snapshot: { ...transition.snapshot } }
}

function freezeTransitions(transitions: readonly PromptTransition[]): PromptTransition[] {
  return transitions.map(freezeTransition)
}

/**
 * Select the mode for this send and add one transition only when the route's
 * current snapshot differs. The boundary is the last message before the new
 * user message, so the new message is generated under the selected mode.
 */
function transitionForSend(
  messagesBeforeAcceptance: readonly Message[],
  effectiveTransitions: readonly PromptTransition[],
  currentMode: PromptSnapshot,
  id: () => StableId,
  now: number,
): { effectiveTransitions: PromptTransition[]; added?: PromptTransition } {
  const current = effectiveTransitions[effectiveTransitions.length - 1]
  if (current && sameSnapshot(current.snapshot, currentMode)) {
    return { effectiveTransitions: freezeTransitions(effectiveTransitions) }
  }
  const transition: PromptTransition = {
    id: id(),
    afterMessageId: messagesBeforeAcceptance[messagesBeforeAcceptance.length - 1]?.id ?? null,
    snapshot: { ...currentMode },
    createdAt: now,
  }
  return {
    effectiveTransitions: freezeTransitions(appendPromptTransition(effectiveTransitions, transition)),
    added: transition,
  }
}

/**
 * Prepare the semantic request before acceptance. It deliberately compiles only
 * the logical request: attachment bytes are resolved later by stream preflight,
 * preserving the existing behavior that a missing attachment leaves the accepted
 * user message but creates no assistant placeholder.
 */
export async function prepareAcceptedSendContext(input: PrepareSendContextInput): Promise<PreparedSendContext> {
  await validateAcceptedSendContract(input)
  const now = input.now ?? Date.now()
  const resolution = input.currentModeSnapshot
    ? { snapshot: input.currentModeSnapshot, diagnostics: [] as PromptResolutionDiagnostic[] }
    : await resolveCurrentConversationModeResult(now)
  if (!resolution.snapshot) throw new Error('当前 conversation mode 不可用：' + resolution.diagnostics.map((item) => item.code).join(', '))
  const currentMode = resolution.snapshot
  const selected = transitionForSend(input.messagesBeforeAcceptance, input.effectiveTransitions, currentMode, input.id ?? newStableId, now)
  const providerCapabilities = { ...DEFAULT_PROVIDER_CAPABILITIES }
  const compiled = compileConversationLogicalContext({
    thread: input.threadRef,
    effectiveMessages: buildContextMessages(input.candidateMessages),
    effectiveTransitions: selected.effectiveTransitions,
    systemMessagePolicy: 'auto',
    providerCapabilities,
  })
  const added = selected.added
  return {
    context: {
      threadRef: { ...input.threadRef },
      acceptedMessageId: input.acceptedMessageId,
      effectivePromptTimeline: freezeTransitions(selected.effectiveTransitions),
      compilePolicy: { systemMessagePolicy: compiled.systemMessagePolicy, providerCapabilities },
      logical: compiled.logical,
      modeResolutionDiagnostics: [...resolution.diagnostics],
    },
    nextLocalTransitions: added
      ? freezeTransitions(appendPromptTransition(input.localTransitions, added))
      : freezeTransitions(input.localTransitions),
  }
}
