import { newStableId, type DraftDisposition, type Message, type QuickFollowUpMetadata, type StableId } from './types'
import { getSettingsSnapshot } from './settings-store'
import { runThreadReply, type ReplyThread } from './stream-reply'
import { generationRegistry, genBranchKey } from './generation-registry'
import { getConversation } from '../storage/storage'
import { getBranch, saveBranch, listBranchesByConversation } from '../branches/branch-store'
import { acceptBranchUserMessage } from '../branches/branch-service'
import { buildEffectiveConversationPath } from '../branches/branch-path'
import { attachPdfContexts } from '../pdf/pdf-message-context'
import { buildEffectivePromptPath } from '../prompts/effective-prompt-path'
import { prepareAcceptedSendContext } from '../prompts/prompt-send'
import { tryWithConversationMutationLock } from '../prompts/prompt-mode-lock'

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
  constructor(readonly conversationId: StableId, readonly branchId: StableId) { this.genKey = genBranchKey(conversationId, branchId) }
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
export type BranchReplyOptions = {
  quickFollowUp?: QuickFollowUpMetadata
  draftDisposition?: DraftDisposition
}

export async function runBranchReply(conversationId: StableId, branchId: StableId, content: string, imageIds: StableId[] = [], options: BranchReplyOptions = {}): Promise<boolean> {
  const locked = await tryWithConversationMutationLock(conversationId, async () => {
    const branch = await getBranch(branchId)
    if (!branch) return false
    const settings = getSettingsSnapshot()
    if (!settings.apiKey) return false
    const controller = new AbortController()
    const key = genBranchKey(conversationId, branchId)
    const lease = generationRegistry.acquire(key, controller, 'sending')
    if (!lease) return false
    try {
      const now = Date.now()
      const msg = await attachPdfContexts({ id: newStableId(), role: 'user', content, images: imageIds, createdAt: now, updatedAt: now, ...(options.quickFollowUp ? { quickFollowUp: options.quickFollowUp } : {}) }, imageIds, now)
      const conversation = await getConversation(conversationId)
      const branches = await listBranchesByConversation(conversationId)
      if (!conversation) return false
    const effectiveMessagesBefore = buildEffectiveConversationPath(conversation, branches, branchId)
    const effectivePromptPath = buildEffectivePromptPath(conversation, branches, branchId)
    if (!effectivePromptPath.resolved) return false
    const prepared = await prepareAcceptedSendContext({
      threadRef: { type: 'branch', conversationId, branchId },
      messagesBeforeAcceptance: effectiveMessagesBefore,
      candidateMessages: [...effectiveMessagesBefore, msg],
      effectiveTransitions: effectivePromptPath.transitions,
      localTransitions: branch.promptTransitions ?? [],
      acceptedMessageId: msg.id,
    })
    if (!(await acceptBranchUserMessage(branchId, msg, prepared.nextLocalTransitions, options.draftDisposition ?? 'clear'))) return false
    const thread = new BranchReplyThread(conversationId, branchId)
      await runThreadReply(thread, settings, controller, undefined, prepared.context, lease)
    return true
    } finally {
      lease.release()
    }
  })
  return locked.acquired ? locked.value : false
}
