import type { StableId, QuickFollowUpMetadata } from './types'

/** One explicit result for every root/branch send terminal state. */
export type SendOutcome =
  | { kind: 'completed'; assistantMessageId: StableId }
  | { kind: 'aborted'; assistantMessageId?: StableId }
  | { kind: 'failed'; code: string; message: string; assistantMessageId?: StableId }
  | { kind: 'rejected'; code: string; message: string }

export type SendFailure = Extract<SendOutcome, { kind: 'failed' }>

export type SendTarget = {
  conversationId: StableId
  branchId?: StableId
}

export type SendErrorState = SendFailure & SendTarget

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
