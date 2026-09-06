import { useCallback, useEffect, useRef, useState } from 'react'
import { type Conversation, type Message, type StableId } from '../engine/types'
import { buildEffectiveConversationPath, validateBranchGraph } from '../branches/branch-path'
import { listBranchesByConversation, getActiveBranch, setActiveBranch } from '../branches/branch-store'
import { createBranchFromMessage, renameBranch, deleteBranchSubtree } from '../branches/branch-service'
import type { ConversationBranch } from '../branches/branch-types'

export function useBranchChat(conversation: Conversation | undefined): {
  branches: ConversationBranch[]
  ready: boolean
  activeBranchId: StableId | undefined
  effectiveMessages: Message[]
  diagnostics: string[]
  switchBranch(branchId: StableId | undefined): Promise<void>
  branchFrom(messageId: StableId): Promise<ConversationBranch | undefined>
  rename(branchId: StableId, title: string): Promise<void>
  removeBranch(branchId: StableId): Promise<void>
  refresh(): Promise<void>
} {
  const [branches, setBranches] = useState<ConversationBranch[]>([])
  const [activeBranchId, setActiveBranchId] = useState<StableId | undefined>(undefined)
  const [loadedConversationId, setLoadedConversationId] = useState<StableId | undefined>(undefined)
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const conversationId = conversation?.id
    const generation = ++refreshGeneration.current
    if (!conversationId) { setBranches([]); setActiveBranchId(undefined); setLoadedConversationId(undefined); return }
    setLoadedConversationId(undefined)
    const bs = await listBranchesByConversation(conversationId)
    const active = await getActiveBranch(conversationId)
    if (generation !== refreshGeneration.current) return
    const valid = active && bs.some((b) => b.id === active) ? active : undefined
    setBranches(bs)
    setActiveBranchId(valid)
    setLoadedConversationId(conversationId)
  }, [conversation?.id])

  useEffect(() => { void refresh() }, [refresh])

  const effectiveMessages = conversation ? buildEffectiveConversationPath(conversation, branches, activeBranchId) : []
  const diagnostics = conversation ? validateBranchGraph(conversation, branches).map((d) => d.code) : []

  const switchBranch = useCallback(async (branchId: StableId | undefined) => {
    if (conversation) await setActiveBranch(conversation.id, branchId)
    setActiveBranchId(branchId)
  }, [conversation?.id])
  const branchFrom = useCallback(async (messageId: StableId) => {
    if (!conversation) return undefined
    const b = await createBranchFromMessage(conversation.id, messageId)
    // Spec: creating a branch switches the active view to it (its inherited history stays visible,
    // the composer starts empty, the original path is unchanged).
    setActiveBranchId(b.id)
    await refresh()
    return b
  }, [conversation?.id, refresh])
  const rename = useCallback(async (branchId: StableId, title: string) => { await renameBranch(branchId, title); await refresh() }, [refresh])
  const removeBranch = useCallback(async (branchId: StableId) => { await deleteBranchSubtree(branchId); await refresh(); setActiveBranchId(undefined) }, [refresh])

  const ready = !!conversation?.id && loadedConversationId === conversation.id
  return { branches, ready, activeBranchId, effectiveMessages, diagnostics, switchBranch, branchFrom, rename, removeBranch, refresh }
}
