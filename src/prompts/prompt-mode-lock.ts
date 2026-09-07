const locks = new Set<string>()

/** A mode transition read/modify/write must exclude concurrent send acceptance. */
export function isPromptModeLocked(conversationId: string): boolean { return locks.has(conversationId) }

export async function withPromptModeLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  if (locks.has(conversationId)) throw new Error('正在应用会话模式，请稍后重试')
  locks.add(conversationId)
  try { return await work() } finally { locks.delete(conversationId) }
}
