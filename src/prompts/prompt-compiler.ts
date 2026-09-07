import type { ProviderCapabilities, ResolvedSystemMessagePolicy, SystemMessagePolicy } from '../api/provider-capabilities'
import { resolveSystemMessagePolicy } from '../api/provider-capabilities'
import type { ApiChatMessage } from '../api/deepseek'
import type { ChatThreadRef } from '../branches/branch-types'
import type { Message, StableId } from '../engine/types'
import { getPromptScopeSelectionIssues, getPromptTransitionIssues } from './prompt-validation'
import {
  type LogicalPromptBinding,
  type LogicalPromptContext,
  type LogicalPromptSegment,
  projectLogicalPromptContext,
  type PromptImageResolver,
} from './prompt-compile-strategies'
import type { PromptRequestDomain, PromptSnapshot, PromptTransition } from './prompt-types'

export { type LogicalPromptBinding, type LogicalPromptContext, type LogicalPromptSegment } from './prompt-compile-strategies'
export type { PromptImageResolver } from './prompt-compile-strategies'

export class PromptCompileError extends Error {
  readonly code: string
  readonly path?: string
  constructor(code: string, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
    this.name = 'PromptCompileError'
  }
}

export type CompiledPromptRequest = {
  logical: LogicalPromptContext
  systemMessagePolicy: ResolvedSystemMessagePolicy
  messages: ApiChatMessage[]
}

export type ConversationPromptCompileInput = {
  thread: ChatThreadRef
  effectiveMessages: Message[]
  effectiveTransitions: PromptTransition[]
  systemMessagePolicy: SystemMessagePolicy
  providerCapabilities: ProviderCapabilities
}

export type ArtifactPromptCompileInput = {
  domain: 'artifact-note' | 'artifact-quiz' | 'artifact-summary' | 'artifact-study-guide' | 'artifact-custom'
  sourceMessages: Message[]
  artifactPrompt: PromptSnapshot
  protocolPrompt?: PromptSnapshot
  systemMessagePolicy: SystemMessagePolicy
  providerCapabilities: ProviderCapabilities
}

export type ProtocolPromptCompileInput = {
  domain: 'ai-toc-transcription' | 'ai-toc-structure'
  inputMessages: Message[]
  protocolPrompt: PromptSnapshot
  systemMessagePolicy: SystemMessagePolicy
  providerCapabilities: ProviderCapabilities
}

function fail(code: string, message: string, path?: string): never {
  throw new PromptCompileError(code, message, path)
}

function ensureUniqueMessageIds(messages: readonly Message[]): void {
  const ids = new Set<StableId>()
  messages.forEach((message, index) => {
    if (!message || typeof message.id !== 'string' || !message.id) fail('invalid-message', 'message id is required', 'messages[' + index + '].id')
    if (ids.has(message.id)) fail('duplicate-message-id', 'message id is duplicated: ' + message.id, 'messages[' + index + '].id')
    ids.add(message.id)
  })
}

function ensureConversationTransitions(messages: readonly Message[], transitions: readonly PromptTransition[]): void {
  ensureUniqueMessageIds(messages)
  const issues = getPromptTransitionIssues(transitions, messages.map((message) => message.id))
  if (issues.length > 0) fail('invalid-prompt-timeline', issues[0].message, issues[0].path)
  const boundaries = new Set<string | null>()
  for (const transition of transitions) {
    if (transition.snapshot.kind !== 'conversation-mode') fail('scope-not-allowed', 'conversation timeline only accepts conversation-mode snapshots')
    if (boundaries.has(transition.afterMessageId)) fail('duplicate-transition-boundary', 'only one prompt transition may own a message boundary', 'promptTransitions')
    boundaries.add(transition.afterMessageId)
  }
}

function buildSegments(messages: readonly Message[], transitions: readonly PromptTransition[]): LogicalPromptSegment[] {
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  return transitions.map((transition, index) => {
    const start = transition.afterMessageId === null ? 0 : (positions.get(transition.afterMessageId) ?? -1) + 1
    const next = transitions[index + 1]
    const end = next === undefined ? messages.length : (next.afterMessageId === null ? 0 : (positions.get(next.afterMessageId) ?? -1) + 1)
    return {
      transitionId: transition.id,
      afterMessageId: transition.afterMessageId,
      snapshot: { ...transition.snapshot },
      messageIds: messages.slice(start, end).map((message) => message.id),
    }
  })
}

