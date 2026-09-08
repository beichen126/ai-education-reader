import { isStableBranchPoint, type Conversation, type Message, type StableId } from '../engine/types'
import type { BranchDiagnostic, ConversationBranch, MessageOwner } from './branch-types'

/**
 * Pure projection + integrity module for the branch graph. NO storage, NO side effects.
 *
 * Key guarantees:
 *  - buildEffectiveConversationPath is memoizable and never mutates input.
 *  - A corrupt/unknown active branch NEVER crashes: it falls back to the root path.
 *  - Integrity problems are reported as diagnostics, never silently guessed.
 */

type MessageIndex = { byId: Map<StableId, Message>; duplicates: Set<StableId> }
type BranchIndexResult = { byId: Map<StableId, ConversationBranch>; duplicates: Set<StableId> }
const branchIndexCache = new WeakMap<object, BranchIndexResult>()

/** Globally unique message ids across root + every branch-local message. */
function messageIndex(conversation: Conversation, branches: ConversationBranch[]): MessageIndex {
  const byId = new Map<StableId, Message>()
  const seen = new Map<StableId, string>()
  const duplicates = new Set<StableId>()
  const note = (id: StableId, owner: string, m: Message) => {
    const prev = seen.get(id)
    if (prev !== undefined) { duplicates.add(id); return }
    seen.set(id, owner)
    if (!byId.has(id)) byId.set(id, m)
  }
  for (const m of conversation.messages) note(m.id, 'root', m)
  for (const b of branches) {
    // A branch may itself be missing its conversation; still index its local messages
    // so the winner for a duplicated id is deterministic.
    for (const m of b.messages) note(m.id, 'branch:' + b.id, m)
  }
  return { byId, duplicates }
}

function branchIndex(branches: ConversationBranch[]): BranchIndexResult {
  const cached = branchIndexCache.get(branches)
  if (cached) return cached
  const byId = new Map<StableId, ConversationBranch>()
  const duplicates = new Set<StableId>()
  for (const b of branches) {
    if (byId.has(b.id)) { duplicates.add(b.id); continue }
    byId.set(b.id, b)
  }
  const result = { byId, duplicates }
  branchIndexCache.set(branches, result)
  return result
}

type Ctx = {
  conversation: Conversation
  byId: Map<StableId, ConversationBranch>
  msgById: Map<StableId, Message>
  duplicateBranchIds: Set<StableId>
  duplicateMessageIds: Set<StableId>
  memo: Map<StableId, StableId[] | null>
  issues: BranchDiagnostic[]
  visiting: Set<StableId>
}

function makeCtx(conversation: Conversation, branches: ConversationBranch[]): Ctx {
  const bi = branchIndex(branches)
  const mi = messageIndex(conversation, branches)
  return {
    conversation, byId: bi.byId, msgById: mi.byId,
    duplicateBranchIds: bi.duplicates, duplicateMessageIds: mi.duplicates,
    memo: new Map(), issues: [], visiting: new Set(),
  }
}

/**
 * Compute the effective message-id list for one branch (recursive, memoized, cycle-safe).
 * Returns null when the branch or an ancestor is corrupt (the branch is UNAVAILABLE).
 * While walking it records actionable diagnostics.
 */
