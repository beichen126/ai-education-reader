// Annotation event ownership. Each AnnotatedMarkdown instance must ONLY respond to
// pointer / selection events that live inside its own message wrapper — never pick up
// a formula or selection that belongs to a DIFFERENT message. These pure helpers keep
// that rule testable in isolation (no DOM required) and shared by the component.
import type { AnnotationTarget, MathAnnotationTarget } from './annotation-types'

/** whether a node is root itself or a descendant (DOM Node.contains semantics). */
export function containsNode(root: Element | null, n: Node | null): boolean {
  return !!root && !!n && root.contains(n)
}

export type OwnedMath = { id: string; kind: 'inline' | 'block' }

/**
 * Find the nearest formula (data-math-id) at/above target, but ONLY if it lives
 * inside root. If the target (or its formula) belongs to another message, return
 * null so this instance never enters a pending-math state for someone else's formula.
 */
export function ownedMath(root: Element | null, target: any): OwnedMath | null {
  if (!root || !target || !root.contains(target)) return null
  for (let e = target; e; e = e.parentElement) {
    const id = e.getAttribute && e.getAttribute('data-math-id')
    if (id) return { id, kind: e.getAttribute('data-math-kind') === 'block' ? 'block' : 'inline' }
  }
  return null
}

/** Whether an annotation target is a math target (used by ownership-aware togglers). */
export function isMathTarget(t: AnnotationTarget): t is MathAnnotationTarget { return t.type === 'math' }