function conversationLogical(input: ConversationPromptCompileInput): LogicalPromptContext {
  const messages = input.effectiveMessages.map((message) => ({ ...message, images: [...message.images] }))
  const transitions = input.effectiveTransitions.map((transition) => ({ ...transition, snapshot: { ...transition.snapshot } }))
  ensureConversationTransitions(messages, transitions)
  return {
    domain: 'conversation',
    thread: { ...input.thread },
    messages,
    transitions,
    segments: buildSegments(messages, transitions),
    bindings: [],
  }
}

function assertScope(domain: PromptRequestDomain, snapshots: readonly PromptSnapshot[]): void {
  const issues = getPromptScopeSelectionIssues(domain, snapshots.map((snapshot) => snapshot.kind))
  if (issues.length > 0) fail('scope-matrix-rejected', issues[0].message, issues[0].scope)
}

function assertSnapshot(snapshot: PromptSnapshot, expectedKind: PromptSnapshot['kind'], path: string): void {
  if (snapshot.kind !== expectedKind) fail('scope-not-allowed', 'expected ' + expectedKind + ' snapshot', path + '.kind')
  if (typeof snapshot.content !== 'string') fail('invalid-snapshot', 'snapshot content must be a string', path + '.content')
}

function artifactLogical(input: ArtifactPromptCompileInput): LogicalPromptContext {
  assertSnapshot(input.artifactPrompt, 'artifact', 'artifactPrompt')
  if (input.protocolPrompt) assertSnapshot(input.protocolPrompt, 'protocol', 'protocolPrompt')
  const snapshots = [input.artifactPrompt, ...(input.protocolPrompt ? [input.protocolPrompt] : [])]
  assertScope(input.domain, snapshots)
  const bindings: LogicalPromptBinding[] = [
    ...(input.protocolPrompt ? [{ role: 'system' as const, placement: 'before-messages' as const, snapshot: { ...input.protocolPrompt } }] : []),
    { role: 'user', placement: 'after-messages', snapshot: { ...input.artifactPrompt } },
  ]
  return {
    domain: input.domain,
    messages: input.sourceMessages.map((message) => ({ ...message, images: [...message.images] })),
    transitions: [],
    segments: [],
    bindings,
  }
}

function protocolLogical(input: ProtocolPromptCompileInput): LogicalPromptContext {
  assertSnapshot(input.protocolPrompt, 'protocol', 'protocolPrompt')
  // PromptSnapshot intentionally carries only the content needed for historical
  // explanation. The request domain is explicit at this boundary; do not invent
  // a provider/protocol domain field that is absent from the snapshot contract.
  assertScope(input.domain, [input.protocolPrompt])
  return {
    domain: input.domain,
    messages: input.inputMessages.map((message) => ({ ...message, images: [...message.images] })),
    transitions: [],
    segments: [],
    bindings: [{ role: 'system', placement: 'before-messages', snapshot: { ...input.protocolPrompt } }],
  }
}

function resolverOrThrow(requested: SystemMessagePolicy, capabilities: ProviderCapabilities): ResolvedSystemMessagePolicy {
  return resolveSystemMessagePolicy(requested, capabilities)
}

export async function compileConversationRequest(
  input: ConversationPromptCompileInput,
  options: { toDataUrl?: PromptImageResolver } = {},
): Promise<CompiledPromptRequest> {
  const logical = conversationLogical(input)
  const systemMessagePolicy = resolverOrThrow(input.systemMessagePolicy, input.providerCapabilities)
  const messages = await projectLogicalPromptContext(logical, systemMessagePolicy, options.toDataUrl)
  return { logical, systemMessagePolicy, messages }
}

export async function compileArtifactRequest(
  input: ArtifactPromptCompileInput,
  options: { toDataUrl?: PromptImageResolver } = {},
): Promise<CompiledPromptRequest> {
  const logical = artifactLogical(input)
  const systemMessagePolicy = resolverOrThrow(input.systemMessagePolicy, input.providerCapabilities)
  const messages = await projectLogicalPromptContext(logical, systemMessagePolicy, options.toDataUrl)
  return { logical, systemMessagePolicy, messages }
}

export async function compileProtocolRequest(
  input: ProtocolPromptCompileInput,
  options: { toDataUrl?: PromptImageResolver } = {},
): Promise<CompiledPromptRequest> {
  const logical = protocolLogical(input)
  const systemMessagePolicy = resolverOrThrow(input.systemMessagePolicy, input.providerCapabilities)
  const messages = await projectLogicalPromptContext(logical, systemMessagePolicy, options.toDataUrl)
  return { logical, systemMessagePolicy, messages }
}
