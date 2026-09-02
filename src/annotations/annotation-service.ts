import { getAnnotationsByMessage, saveAnnotations, deleteAnnotationsByIds, deleteConversationAnnotations } from '../storage/storage'
import { shouldToggleAll, makeAnnotation, normalizeAnchor, sameKey, toggleWithin, rebuildQuote, toggleTableCells as tc, toggleWholeTable as wt, toggleMath as tm } from './annotation-ops'
import type { TableBounds } from './annotation-types'
import type { Annotation, TextAnchor, TextAnnotationTarget } from './annotation-types'
import type { TextSelectionSegment } from './selection-types'

type CanonicalOf = (anchor: TextAnchor) => string

export async function loadMessageAnnotations(conversationId: string, messageId: string): Promise<Annotation[]> { return getAnnotationsByMessage(conversationId, messageId) }
export async function deleteConvAnnotations(conversationId: string): Promise<void> { await deleteConversationAnnotations(conversationId) }

function requote(a: Annotation, canonical: string): Annotation { const t = a.target as TextAnnotationTarget; return { ...a, target: { ...t, quote: rebuildQuote(canonical, t.start, t.end) } } }

function applyMode(conversationId: string, messageId: string, segs: { anchor: TextAnchor; start: number; end: number }[], existing: Annotation[], mode: 'add' | 'remove', canonicalOf: CanonicalOf): Annotation[] {
  let cur = existing
  for (const st of segs) {
    const canon = canonicalOf(st.anchor)
    const inAnchor = cur.filter((a) => sameKey(a, st.anchor))
    const outAnchor = cur.filter((a) => !sameKey(a, st.anchor))
    if (mode === 'add') {
      const merged = normalizeAnchor([...inAnchor, makeAnnotation(conversationId, messageId, st.anchor, canon, st.start, st.end)], st.anchor).map((a) => requote(a, canon))
      cur = [...outAnchor, ...merged]
    } else {
      const { keep } = toggleWithin(canon, conversationId, messageId, st.anchor, st.start, st.end, inAnchor)
      cur = [...outAnchor, ...keep]
    }
  }
  return cur
}

export async function toggleTextSelection(conversationId: string, messageId: string, segments: TextSelectionSegment[], canonicalOf: CanonicalOf): Promise<Annotation[]> {
  const existing = await getAnnotationsByMessage(conversationId, messageId)
  const segs = segments.map((seg) => ({ anchor: (seg.cell ? { scope: 'table-cell', tableId: seg.cell.tableId, row: seg.cell.row, column: seg.cell.column } : { scope: 'block', blockId: seg.blockId }) as TextAnchor, start: seg.start, end: seg.end }))
  const mode = shouldToggleAll(segs, existing)
  const next = applyMode(conversationId, messageId, segs, existing, mode, canonicalOf)
  const prevIds = new Set(existing.map((a) => a.id))
  const nextIds = new Set(next.map((a) => a.id))
  const toSave = next
  const toDelete = existing.filter((a) => !nextIds.has(a.id)).map((a) => a.id)
  await saveAnnotations(toSave)
  if (toDelete.length) await deleteAnnotationsByIds(toDelete)
  return next
}
export async function toggleMathAnnotation(conversationId: string, messageId: string, mathId: string, mathKind: 'inline' | 'block'): Promise<Annotation[]> {
  const existing = await getAnnotationsByMessage(conversationId, messageId)
  const { remove, keep } = tm(conversationId, messageId, mathId, mathKind, existing)
  await saveAnnotations(keep)
  if (remove.length) await deleteAnnotationsByIds(remove.map((a) => a.id))
  return keep
}
export async function toggleTableCellsAnnotation(conversationId: string, messageId: string, tableId: string, bounds: TableBounds): Promise<Annotation[]> {
  const existing = await getAnnotationsByMessage(conversationId, messageId)
  const { remove, keep } = tc(conversationId, messageId, tableId, bounds, existing)
  await saveAnnotations(keep)
  if (remove.length) await deleteAnnotationsByIds(remove.map((a) => a.id))
  return keep
}
export async function toggleWholeTableAnnotation(conversationId: string, messageId: string, tableId: string): Promise<Annotation[]> {
  const existing = await getAnnotationsByMessage(conversationId, messageId)
  const { remove, keep } = wt(conversationId, messageId, tableId, existing)
  await saveAnnotations(keep)
  if (remove.length) await deleteAnnotationsByIds(remove.map((a) => a.id))
  return keep
}
