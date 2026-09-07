import { buildEffectiveMessagePath, resolveBranchLineage } from '../branches/branch-path'
import type { EffectiveMessageRoute } from '../branches/branch-path'
import type { BranchDiagnostic, ConversationBranch } from '../branches/branch-types'
import type { Conversation, StableId } from '../engine/types'
import { getPromptTransitionIssues } from './prompt-validation'
import type { PromptTransition } from './prompt-types'

export type PromptTransitionPathDiagnostic = {
  code: 'invalid-transition' | 'duplicate-transition'
  owner: 'root' | 'branch'
  branchId?: StableId
  transitionId?: StableId
  path: string
  message: string
}

export type EffectivePromptPathDiagnostic = BranchDiagnostic | PromptTransitionPathDiagnostic

export type EffectivePromptPathResult = {
  transitions: PromptTransition[]
  messageIds: StableId[]
  diagnostics: EffectivePromptPathDiagnostic[]
  resolved: boolean
}

type Candidate = {
  transition: PromptTransition
  position: number
  sourceDepth: number
  sourceIndex: number
}

type Source = {
  owner: 'root' | 'branch'
  branchId?: StableId
  sourceDepth: number
  transitions: unknown
  routeMessagePath: EffectiveMessageRoute
}

/**
 * A child route may intentionally switch mode at the same message boundary as
 * an inherited transition. The child snapshot is the effective one for that
 * route; keeping both candidates would make the compiler see two modes at one
 * boundary. This also preserves the audit trail in the owning row while
 * materializing one unambiguous effective timeline.
 */
function materializeCandidates(candidates: Candidate[]): PromptTransition[] {
  const ordered = [...candidates].sort((a, b) => a.position - b.position || a.sourceDepth - b.sourceDepth || a.sourceIndex - b.sourceIndex)
  const winnerByBoundary = new Map<StableId | null, Candidate>()
  for (const candidate of ordered) {
    // `null` is the real initial boundary. Never coerce it to a message id:
    // `__initial__` is a legal persisted message id.
    const key = candidate.transition.afterMessageId
    const previous = winnerByBoundary.get(key)
    if (!previous || candidate.sourceDepth >= previous.sourceDepth) winnerByBoundary.set(key, candidate)
  }
  return [...winnerByBoundary.values()]
    .sort((a, b) => a.position - b.position || a.sourceDepth - b.sourceDepth || a.sourceIndex - b.sourceIndex)
    .map((candidate) => candidate.transition)
}

function transitionIndex(path: string): number | undefined {
  const match = /^promptTransitions\[(\d+)\]/.exec(path)
  return match ? Number(match[1]) : undefined
}

function invalidTransitionDiagnostic(
  owner: Source,
  issue: { path: string; message: string },
  transition?: PromptTransition,
): PromptTransitionPathDiagnostic {
  return {
    code: 'invalid-transition',
    owner: owner.owner,
    ...(owner.branchId ? { branchId: owner.branchId } : {}),
    ...(transition?.id ? { transitionId: transition.id } : {}),
    path: issue.path,
    message: issue.message,
  }
}

function collectSource(
  source: Source,
  effectiveSet: ReadonlySet<StableId>,
  effectiveOrder: ReadonlyMap<StableId, number>,
  seenTransitionIds: Set<StableId>,
  candidates: Candidate[],
  diagnostics: EffectivePromptPathDiagnostic[],
): void {
  const raw = source.transitions
  if (raw === undefined) return
  const issues = getPromptTransitionIssues(raw, source.routeMessagePath)
  if (!Array.isArray(raw)) {
    diagnostics.push(invalidTransitionDiagnostic(source, issues[0] ?? { path: 'promptTransitions', message: 'promptTransitions must be an array' }))
    return
  }
  const badIndexes = new Set<number>()
  for (const issue of issues) {
    const index = transitionIndex(issue.path)
    if (index !== undefined) badIndexes.add(index)
    const transition = index === undefined ? undefined : raw[index]
    diagnostics.push(invalidTransitionDiagnostic(source, issue, transition))
  }
  const seenBoundaries = new Set<StableId | null>()
  raw.forEach((transition, sourceIndex) => {
    if (badIndexes.has(sourceIndex) || !transition || typeof transition !== 'object') return
    if (seenTransitionIds.has(transition.id)) {
      diagnostics.push({
        code: 'duplicate-transition',
        owner: source.owner,
        ...(source.branchId ? { branchId: source.branchId } : {}),
        transitionId: transition.id,
        path: 'promptTransitions[' + sourceIndex + '].id',
        message: 'transition id is duplicated across the effective route',
      })
      return
    }
    if (seenBoundaries.has(transition.afterMessageId)) {
      diagnostics.push({
        code: 'duplicate-transition',
        owner: source.owner,
        ...(source.branchId ? { branchId: source.branchId } : {}),
        transitionId: transition.id,
        path: 'promptTransitions[' + sourceIndex + '].afterMessageId',
        message: 'same owner has duplicate transition boundary',
      })
      return
    }
    seenBoundaries.add(transition.afterMessageId)
    // A valid ancestor transition after the child fork is not corrupt; it is
    // simply outside the child route and therefore must not be inherited.
    if (transition.afterMessageId !== null && !effectiveSet.has(transition.afterMessageId)) return
    seenTransitionIds.add(transition.id)
    candidates.push({
      transition,
      position: transition.afterMessageId === null ? -1 : (effectiveOrder.get(transition.afterMessageId) ?? -1),
      sourceDepth: source.sourceDepth,
      sourceIndex,
    })
  })
}