function computeEffectiveIds(ctx: Ctx, branchId: StableId): StableId[] | null {
  const cached = ctx.memo.get(branchId)
  if (cached !== undefined) return cached

  const branch = ctx.byId.get(branchId)
  if (!branch) {
    ctx.issues.push({ code: 'missing-parent', branchId, parentBranchId: branchId })
    ctx.memo.set(branchId, null)
    return null
  }
  if (branch.conversationId !== ctx.conversation.id) {
    ctx.issues.push({ code: 'missing-conversation', branchId })
    ctx.memo.set(branchId, null)
    return null
  }
  if (ctx.duplicateBranchIds.has(branchId)) {
    ctx.issues.push({ code: 'duplicate-id', branchId })
    ctx.memo.set(branchId, null)
    return null
  }
  if (ctx.visiting.has(branchId)) {
    ctx.issues.push({ code: 'cycle', branchId, cycle: [...ctx.visiting, branchId] })
    ctx.memo.set(branchId, null)
    return null
  }
  ctx.visiting.add(branchId)

  // Determine the parent effective path to fork from.
  let parentEff: StableId[]
  if (branch.parentBranchId === undefined) {
    parentEff = ctx.conversation.messages.map((m) => m.id)
  } else {
    const parentId = branch.parentBranchId
    if (parentId === branchId) {
      ctx.issues.push({ code: 'self-parent', branchId })
      ctx.memo.set(branchId, null); ctx.visiting.delete(branchId); return null
    }
    const parentBranch = ctx.byId.get(parentId)
    if (!parentBranch) {
      ctx.issues.push({ code: 'missing-parent', branchId, parentBranchId: parentId })
      ctx.memo.set(branchId, null); ctx.visiting.delete(branchId); return null
    }
    if (parentBranch.conversationId !== branch.conversationId) {
      ctx.issues.push({ code: 'wrong-conversation-parent', branchId, parentBranchId: parentId })
      ctx.memo.set(branchId, null); ctx.visiting.delete(branchId); return null
    }
    const p = computeEffectiveIds(ctx, parentId)
    if (p === null) { ctx.memo.set(branchId, null); ctx.visiting.delete(branchId); return null }
    parentEff = p
  }

  // Fork point must exist in the parent effective path.
  const forkIdx = parentEff.indexOf(branch.forkMessageId)
  if (forkIdx < 0) {
    ctx.issues.push({ code: 'missing-fork', branchId, forkMessageId: branch.forkMessageId })
    ctx.memo.set(branchId, null); ctx.visiting.delete(branchId); return null
  }
  const inherited = parentEff.slice(0, forkIdx + 1)
  const localIds = branch.messages.map((m) => m.id)
  const result = [...inherited, ...localIds]
  ctx.memo.set(branchId, result)
  ctx.visiting.delete(branchId)
  return result
}

/** Validate a branch graph for one conversation. Never throws. */
export function validateBranchGraph(conversation: Conversation, branches: ConversationBranch[]): BranchDiagnostic[] {
  const ctx = makeCtx(conversation, branches)
  for (const b of branches) computeEffectiveIds(ctx, b.id)
  for (const id of ctx.duplicateMessageIds) {
    let ownerBranch: StableId | null = null
    for (const b of branches) {
      if (b.messages.some((m) => m.id === id)) { ownerBranch = b.id; break }
    }
    if (ownerBranch) ctx.issues.push({ code: 'duplicate-message-id', branchId: ownerBranch, messageId: id })
    else ctx.issues.push({ code: 'duplicate-message-id', branchId: 'root', messageId: id })
  }
  return ctx.issues
}

/** True when the branch graph is fully consistent (no diagnostics). */
export function isBranchGraphValid(conversation: Conversation, branches: ConversationBranch[]): boolean {
  return validateBranchGraph(conversation, branches).length === 0
}

/**
 * CANONICAL pure function. Materialize the visible/effective history for a thread.
 *
 *   activeBranchId undefined => root (Conversation.messages).
 *   activeBranchId set       => effective history of parent up to & incl. forkMessageId
 *                               + the branch local messages.
 * Nested branches resolve recursively. A branch that cannot be resolved (corrupt,
 * missing ancestor, cycle) falls back to the root path - never a guessed history.
 */
export function buildEffectiveConversationPath(
  conversation: Conversation,
  branches: ConversationBranch[],
  activeBranchId?: StableId,
): Message[] {
  if (!activeBranchId) return conversation.messages
  const ctx = makeCtx(conversation, branches)
  const ids = computeEffectiveIds(ctx, activeBranchId)
  if (ids === null) return conversation.messages
  return ids.map((id) => ctx.msgById.get(id)).filter((m): m is Message => !!m)
}

/** Effective path for a thread as message IDs (lighter). Null = unresolved active branch. */
export function buildEffectiveMessageIds(
  conversation: Conversation,
  branches: ConversationBranch[],
  activeBranchId?: StableId,
): StableId[] | null {
  if (!activeBranchId) return conversation.messages.map((m) => m.id)
  const ctx = makeCtx(conversation, branches)
  return computeEffectiveIds(ctx, activeBranchId)
}

