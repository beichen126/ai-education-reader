import type { StableId, QuickFollowUpMetadata } from './types'

/** One explicit result for every root/branch send terminal state. */
export type SendOutcome =
  | { kind: 'completed'; assistantMessageId: StableId }
  | { kind: 'aborted'; assistantMessageId?: StableId }
  | { kind: 'failed'; code: string; message: string; assistantMessageId?: StableId }
  | { kind: 'rejected'; code: string; message: string }

export type SendFailure = Extract<SendOutcome, { kind: 'failed' }>

export type RejectedSend = Extract<SendOutcome, { kind: 'rejected' }>

/** The caller surface used by the single rejected-outcome presenter. */
export type SendIntent = 'composer' | 'quick-follow-up' | 'internal'

export type SendTarget = {
  conversationId: StableId
  branchId?: StableId
}

/** UI-visible error state is shared by rejected and post-acceptance failures. */
export type SendErrorState = { code: string; message: string } & SendTarget

/**
 * One policy for rejected outcomes. Ordinary blank composer submissions may stay
 * silent, while a quick-follow-up rejection is visible because it has an explicit
 * action surface. Busy is never written as an error while a real generation owns
 * the registry; all other context/storage/provider rejections are visible.
 */
export function shouldPresentRejectedSend(outcome: RejectedSend, intent: SendIntent): boolean {
  if (outcome.code === 'generation-busy') return false
  if (outcome.code === 'empty-input' && intent === 'composer') return false
  return true
}

/** Shared acceptance rule used by root and branch sends before any lease/network work. */
export function validateSendInput(
  content: string,
  imageIds: readonly StableId[],
  quickFollowUp?: QuickFollowUpMetadata,
): Extract<SendOutcome, { kind: 'rejected' }> | undefined {
  if (quickFollowUp && quickFollowUp.promptSnapshot.trim().length === 0) {
    return { kind: 'rejected', code: 'empty-input', message: '快捷追问内容不能为空。' }
  }
  if (content.trim().length === 0 && imageIds.length === 0) {
    return { kind: 'rejected', code: 'empty-input', message: '消息内容不能为空。' }
  }
  return undefined
}

export function isAcceptedSendOutcome(outcome: SendOutcome): boolean {
  return outcome.kind !== 'rejected'
}
