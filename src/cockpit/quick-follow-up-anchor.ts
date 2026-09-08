import { isCompletedAssistantMessage, type Message, type StableId } from '../engine/types'

/**
 * Return the only message that may own the current Quick Follow-up bar.
 * The visible timeline is already branch-materialized by the caller, so anchoring
 * is intentionally tail-only: an older completed answer must not remain actionable
 * after a later user, streaming, failed, or aborted message.
 */
export function quickFollowUpAnchor(messages: readonly Message[], activeStreamingId?: StableId): StableId | undefined {
  const tail = messages[messages.length - 1]
  if (!tail || tail.role !== 'assistant') return undefined
  return isCompletedAssistantMessage(tail, { streaming: tail.id === activeStreamingId }) ? tail.id : undefined
}