export type EffectiveMessagePathResult = {
  messageIds: StableId[] | null
  diagnostics: BranchDiagnostic[]
  rootRoute: EffectiveMessageRoute
  routeByBranch: Map<StableId, EffectiveMessageRoute>
  /** Branch rows actually used by the active route, root-most first. */
  lineageBranches: ConversationBranch[]
}

/**
 * Persistent membership/order view for one effective message route. A child
 * route keeps a reference to its parent route and only stores its fork cut and
 * local messages, so looking up a boundary does not copy the parent path.
 */
export type EffectiveMessageRoute = {
  has(messageId: StableId): boolean
  position(messageId: StableId): number | undefined
}

function createRootMessageRoute(messageIds: readonly StableId[]): EffectiveMessageRoute {
  const positions = new Map(messageIds.map((messageId, position) => [messageId, position]))
  const position = (messageId: StableId) => positions.get(messageId)
  return { position, has: (messageId) => position(messageId) !== undefined }
}

function extendMessageRoute(
  parent: EffectiveMessageRoute,
  forkPosition: number,
  localMessageIds: readonly StableId[],
): EffectiveMessageRoute {
  const localPositions = new Map<StableId, number>()
  localMessageIds.forEach((messageId, index) => {
    if (!localPositions.has(messageId)) localPositions.set(messageId, forkPosition + 1 + index)
  })
  const position = (messageId: StableId): number | undefined => {
    const localPosition = localPositions.get(messageId)
    if (localPosition !== undefined) return localPosition
    const inheritedPosition = parent.position(messageId)
    return inheritedPosition !== undefined && inheritedPosition <= forkPosition ? inheritedPosition : undefined
  }
  return { position, has: (messageId) => position(messageId) !== undefined }
}

/**
 * Materialize one active route without validating unrelated branches or copying
 * every ancestor path recursively. The branch index is cached by the immutable
 * branch-array identity; each subsequent route read walks only the active
 * lineage and its messages.
 */
