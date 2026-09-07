import { getConversation, saveConversation } from '../storage/storage'
import { getBranch, listBranchesByConversation, saveBranch } from '../branches/branch-store'
import { buildEffectiveMessageIds } from '../branches/branch-path'
import { buildEffectivePromptPath } from './effective-prompt-path'
import { getPromptTransitionIssues } from './prompt-validation'
import { appendPromptTransition } from './prompt-timeline'
import { BUILTIN_CONVERSATION_MODES } from './prompt-registry'
import { listPromptRecordsByKind } from './prompt-store'
import { capturePromptSnapshot } from './prompt-resolution'
import { tryWithConversationMutationLock } from './prompt-mode-lock'
import { generationRegistry } from '../engine/generation-registry'
import type { ConversationModePrompt, PromptDefinition, PromptSnapshot, PromptTransition } from './prompt-types'
import type { Conversation, StableId } from '../engine/types'
import type { ConversationBranch } from '../branches/branch-types'
import { newStableId } from '../engine/types'

export class PromptModeServiceError extends Error {
  readonly code: 'conversation-not-found' | 'branch-not-found' | 'branch-path-invalid' | 'mode-not-found' | 'invalid-transition' | 'generation-busy' | 'mutation-busy'
  constructor(code: PromptModeServiceError['code'], message: string) {
    super(message); this.name = 'PromptModeServiceError'; this.code = code
  }
}

export type ModeSwitchResult = {
  changed: boolean
  definition: ConversationModePrompt
  snapshot: PromptSnapshot
  transition?: PromptTransition
  conversation?: Conversation
  branch?: ConversationBranch
}

export function samePromptSnapshot(a: PromptSnapshot | undefined, b: PromptSnapshot): boolean {
  return !!a && a.profileId === b.profileId && a.kind === b.kind && a.name === b.name
    && a.content === b.content && a.revision === b.revision && a.source === b.source
}

export function promptSnapshotNeedsApply(snapshot: PromptSnapshot | undefined, definition: PromptDefinition): boolean {
  if (!snapshot || definition.kind !== 'conversation-mode') return false
  return snapshot.profileId === definition.id && !samePromptSnapshot(snapshot, capturePromptSnapshot(definition, snapshot.capturedAt))
}

export async function listConversationModeDefinitions(): Promise<ConversationModePrompt[]> {
  const custom = await listPromptRecordsByKind('conversation-mode')
  return [...BUILTIN_CONVERSATION_MODES, ...custom].filter((definition): definition is ConversationModePrompt => definition.kind === 'conversation-mode' && definition.enabled)
}

function assertTimeline(transitions: PromptTransition[], boundaryIds: readonly StableId[]): void {
  const issues = getPromptTransitionIssues(transitions, boundaryIds)
  if (issues.length > 0) throw new PromptModeServiceError('invalid-transition', issues[0].path + ': ' + issues[0].message)
}

function resolveMode(modeId: StableId, definitions: readonly ConversationModePrompt[]): ConversationModePrompt {
  const definition = definitions.find((item) => item.id === modeId)
  if (!definition) throw new PromptModeServiceError('mode-not-found', '会话模式不可用')
  return definition
}

export type SwitchConversationModeInput = {
  conversationId: StableId
  branchId?: StableId
  modeId: StableId
  now?: number
  id?: () => StableId
}

/**
 * Persist an explicit route-local mode switch. Empty root routes replace their
 * initial transition; historical routes append a boundary after the last visible
 * message. Branch-local writes stay in the branch row and never create a branch.
 */
export async function switchConversationMode(input: SwitchConversationModeInput): Promise<ModeSwitchResult> {
  const locked = await tryWithConversationMutationLock(input.conversationId, async () => {
    if (generationRegistry.isBusy()) throw new PromptModeServiceError('generation-busy', '模型正在生成，请等待本次生成结束后再切换会话模式')
    const conversation = await getConversation(input.conversationId) as Conversation | undefined
    if (!conversation) throw new PromptModeServiceError('conversation-not-found', '会话不存在')
    const branches = await listBranchesByConversation(input.conversationId)
    const branch = input.branchId ? branches.find((item) => item.id === input.branchId) : undefined
    if (input.branchId && !branch) throw new PromptModeServiceError('branch-not-found', '分支不存在')
    const effectiveIds = buildEffectiveMessageIds(conversation, branches, input.branchId)
    const effectivePath = buildEffectivePromptPath(conversation, branches, input.branchId)
    if (input.branchId && (effectiveIds === null || !effectivePath.resolved)) throw new PromptModeServiceError('branch-path-invalid', '分支路径无效，无法切换模式')
    const definition = resolveMode(input.modeId, await listConversationModeDefinitions())
    const now = input.now ?? Date.now()
    const snapshot = capturePromptSnapshot(definition, now)
    const current = effectivePath.transitions[effectivePath.transitions.length - 1]?.snapshot
    if (samePromptSnapshot(current, snapshot)) return { changed: false, definition, snapshot }
    const transition: PromptTransition = {
      id: (input.id ?? newStableId)(),
      afterMessageId: effectivePath.messageIds[effectivePath.messageIds.length - 1] ?? null,
      snapshot: { ...snapshot },
      createdAt: now,
    }

    if (!branch) {
      const next = appendPromptTransition(conversation.promptTransitions ?? [], transition)
      assertTimeline(next, conversation.messages.map((message) => message.id))
      const updated = { ...conversation, promptTransitions: next }
      await saveConversation(updated)
      return { changed: true, definition, snapshot, transition, conversation: updated }
    }

    const next = appendPromptTransition(branch.promptTransitions ?? [], transition)
    assertTimeline(next, effectiveIds ?? [])
    const updated = { ...branch, promptTransitions: next, updatedAt: now }
    await saveBranch(updated)
    return { changed: true, definition, snapshot, transition, branch: updated }
  })
  if (!locked.acquired) throw new PromptModeServiceError('mutation-busy', '会话正在发送消息，请稍后重试')
  return locked.value
}
