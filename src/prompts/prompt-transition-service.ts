import { getConversation, saveConversation } from '../storage/storage'
import { getBranch, listBranchesByConversation, saveBranch } from '../branches/branch-store'
import { buildEffectiveMessageIds } from '../branches/branch-path'
import { getPromptTransitionIssues } from './prompt-validation'
import { appendPromptTransition } from './prompt-timeline'
import type { Conversation, StableId } from '../engine/types'
import type { PromptTransition } from './prompt-types'

export class PromptTransitionServiceError extends Error {
  readonly code: 'conversation-not-found' | 'branch-not-found' | 'branch-path-invalid' | 'invalid-transition'
  constructor(code: PromptTransitionServiceError['code'], message: string) {
    super(message)
    this.name = 'PromptTransitionServiceError'
    this.code = code
  }
}

function assertTimeline(transitions: PromptTransition[], boundaryIds: readonly StableId[]): void {
  const issues = getPromptTransitionIssues(transitions, boundaryIds)
  if (issues.length > 0) {
    const issue = issues[0]
    throw new PromptTransitionServiceError('invalid-transition', issue.path + ': ' + issue.message)
  }
}

/** Append a root-route transition and persist the updated conversation row. */
export async function appendConversationPromptTransition(
  conversationId: StableId,
  transition: PromptTransition,
): Promise<Conversation> {
  const conversation = await getConversation(conversationId) as Conversation | undefined
  if (!conversation) throw new PromptTransitionServiceError('conversation-not-found', '会话不存在')
  const nextTransitions = appendPromptTransition(conversation.promptTransitions ?? [], transition)
  assertTimeline(nextTransitions, conversation.messages.map((message) => message.id))
  const updated: Conversation = { ...conversation, promptTransitions: nextTransitions }
  await saveConversation(updated)
  return updated
}

/** Append a branch-local transition after validating it against that branch's effective path. */
export async function appendBranchPromptTransition(
  branchId: StableId,
  transition: PromptTransition,
): Promise<NonNullable<Awaited<ReturnType<typeof getBranch>>>> {
  const branch = await getBranch(branchId)
  if (!branch) throw new PromptTransitionServiceError('branch-not-found', '分支不存在')
  const conversation = await getConversation(branch.conversationId) as Conversation | undefined
  if (!conversation) throw new PromptTransitionServiceError('conversation-not-found', '会话不存在')
  const branches = await listBranchesByConversation(branch.conversationId)
  const effectiveIds = buildEffectiveMessageIds(conversation, branches, branch.id)
  if (effectiveIds === null) throw new PromptTransitionServiceError('branch-path-invalid', '分支路径无效，无法写入提示词 transition')
  const nextTransitions = appendPromptTransition(branch.promptTransitions ?? [], transition)
  assertTimeline(nextTransitions, effectiveIds)
  const updated = { ...branch, promptTransitions: nextTransitions }
  await saveBranch(updated)
  return updated
}
