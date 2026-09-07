import type { ProviderCapabilities, ResolvedSystemMessagePolicy } from '../api/provider-capabilities'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../api/provider-capabilities'
import type { ChatThreadRef } from '../branches/branch-types'
import { buildContextMessages } from '../api/deepseek'
import type { Message, StableId } from '../engine/types'
import { newStableId } from '../engine/types'
import { BUILTIN_CONVERSATION_MODES } from './prompt-registry'
import { getPromptPreferences } from './prompt-preferences'
import { listPromptRecordsByKind } from './prompt-store'
import { capturePromptSnapshot, resolvePromptDefinition } from './prompt-resolution'
import { appendPromptTransition } from './prompt-timeline'
import { compileConversationLogicalContext, type LogicalPromptContext } from './prompt-compiler'
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

function sameSnapshot(a: PromptSnapshot, b: PromptSnapshot): boolean {
  return a.profileId === b.profileId
    && a.kind === b.kind
    && a.name === b.name
    && a.content === b.content
    && a.revision === b.revision
    && a.source === b.source
}

/** Resolve the current conversation mode from the canonical v2 prompt registry. */
export async function resolveCurrentConversationMode(now = Date.now()): Promise<PromptSnapshot> {
  const preferences = await getPromptPreferences()
  const custom = await listPromptRecordsByKind('conversation-mode')
  const resolved = resolvePromptDefinition(
    preferences.defaultConversationModeId,
    [...BUILTIN_CONVERSATION_MODES, ...custom],
    { expectedKind: 'conversation-mode' },
  )
  if (!resolved.definition || resolved.definition.kind !== 'conversation-mode') {
    throw new Error('当前 conversation mode 不可用')
  }
  return capturePromptSnapshot(resolved.definition, now)
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
  const now = input.now ?? Date.now()
  const currentMode = input.currentModeSnapshot ?? await resolveCurrentConversationMode(now)
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
    },
    nextLocalTransitions: added
      ? freezeTransitions(appendPromptTransition(input.localTransitions, added))
      : freezeTransitions(input.localTransitions),
  }
}