export function buildEffectiveMessagePath(
  conversation: Conversation,
  branches: ConversationBranch[],
  activeBranchId?: StableId,
): EffectiveMessagePathResult {
  const rootMessageIds = conversation.messages.map((message) => message.id)
  const rootRoute = createRootMessageRoute(rootMessageIds)
  const routeByBranch = new Map<StableId, EffectiveMessageRoute>()
  if (!activeBranchId) return { messageIds: rootMessageIds, diagnostics: [], rootRoute, routeByBranch, lineageBranches: [] }

  const index = branchIndex(branches)
  const diagnostics: BranchDiagnostic[] = []
  const lineage: ConversationBranch[] = []
  const seen = new Set<StableId>()
  let current: StableId | undefined = activeBranchId
  while (current !== undefined) {
    if (seen.has(current)) {
      diagnostics.push({ code: 'cycle', branchId: current, cycle: [...seen, current] })
      return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
    }
    seen.add(current)
    const branch = index.byId.get(current)
    if (!branch) {
      diagnostics.push({ code: 'missing-parent', branchId: current, parentBranchId: current })
      return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
    }
    if (index.duplicates.has(current)) {
      diagnostics.push({ code: 'duplicate-id', branchId: current })
      return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
    }
    if (branch.conversationId !== conversation.id) {
      diagnostics.push({ code: 'missing-conversation', branchId: current })
      return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
    }
    lineage.unshift(branch)
    if (branch.parentBranchId !== undefined) {
      const parent = index.byId.get(branch.parentBranchId)
      if (!parent) {
        diagnostics.push({ code: 'missing-parent', branchId: branch.id, parentBranchId: branch.parentBranchId })
        return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
      }
      if (parent.conversationId !== branch.conversationId) {
        diagnostics.push({ code: 'wrong-conversation-parent', branchId: branch.id, parentBranchId: branch.parentBranchId })
        return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
      }
      current = branch.parentBranchId
    } else current = undefined
  }

  const messageIds = [...rootMessageIds]
  const positions = new Map(messageIds.map((id, position) => [id, position]))
  const activeIds = new Set(messageIds)
  let currentRoute = rootRoute
  for (const branch of lineage) {
    const forkPosition = positions.get(branch.forkMessageId)
    if (forkPosition === undefined) {
      diagnostics.push({ code: 'missing-fork', branchId: branch.id, forkMessageId: branch.forkMessageId })
      return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
    }
    for (let position = messageIds.length - 1; position > forkPosition; position--) {
      positions.delete(messageIds[position])
      activeIds.delete(messageIds[position])
    }
    messageIds.length = forkPosition + 1
    for (const message of branch.messages) {
      if (activeIds.has(message.id)) {
        diagnostics.push({ code: 'duplicate-message-id', branchId: branch.id, messageId: message.id })
        return { messageIds: null, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
      }
      positions.set(message.id, messageIds.length)
      activeIds.add(message.id)
      messageIds.push(message.id)
    }
    currentRoute = extendMessageRoute(currentRoute, forkPosition, branch.messages.map((message) => message.id))
    routeByBranch.set(branch.id, currentRoute)
  }
  return { messageIds, diagnostics, rootRoute, routeByBranch, lineageBranches: lineage.slice() }
}

/**
 * Effective history THROUGH (and including) a single message. Never returns later
 * messages. This is the contract the Artifact source "frozen at selected point"
 * depends on. Returns [] when the message is not on the active path.
 */
export function buildEffectivePathThrough(
  conversation: Conversation,
  branches: ConversationBranch[],
  thread: { branchId?: StableId },
  throughMessageId: StableId,
): Message[] {
  const eff = buildEffectiveConversationPath(conversation, branches, thread.branchId)
  const idx = eff.findIndex((m) => m.id === throughMessageId)
  if (idx < 0) return []
  return eff.slice(0, idx + 1)
}

/** Ordered lineage of branch ids from the root-most ancestor down to branchId (inclusive). */
export function resolveBranchLineage(branches: ConversationBranch[], branchId: StableId): StableId[] | null {
  const byId = branchIndex(branches).byId
  const out: StableId[] = []
  const seen = new Set<StableId>()
  let cur: StableId | undefined = branchId
  while (cur !== undefined) {
    if (seen.has(cur)) return null
    seen.add(cur)
    const b = byId.get(cur)
    if (!b) return null
    out.unshift(b.id)
    cur = b.parentBranchId
  }
  return out
}

/** Depth of a branch in the graph (root fork = 1). Null when unresolved. */
export function branchDepth(branches: ConversationBranch[], branchId: StableId): number | null {
  const lineage = resolveBranchLineage(branches, branchId)
  return lineage === null ? null : lineage.length
}

/** Which branch (or the root) actually owns a message (defines it locally). */
export function locateMessageOwner(conversation: Conversation, branches: ConversationBranch[], messageId: StableId): MessageOwner {
  for (const b of branches) {
    if (b.conversationId !== conversation.id) continue
    if (b.messages.some((m) => m.id === messageId)) return { kind: 'branch', branchId: b.id }
  }
  return { kind: 'root' }
}

/** Canonical fork target: prefer branching from the OWNER of the selected fork message. */
export function canonicalForkOwner(conversation: Conversation, branches: ConversationBranch[], messageId: StableId): StableId | undefined {
  const owner = locateMessageOwner(conversation, branches, messageId)
  return owner.kind === 'branch' ? owner.branchId : undefined
}

/** Collect descendant branch ids (subtree, excluding the branch itself). */
export function descendantBranchIds(branches: ConversationBranch[], branchId: StableId): StableId[] {
  const children = new Map<StableId, StableId[]>()
  for (const b of branches) {
    if (b.parentBranchId === undefined) continue
    const arr = children.get(b.parentBranchId) ?? []
    arr.push(b.id)
    children.set(b.parentBranchId, arr)
  }
  const out: StableId[] = []
  const stack = [...(children.get(branchId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    for (const c of children.get(id) ?? []) stack.push(c)
  }
  return out
}

/** A message id is safe to fork from only when it is a COMPLETED, stable message. */
export function canForkFromMessage(conversation: Conversation, branches: ConversationBranch[], messageId: StableId): boolean {
  const eff = buildEffectiveConversationPath(conversation, branches)
  const m = eff.find((x) => x.id === messageId)
  if (m) return isStableBranchPoint(m)
  for (const branch of branches) {
    const local = branch.messages.find((x) => x.id === messageId)
    if (local) return isStableBranchPoint(local)
  }
  return false
}
