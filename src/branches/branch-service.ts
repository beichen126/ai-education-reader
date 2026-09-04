import { newStableId, type Conversation, type Message, type StableId } from '../engine/types'
import { getConversation } from '../storage/storage'
import { idbRunTxn } from '../storage/idb'
import { canonicalForkOwner, descendantBranchIds } from './branch-path'
import { getBranch, saveBranchAndActive, listBranchesByConversation, getActiveBranch, setActiveBranch, deleteBranches } from './branch-store'
import { branchDraftSettingKey, deleteBranchDraft, clearBranchDraftMemory } from '../engine/draft-store'
import type { ConversationBranch } from './branch-types'

export class BranchError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; this.name = 'BranchError' } }

/**
 * Create a new branch from a completed message. The fork target is the CANONICAL owner
 * of the selected message (root or an ancestor branch), so branching from an inherited
 * root message while viewing a nested branch does NOT inherit irrelevant descendants.
 * The new branch starts empty, its parent path stays visible, and it becomes active.
 */
export async function createBranchFromMessage(conversationId: StableId, forkMessageId: StableId): Promise<ConversationBranch> {
  const conversation = await getConversation(conversationId)
  if (!conversation) throw new BranchError('conversation-not-found', '会话不存在')
  const branches = await listBranchesByConversation(conversationId)
  // The fork message must exist somewhere in this conversation's graph.
  const exists = conversation.messages.some((m) => m.id === forkMessageId) || branches.some((b) => b.messages.some((m) => m.id === forkMessageId))
  if (!exists) throw new BranchError('fork-message-not-found', '分支点消息不存在')
  const ownerBranchId = canonicalForkOwner(conversation, branches, forkMessageId)
  const now = Date.now()
  const branch: ConversationBranch = {
    id: newStableId(),
    conversationId,
    parentBranchId: ownerBranchId,
    forkMessageId,
    title: '分支 ' + (branches.length + 1),
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  // ONE durable txn: branch record + active-branch setting commit together.
  await saveBranchAndActive(branch, branch.id)
  return branch
}

/** Rename a branch. Metadata only — never touches messages or ancestry. */
export async function renameBranch(branchId: StableId, title: string): Promise<ConversationBranch | undefined> {
  const branch = await getBranch(branchId)
  if (!branch) return undefined
  const clean = title.trim()
  if (!clean) return branch
  const updated: ConversationBranch = { ...branch, title: clean, updatedAt: Date.now() }
  await saveBranchAndActive(updated, await getActiveBranch(branch.conversationId))
  return updated
}

/**
 * Delete a branch + its whole subtree, never any ancestor and never Main. Cleans
 * branch drafts (memory + persisted + draft attachments) and resets the active
 * branch to root when the deleted subtree contained it.
 */
export async function deleteBranchSubtree(branchId: StableId): Promise<{ deleted: StableId[] }> {
  const branch = await getBranch(branchId)
  if (!branch) return { deleted: [] }
  const convBranches = await listBranchesByConversation(branch.conversationId)
  const toDelete = [branchId, ...descendantBranchIds(convBranches, branchId)]
  const deletedSet = new Set(toDelete)
  await deleteBranches(toDelete)
  for (const id of toDelete) { try { await deleteBranchDraft(id) } catch { /* best-effort */ } }
  // Reset active branch if it pointed into the deleted subtree.
  const active = await getActiveBranch(branch.conversationId)
  if (active && deletedSet.has(active)) await setActiveBranch(branch.conversationId, undefined)
  return { deleted: toDelete }
}

/** Active branch for a conversation is `undefined` => root. */
export async function getActiveBranchForConversation(conversationId: StableId): Promise<StableId | undefined> {
  const active = await getActiveBranch(conversationId)
  if (!active) return undefined
  const b = await getBranch(active)
  // Stored branch no longer exists: fall back to root without crashing.
  return b ? active : undefined
}

/**
 * Atomically ACCEPT a user message into a branch: in ONE readwrite txn across
 * ['conversationBranches','settings'] commit the updated branch record AND delete the
 * branch draft row. Never a partial state: either (message accepted + draft cleared)
 * or (message absent + draft intact). Returning true means accepted & durable.
 */
export async function acceptBranchUserMessage(branchId: StableId, message: Message): Promise<boolean> {
  const branch = await getBranch(branchId)
  if (!branch) return false
  const now = Date.now()
  const updated: ConversationBranch = { ...branch, updatedAt: now, messages: [...branch.messages, message] }
  await idbRunTxn(['conversationBranches', 'settings'], (txn) => {
    txn.objectStore('conversationBranches').put(updated)
    txn.objectStore('settings').delete(branchDraftSettingKey(branchId))
  })
  clearBranchDraftMemory(branchId)
  return true
}