function rootResult(conversation: Conversation, diagnostics: EffectivePromptPathDiagnostic[] = []): EffectivePromptPathResult {
  const messageIds = conversation.messages.map((message) => message.id)
  const candidates: Candidate[] = []
  const rootPositions = new Map(messageIds.map((messageId, position) => [messageId, position]))
  const rootRoute = { has: (messageId: StableId) => rootPositions.has(messageId), position: (messageId: StableId) => rootPositions.get(messageId) }
  collectSource({ owner: 'root', sourceDepth: 0, transitions: conversation.promptTransitions, routeMessagePath: rootRoute }, new Set(messageIds), rootPositions, new Set(), candidates, diagnostics)
  return { transitions: materializeCandidates(candidates), messageIds, diagnostics, resolved: !hasDuplicateOwnerBoundary(diagnostics) }
}

function hasDuplicateOwnerBoundary(diagnostics: readonly EffectivePromptPathDiagnostic[]): boolean {
  return diagnostics.some((item) => item.code === 'duplicate-transition' && item.message === 'same owner has duplicate transition boundary')
}

/**
 * Materialize the prompt timeline visible to a route. Message and transition
 * boundaries use the same branch lineage and fork cut; inherited transitions
 * are projected, never copied into child rows.
 */
export function buildEffectivePromptPath(
  conversation: Conversation,
  branches: ConversationBranch[],
  activeBranchId?: StableId,
): EffectivePromptPathResult {
  if (!activeBranchId) return rootResult(conversation)

  const materialized = buildEffectiveMessagePath(conversation, branches, activeBranchId)
  const diagnostics: EffectivePromptPathDiagnostic[] = [...materialized.diagnostics]
  const lineage = resolveBranchLineage(branches, activeBranchId)
  const effectiveIds = materialized.messageIds
  if (diagnostics.length > 0 || lineage === null || effectiveIds === null) {
    return { ...rootResult(conversation, diagnostics), resolved: false }
  }

  const byId = new Map(branches.map((branch) => [branch.id, branch]))
  const sources: Source[] = [{
    owner: 'root',
    sourceDepth: 0,
    transitions: conversation.promptTransitions,
    routeMessagePath: materialized.rootRoute,
  }]
  lineage.forEach((branchId, index) => {
    const branch = byId.get(branchId)
    if (!branch) return
    const routeMessagePath = materialized.routeByBranch.get(branch.id)
    if (routeMessagePath) sources.push({ owner: 'branch', branchId: branch.id, sourceDepth: index + 1, transitions: branch.promptTransitions, routeMessagePath })
  })

  const candidates: Candidate[] = []
  const effectiveSet = new Set(effectiveIds)
  const effectiveOrder = new Map(effectiveIds.map((id, index) => [id, index]))
  const seenTransitionIds = new Set<StableId>()
  for (const source of sources) collectSource(source, effectiveSet, effectiveOrder, seenTransitionIds, candidates, diagnostics)
  return { transitions: materializeCandidates(candidates), messageIds: effectiveIds, diagnostics, resolved: !hasDuplicateOwnerBoundary(diagnostics) }
}

export const buildEffectivePromptTimeline = buildEffectivePromptPath
