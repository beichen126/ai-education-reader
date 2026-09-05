import { type Message, type StableId } from './types'
import type { ChatThreadRef } from '../branches/branch-types'
import { buildEffectiveConversationPath } from '../branches/branch-path'
import { getBranch, listBranchesByConversation, saveBranch } from '../branches/branch-store'
import { acceptBranchUserMessage } from '../branches/branch-service'
import { getConversation } from '../storage/storage'
import { getSessionsStatus } from './sessions-store'
import { generationRegistry, genRootKey, genBranchKey } from './generation-registry'
export { genRootKey, genBranchKey } from './generation-registry'

/**
 * Minimal contract a generation engine needs to target ANY durable chat thread.
 * One engine, multiple thread targets (root conversation or a branch). The engine
 * never reaches for conversation-specific state directly.
 */
export interface ChatThreadAdapter {
  readonly ref: ChatThreadRef
  getEffectiveMessages(): Promise<Message[]>
  acceptUserMessage(message: Message): Promise<boolean>
  exists(): Promise<boolean>
  displayName(): string
}

/** Root conversation adapter: wraps the existing Conversation record (v1 behavior). */
export class RootThreadAdapter implements ChatThreadAdapter {
  constructor(readonly conversationId: StableId) {}
  get ref(): ChatThreadRef { return { type: 'root', conversationId: this.conversationId } }
  async getEffectiveMessages(): Promise<Message[]> { const c = await getConversation(this.conversationId); return c ? c.messages : [] }
  async acceptUserMessage(): Promise<boolean> {
    return false
  }
  async exists(): Promise<boolean> { return !!(await getConversation(this.conversationId)) }
  displayName(): string { return '主线' }
}

/** Branch adapter: wraps a ConversationBranch (inherited parent path + local messages). */
export class BranchThreadAdapter implements ChatThreadAdapter {
  constructor(readonly conversationId: StableId, readonly branchId: StableId) {}
  get ref(): ChatThreadRef { return { type: 'branch', conversationId: this.conversationId, branchId: this.branchId } }
  async getEffectiveMessages(): Promise<Message[]> {
    const conv = await getConversation(this.conversationId)
    const branches = await listBranchesByConversation(this.conversationId)
    if (!conv) return []
    return buildEffectiveConversationPath(conv, branches, this.branchId)
  }
  async acceptUserMessage(message: Message): Promise<boolean> {
    return acceptBranchUserMessage(this.branchId, message)
  }
  async exists(): Promise<boolean> { return !!(await getBranch(this.branchId)) }
  displayName(): string { return '分支' }
}

export function adapterFor(ref: ChatThreadRef): ChatThreadAdapter {
  return ref.type === 'root'
    ? new RootThreadAdapter(ref.conversationId)
    : new BranchThreadAdapter(ref.conversationId, ref.branchId)
}

/**
 * ONE active model generation globally (root chat, branch chat, or artifact).
 * Coordinates with the existing sessions status so Main / Branch / Artifact can never
 * generate simultaneously. A new generation aborts + replaces the previous one.
 */
/**
 * ONE active model generation globally, keyed by a string identity so chat threads and
 * artifacts share the same registry (Main / Branch / Artifact can never generate
 * simultaneously). This is a thin compatibility alias over the generation registry.
 */
export const globalGenerationLock: {
  get active(): { key: string; controller: AbortController; status: import('./generation-registry').GenerationStatus } | null
  tryAcquire(key: string, controller: AbortController): boolean
  release(key: string): void
  cancelAll(): void
  isBusy: boolean
} = {
  get active() { return generationRegistry.current() },
  tryAcquire(key: string, controller: AbortController): boolean { return generationRegistry.begin(key, controller, 'streaming') },
  release(key: string): void { generationRegistry.end(key) },
  cancelAll(): void { generationRegistry.cancel() },
  get isBusy(): boolean { return generationRegistry.isBusy() || getSessionsStatus() === 'sending' || getSessionsStatus() === 'streaming' },
};
/** Generation key helper: chat thread identity. */
export function threadGenKey(ref: ChatThreadRef): string { return ref.type === 'root' ? 'chat:root:' + ref.conversationId : 'chat:branch:' + ref.conversationId + ':' + ref.branchId }

/** Save a branch's assistant message. Never resurrects a deleted branch. */
export async function appendBranchAssistantMessage(branchId: StableId, message: Message): Promise<boolean> {
  const branch = await getBranch(branchId)
  if (!branch) return false
  const updated = { ...branch, updatedAt: Date.now(), messages: [...branch.messages, message] }
  await saveBranch(updated)
  return true
}

/** Effective messages THROUGH a message for a thread (artifact source contract). */
export async function effectiveMessagesThrough(ref: ChatThreadRef, throughMessageId: StableId): Promise<Message[]> {
  const conv = await getConversation(ref.conversationId)
  if (!conv) return []
  const branches = await listBranchesByConversation(ref.conversationId)
  const eff = buildEffectiveConversationPath(conv, branches, ref.type === 'branch' ? ref.branchId : undefined)
  const idx = eff.findIndex((m) => m.id === throughMessageId)
  return idx < 0 ? [] : eff.slice(0, idx + 1)
}