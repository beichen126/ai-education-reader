const activeLocks = new Set<string>()

/**
 * The lock acquisition and the busy check are one synchronous operation. Callers
 * must use this helper rather than checking a Boolean and awaiting afterwards.
 */
export async function tryWithConversationMutationLock<T>(
  conversationId: string,
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (activeLocks.has(conversationId)) return { acquired: false }
  activeLocks.add(conversationId)
  try {
    return { acquired: true, value: await work() }
  } finally {
    activeLocks.delete(conversationId)
  }
}

/** Compatibility wrapper for non-send callers that already use the old name. */
export async function withPromptModeLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  const result = await tryWithConversationMutationLock(conversationId, work)
  if (!result.acquired) throw new Error('正在应用会话模式，请稍后重试')
  return result.value
}
