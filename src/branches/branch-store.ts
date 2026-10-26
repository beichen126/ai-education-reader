import { idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbDelete, idbBatchPut, idbBatchDelete, idbRunTxn } from '../storage/idb'
import { getSetting, setSetting, deleteSetting } from '../storage/storage'
import { normalizeMessagePdfContexts, type StableId } from '../engine/types'
import { activeBranchKey } from './branch-types'
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
export async function deleteBranch(id: StableId): Promise<void> { await idbDelete('conversationBranches', id);publishBranchChange({kind:'deleted',id}) }
export async function deleteBranches(ids: StableId[]): Promise<void> { await idbBatchDelete('conversationBranches', ids);ids.forEach(id=>publishBranchChange({kind:'deleted',id})) }

/** Delete every branch of a conversation (used by delete-conversation). */
export async function deleteBranchesByConversation(conversationId: StableId): Promise<void> {
  const rows = await listBranchesByConversation(conversationId)
  if (rows.length) await deleteBranches(rows.map((r) => r.id))
}

/** Atomically commit a branch record + the active-branch setting in ONE readwrite txn. */
export async function saveBranchAndActive(branch: ConversationBranch, activeBranchId: StableId | undefined): Promise<void> {
  await idbRunTxn(['conversationBranches', 'settings'], (txn) => {
    txn.objectStore('conversationBranches').put(normalizeBranch(branch))
    const sos = txn.objectStore('settings')
    if (activeBranchId) sos.put({ key: activeBranchKey(branch.conversationId), value: activeBranchId })
    else sos.delete(activeBranchKey(branch.conversationId))
  })
  notifyBranchSaved(branch)
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
