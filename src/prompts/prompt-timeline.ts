import type { PromptTransition } from './prompt-types'

/**
 * Pure timeline operation: replace the current route head. The caller uses this
 * only when the new transition has the same boundary as the existing head.
 */
export function replacePromptTransitionAtHead(
  transitions: readonly PromptTransition[],
  transition: PromptTransition,
): PromptTransition[] {
  if (transitions.length === 0) return [transition]
  return [...transitions.slice(0, -1), transition]
}

/**
 * Append a transition in canonical route order. Repeated mode changes at the
 * same boundary before a new message replace the pending head instead of
 * creating an empty prompt segment.
 */
export function appendPromptTransition(
  transitions: readonly PromptTransition[],
  transition: PromptTransition,
): PromptTransition[] {
  const head = transitions[transitions.length - 1]
  if (head && head.afterMessageId === transition.afterMessageId) {
    return replacePromptTransitionAtHead(transitions, transition)
  }
  return [...transitions, transition]
}

/** Return the boundary ids represented by a timeline, preserving its order. */
export function promptTransitionBoundaries(transitions: readonly PromptTransition[]): (string | null)[] {
  return transitions.map((transition) => transition.afterMessageId)
}

