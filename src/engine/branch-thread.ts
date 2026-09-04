import { newStableId, type Message, type StableId } from './types'
import { getSettingsSnapshot } from './settings-store'
import { runThreadReply, type ReplyThread } from './stream-reply'
import { globalGenerationLock, threadGenKey } from './chat-generation-service'
import { getConversation } from '../storage/storage'
import { getBranch, saveBranch, listBranchesByConversation } from '../branches/branch-store'
import { acceptBranchUserMessage } from '../branches/branch-service'
import { buildEffectiveConversationPath } from '../branches/branch-path'

// Per-branch ordered durable-write queue (mirrors the root writeChains). A stale checkpoint
// can never overwrite a newer revision of a branch record.
const branchWriteChains = new Map<StableId, Promise<void>>()
function enqueueBranchWrite(branchId: StableId, write: () => Promise<void>): Promise<void> {
  const prev = branchWriteChains.get(branchId) || Promise.resolve()
  const next = prev.then(() => write()).catch((e) => { console.error('[branch-stream] durable write failed', branchId, e) })
  branchWriteChains.set(branchId, next)
  return next
}
function drainBranchWrites(branchId: StableId): Promise<void> { return branchWriteChains.get(branchId) || Promise.resolve() }

/**
 * Branch target for the shared streaming engine. The assistant placeholder + streaming
 * deltas are persisted to the branch record through the ordered write queue (never
 * duplicated into the root conversation). The engine's deletion guard prevents a deleted
 * branch from being resurrected by a late write.
 */
export class BranchReplyThread implements ReplyThread {
  readonly genKey: string
  private assistantId: StableId = ''
  constructor(readonly conversationId: StableId, readonly branchId: StableId) { this.genKey = threadGenKey({ type: 'branch', conversationId, branchId }) }
  async getContextMessages(): Promise<Message[]> {
    const conv = await getConversation(this.conversationId)
    const branches = await listBranchesByConversation(this.conversationId)
    if (!conv) return []
    return buildEffectiveConversationPath(conv, branches, this.branchId)
  }
  createAssistantPlaceholder(assistantId: StableId, now: number): void {
    this.assistantId = assistantId
    const placeholder: Message = { id: assistantId, role: 'assistant', content: '', images: [], createdAt: now, updatedAt: now }
    this.mutate((b) => ({ ...b, updatedAt: now, messages: [...b.messages, placeholder] }))
  }
  updateAssistantContent(content: string): void {
    this.mutate((b) => {
      const last = b.messages[b.messages.length - 1]
      if (!last || last.id !== this.assistantId) return b
      if (last.content === content) return b
      return { ...b, updatedAt: Date.now(), messages: [...b.messages.slice(0, -1), { ...last, content, updatedAt: Date.now() }] }
    })
  }
  persistCheckpoint(content: string): void {
    this.mutate((b) => {
      const last = b.messages[b.messages.length - 1]
      if (!last || last.id !== this.assistantId || last.content === content) return b
      return { ...b, updatedAt: Date.now(), messages: [...b.messages.slice(0, -1), { ...last, content, updatedAt: Date.now() }] }
    })
  }
  async persistFinal(): Promise<void> { await drainBranchWrites(this.branchId) }
  async drainWrites(): Promise<void> { await drainBranchWrites(this.branchId) }
  async exists(): Promise<boolean> { return !!(await getBranch(this.branchId)) }
  setStreaming(): void { /* branch UI reads IDB on switch; no idle bus */ }
  setIdle(): void { /* no-op */ }
  setError(_message: string): void { /* surfaced by the branch record status via caller UI */ }
  /** Queue a read-modify-write on the branch record; a deleted branch is never written. */
  private mutate(updater: (b: NonNullable<Awaited<ReturnType<typeof getBranch>>>) => NonNullable<Awaited<ReturnType<typeof getBranch>>>): void {
    void enqueueBranchWrite(this.branchId, async () => {
      const b = await getBranch(this.branchId)
      if (!b) return
      const next = updater(b)
      await saveBranch(next)
    })
  }
}

/**
 * Send a user message into a branch and run the shared reply engine. Atomic user-message
 * acceptance happens first; only then does the stream start. One global generation lock.
 * Returns true when the branch accepted + streamed (or is streaming).
 */
export async function runBranchReply(conversationId: StableId, branchId: StableId, content: string, imageIds: StableId[] = []): Promise<boolean> {
  const branch = await getBranch(branchId)
  if (!branch) return false
  const settings = getSettingsSnapshot()
  if (!settings.apiKey) return false
  if (globalGenerationLock.isBusy) return false
  const msg: Message = { id: newStableId(), role: 'user', content, images: imageIds, createdAt: Date.now(), updatedAt: Date.now() }
  if (!(await acceptBranchUserMessage(branchId, msg))) return false
  const thread = new BranchReplyThread(conversationId, branchId)
  const controller = new AbortController()
  const lockKey = threadGenKey({ type: 'branch', conversationId, branchId })
  if (!globalGenerationLock.tryAcquire(lockKey, controller)) return false
  try {
    await runThreadReply(thread, settings, controller)
    return true
  } finally {
    globalGenerationLock.release(lockKey)
  }
}

