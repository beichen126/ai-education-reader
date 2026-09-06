import type { Conversation, StableId } from '../engine/types'
import type { MessageFocusTarget } from '../engine/sessions-store'
import { buildEffectiveMessageIds, validateBranchGraph } from '../branches/branch-path'
import type { ConversationBranch } from '../branches/branch-types'

export type MessageNavigationDecision =
  | { kind: 'ignore' }
  | { kind: 'wait' }
  | { kind: 'switch-root' }
  | { kind: 'switch-branch'; branchId: StableId }
  | { kind: 'focus' }
  | { kind: 'clear' }

export type MessageNavigationInput = {
  session: Conversation | undefined
  focusMessage: MessageFocusTarget | undefined
  branches: ConversationBranch[]
  branchReady: boolean
  activeBranchId: StableId | undefined
  targetRendered: boolean
}

/** Decide one-shot message navigation without treating a pre-load empty list as missing. */
export function resolveMessageNavigation(input: MessageNavigationInput): MessageNavigationDecision {
  const { session, focusMessage, branches, branchReady, activeBranchId, targetRendered } = input
  if (!session || !focusMessage || focusMessage.conversationId !== session.id) return { kind: 'ignore' }

  if (focusMessage.branchId) {
    if (!branchReady) return { kind: 'wait' }
    const branch = branches.find((candidate) => candidate.id === focusMessage.branchId)
    if (!branch || validateBranchGraph(session, branches).length > 0) return { kind: 'clear' }
    const effectiveIds = buildEffectiveMessageIds(session, branches, focusMessage.branchId)
    if (!effectiveIds || !effectiveIds.includes(focusMessage.messageId)) return { kind: 'clear' }
    if (activeBranchId !== focusMessage.branchId) return { kind: 'switch-branch', branchId: focusMessage.branchId }
    return targetRendered ? { kind: 'focus' } : { kind: 'wait' }
  }

  if (!session.messages.some((message) => message.id === focusMessage.messageId)) return { kind: 'clear' }
  if (activeBranchId) return { kind: 'switch-root' }
  return targetRendered ? { kind: 'focus' } : { kind: 'wait' }
}
