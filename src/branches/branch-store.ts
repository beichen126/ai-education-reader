import { idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbDelete, idbBatchPut, idbBatchDelete, idbRunTxn } from '../storage/idb'
import { getSetting, setSetting, deleteSetting } from '../storage/storage'
import { normalizeMessagePdfContexts, type StableId } from '../engine/types'
import { activeBranchKey, BRANCH_DRAFT_PREFIX } from './branch-types'
import type { ConversationBranch } from './branch-types'

/** Branch persistence: first-class 'conversationBranches' store (never the settings store). */
export type BranchChange = {kind:'saved';branch:ConversationBranch} | {kind:'deleted';id:StableId}
const branchListeners=new Set<(change:BranchChange)=>void>()
export function subscribeBranchChanges(listener:(change:BranchChange)=>void):()=>void {
  branchListeners.add(listener)
  return()=>{branchListeners.delete(listener)}
}
function publishBranchChange(change:BranchChange):void {
  for(const listener of branchListeners) {try {listener(change)} catch { /* A view must not turn a committed write into a failed send. */ }}
}
/** Call only after the owning IDB transaction has committed. */
export function notifyBranchSaved(branch:ConversationBranch):void {publishBranchChange({kind:'saved',branch:normalizeBranch(branch)})}
export function notifyBranchDeleted(id: StableId): void { publishBranchChange({ kind: 'deleted', id }) }

function normalizeBranch(branch: ConversationBranch): ConversationBranch {
  return { ...branch, messages: branch.messages.map(normalizeMessagePdfContexts) }
}

export async function getBranch(id: StableId): Promise<ConversationBranch | undefined> {
  const branch = await idbGet('conversationBranches', id)
  return branch ? normalizeBranch(branch) : branch
}

/** All branches of one conversation, in creation order. */
export async function listBranchesByConversation(conversationId: StableId): Promise<ConversationBranch[]> {
  const rows = await idbGetAllByIndex('conversationBranches', 'by_conversation', conversationId)
  return rows.map(normalizeBranch).sort((a, b) => a.createdAt - b.createdAt)
}

/** Every branch in the store (all conversations). Used by the GC reachability + backup. */
export async function allBranches(): Promise<ConversationBranch[]> { return (await idbGetAll('conversationBranches')).map(normalizeBranch) }

export async function saveBranch(branch: ConversationBranch): Promise<void> { await idbPut('conversationBranches', normalizeBranch(branch));notifyBranchSaved(branch) }
export async function saveBranches(branches: ConversationBranch[]): Promise<void> { await idbBatchPut('conversationBranches', branches.map(normalizeBranch));branches.forEach(notifyBranchSaved) }
export async function deleteBranch(id: StableId): Promise<void> { await idbDelete('conversationBranches', id);notifyBranchDeleted(id) }
export async function deleteBranches(ids: StableId[]): Promise<void> { await idbBatchDelete('conversationBranches', ids);ids.forEach(notifyBranchDeleted) }

/** Update the current durable branch only while it and its owning chat still exist. */
export async function updateExistingBranch(id: StableId, change: (branch: ConversationBranch) => ConversationBranch, clearDraft = false): Promise<ConversationBranch | undefined> {
  let committed: ConversationBranch | undefined
  let mutationError: unknown
  await idbRunTxn(['conversations', 'conversationBranches', 'settings'], txn => {
    const branches = txn.objectStore('conversationBranches')
    const lookup = branches.get(id)
    lookup.onsuccess = () => {
      const branch = lookup.result as ConversationBranch | undefined
      if (!branch) return
      const root = txn.objectStore('conversations').getKey(branch.conversationId)
      root.onsuccess = () => {
        if (root.result === undefined) return
        try {
          committed = change(branch)
          if (committed !== branch) branches.put(normalizeBranch(committed))
          if (clearDraft) txn.objectStore('settings').delete(BRANCH_DRAFT_PREFIX + id)
        } catch (error) {
          mutationError = error
          txn.abort()
        }
      }
    }
  }).catch(error => { throw mutationError ?? error })
  if (committed) notifyBranchSaved(committed)
  return committed
}

/** Delete every branch of a conversation (used by delete-conversation). */
export async function deleteBranchesByConversation(conversationId: StableId): Promise<void> {
  const rows = await listBranchesByConversation(conversationId)
  if (rows.length) await deleteBranches(rows.map((r) => r.id))
}

/** Atomically commit a branch record + the active-branch setting in ONE readwrite txn. */
export async function saveBranchAndActive(branch: ConversationBranch, activeBranchId: StableId | undefined): Promise<boolean> {
  let saved = false
  await idbRunTxn(['conversations', 'conversationBranches', 'settings'], txn => {
    const branches = txn.objectStore('conversationBranches')
    const write = () => {
      branches.put(normalizeBranch(branch))
      const settings = txn.objectStore('settings')
      if (activeBranchId) settings.put({ key: activeBranchKey(branch.conversationId), value: activeBranchId })
      else settings.delete(activeBranchKey(branch.conversationId))
      saved = true
    }
    const root = txn.objectStore('conversations').getKey(branch.conversationId)
    root.onsuccess = () => {
      if (root.result === undefined) return
      if (!branch.parentBranchId) { write(); return }
      const parent = branches.get(branch.parentBranchId)
      parent.onsuccess = () => { if (parent.result?.conversationId === branch.conversationId) write() }
    }
  })
  if (saved) notifyBranchSaved(branch)
  return saved
}

/** Read the persisted active branch for a conversation (absent/undefined => root). */
export async function getActiveBranch(conversationId: StableId): Promise<StableId | undefined> {
  const v = await getSetting(activeBranchKey(conversationId))
  return typeof v === 'string' && v ? v : undefined
}

/** Persist the active branch for a conversation. undefined clears (fallback to root). */
export async function setActiveBranch(conversationId: StableId, branchId: StableId | undefined): Promise<void> {
  if (branchId) await setSetting(activeBranchKey(conversationId), branchId)
  else await deleteSetting(activeBranchKey(conversationId))
}
