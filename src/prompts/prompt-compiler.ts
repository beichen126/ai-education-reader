import type { ProviderCapabilities, ResolvedSystemMessagePolicy, SystemMessagePolicy } from '../api/provider-capabilities'
import { resolveSystemMessagePolicy } from '../api/provider-capabilities'
import type { ApiChatMessage } from '../api/deepseek'
import type { ChatThreadRef } from '../branches/branch-types'
import type { Message, StableId } from '../engine/types'
import { getPromptScopeSelectionIssues, getPromptSnapshotIssues, getPromptTransitionIssues } from './prompt-validation'
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

function assertSnapshot<K extends PromptSnapshot['kind']>(snapshot: PromptSnapshot, expectedKind: K, path: string): asserts snapshot is Extract<PromptSnapshot, { kind: K }> {
  const issues = getPromptSnapshotIssues(snapshot)
  if (issues.length > 0) fail('invalid-snapshot', issues[0].message, path + (issues[0].path ? '.' + issues[0].path : ''))
  if (snapshot.kind !== expectedKind) fail('scope-not-allowed', 'expected ' + expectedKind + ' snapshot', path + '.kind')
}

function expectedArtifactKind(domain: ArtifactPromptCompileInput['domain']): string {
  return domain.slice('artifact-'.length)
}

function artifactLogical(input: ArtifactPromptCompileInput): LogicalPromptContext {
  assertSnapshot<'artifact'>(input.artifactPrompt, 'artifact', 'artifactPrompt')
  const protocolPrompt = input.protocolPrompt
  if (protocolPrompt) assertSnapshot<'protocol'>(protocolPrompt, 'protocol', 'protocolPrompt')
  if (protocolPrompt && protocolPrompt.kind !== 'protocol') fail('scope-not-allowed', 'expected protocol snapshot', 'protocolPrompt.kind')
  const protocolSnapshot = protocolPrompt as Extract<PromptSnapshot, { kind: 'protocol' }> | undefined
  if (input.artifactPrompt.artifactKind !== expectedArtifactKind(input.domain)) {
    fail('artifact-domain-mismatch', 'artifact snapshot kind does not match request domain', 'artifactPrompt.artifactKind')
  }
  if (input.artifactPrompt.protocolId && protocolSnapshot && input.artifactPrompt.protocolId !== protocolSnapshot.profileId) {
    fail('protocol-binding-mismatch', 'artifact snapshot protocolId does not match protocol snapshot', 'artifactPrompt.protocolId')
  }
  if (input.domain === 'artifact-quiz') {
    if (!protocolSnapshot || protocolSnapshot.protocolDomain !== 'quiz-output') {
      fail('protocol-domain-mismatch', 'Quiz artifacts require the quiz-output protocol domain', 'protocolPrompt.protocolDomain')
    }
  } else if (protocolSnapshot?.protocolDomain === 'quiz-output') {
    fail('protocol-domain-mismatch', 'quiz-output protocol may only be used for Quiz artifacts', 'protocolPrompt.protocolDomain')
  }
  const snapshots = [input.artifactPrompt, ...(protocolSnapshot ? [protocolSnapshot] : [])]
  assertScope(input.domain, snapshots)
  const bindings: LogicalPromptBinding[] = [
    ...(protocolSnapshot ? [{ role: 'system' as const, placement: 'before-messages' as const, snapshot: { ...protocolSnapshot } }] : []),
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
  assertSnapshot<'protocol'>(input.protocolPrompt, 'protocol', 'protocolPrompt')
  if (input.protocolPrompt.kind !== 'protocol') fail('scope-not-allowed', 'expected protocol snapshot', 'protocolPrompt.kind')
  const protocolPrompt = input.protocolPrompt as Extract<PromptSnapshot, { kind: 'protocol' }>
  if (protocolPrompt.protocolDomain !== input.domain) {
    fail('protocol-domain-mismatch', 'protocol snapshot domain does not match request domain', 'protocolPrompt.protocolDomain')
  }
  assertScope(input.domain, [protocolPrompt])
  return {
    domain: input.domain,
    messages: input.inputMessages.map((message) => ({ ...message, images: [...message.images] })),
    transitions: [],
    segments: [],
    bindings: [{ role: 'system', placement: 'before-messages', snapshot: { ...protocolPrompt } }],
  }
}

function resolverOrThrow(requested: SystemMessagePolicy, capabilities: ProviderCapabilities): ResolvedSystemMessagePolicy {
  return resolveSystemMessagePolicy(requested, capabilities)
}

/**
 * Validate and materialize the provider-neutral conversation context without
 * touching attachment bytes. Send acceptance uses this before its durable
 * transaction so a malformed timeline can never accept a user message.
 */
export function compileConversationLogicalContext(
  input: ConversationPromptCompileInput,
): { logical: LogicalPromptContext; systemMessagePolicy: ResolvedSystemMessagePolicy } {
  const logical = conversationLogical(input)
  const systemMessagePolicy = resolverOrThrow(input.systemMessagePolicy, input.providerCapabilities)
  return { logical, systemMessagePolicy }
}

export async function compileConversationRequest(
  input: ConversationPromptCompileInput,
  options: { toDataUrl?: PromptImageResolver } = {},
): Promise<CompiledPromptRequest> {
  const { logical, systemMessagePolicy } = compileConversationLogicalContext(input)
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
