import { getConversation, saveConversation } from '../storage/storage'
import { getPromptTransitionIssues } from './prompt-validation'
import { appendPromptTransition } from './prompt-timeline'
import type { Conversation, StableId } from '../engine/types'
import type { PromptTransition } from './prompt-types'

export class PromptTransitionServiceError extends Error {
  readonly code: 'conversation-not-found' | 'invalid-transition'
  constructor(code: PromptTransitionServiceError['code'], message: string) {
    super(message)
    this.name = 'PromptTransitionServiceError'
    this.code = code
  }
}

function assertRootTimeline(conversation: Conversation, transitions: PromptTransition[]): void {
  const issues = getPromptTransitionIssues(transitions, conversation.messages.map((message) => message.id))
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
  assertRootTimeline(conversation, nextTransitions)
  const updated: Conversation = { ...conversation, promptTransitions: nextTransitions }
  await saveConversation(updated)
  return updated
}

