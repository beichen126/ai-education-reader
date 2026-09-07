import { buildEffectiveMessageIds, resolveBranchLineage, validateBranchGraph } from '../branches/branch-path'
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
  routeMessageIds: StableId[]
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
  effectiveMessageIds: readonly StableId[],
  seenTransitionIds: Set<StableId>,
  candidates: Candidate[],
  diagnostics: EffectivePromptPathDiagnostic[],
): void {
  const raw = source.transitions
  if (raw === undefined) return
  const issues = getPromptTransitionIssues(raw, source.routeMessageIds)
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
  const effectiveSet = new Set(effectiveMessageIds)
  const order = new Map(effectiveMessageIds.map((id, index) => [id, index]))
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
    // A valid ancestor transition after the child fork is not corrupt; it is
    // simply outside the child route and therefore must not be inherited.
    if (transition.afterMessageId !== null && !effectiveSet.has(transition.afterMessageId)) return
    seenTransitionIds.add(transition.id)
    candidates.push({
      transition,
      position: transition.afterMessageId === null ? -1 : (order.get(transition.afterMessageId) ?? -1),
      sourceDepth: source.sourceDepth,
      sourceIndex,
    })
  })
}

function rootResult(conversation: Conversation, diagnostics: EffectivePromptPathDiagnostic[] = []): EffectivePromptPathResult {
  const messageIds = conversation.messages.map((message) => message.id)
  const candidates: Candidate[] = []
  collectSource({ owner: 'root', sourceDepth: 0, transitions: conversation.promptTransitions, routeMessageIds: messageIds }, messageIds, new Set(), candidates, diagnostics)
  candidates.sort((a, b) => a.position - b.position || a.sourceDepth - b.sourceDepth || a.sourceIndex - b.sourceIndex)
  return { transitions: candidates.map((candidate) => candidate.transition), messageIds, diagnostics, resolved: true }
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

  const diagnostics: EffectivePromptPathDiagnostic[] = validateBranchGraph(conversation, branches)
  const lineage = resolveBranchLineage(branches, activeBranchId)
  const effectiveIds = buildEffectiveMessageIds(conversation, branches, activeBranchId)
  if (diagnostics.length > 0 || lineage === null || effectiveIds === null) {
    return { ...rootResult(conversation, diagnostics), resolved: false }
  }

  const byId = new Map(branches.map((branch) => [branch.id, branch]))
  const sources: Source[] = [{
    owner: 'root',
    sourceDepth: 0,
    transitions: conversation.promptTransitions,
    routeMessageIds: conversation.messages.map((message) => message.id),
  }]
  lineage.forEach((branchId, index) => {
    const branch = byId.get(branchId)
    if (!branch) return
    const routeMessageIds = buildEffectiveMessageIds(conversation, branches, branch.id) ?? []
    sources.push({ owner: 'branch', branchId: branch.id, sourceDepth: index + 1, transitions: branch.promptTransitions, routeMessageIds })
  })

  const candidates: Candidate[] = []
  const seenTransitionIds = new Set<StableId>()
  for (const source of sources) collectSource(source, effectiveIds, seenTransitionIds, candidates, diagnostics)
  candidates.sort((a, b) => a.position - b.position || a.sourceDepth - b.sourceDepth || a.sourceIndex - b.sourceIndex)
  return { transitions: candidates.map((candidate) => candidate.transition), messageIds: effectiveIds, diagnostics, resolved: true }
}

export const buildEffectivePromptTimeline = buildEffectivePromptPath

