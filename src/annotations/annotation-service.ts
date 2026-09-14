import { getAnnotationsByMessage, saveAnnotations, deleteAnnotationsByIds, deleteConversationAnnotations } from '../storage/storage'
import { shouldToggleAll, makeAnnotation, normalizeAnchor, sameKey, toggleWithin, rebuildQuote, toggleTableCells as tc, toggleWholeTable as wt, toggleMath as tm } from './annotation-ops'
import type { TableBounds } from './annotation-types'
import type { Annotation, TextAnchor, TextAnnotationTarget } from './annotation-types'
import type { TextSelectionSegment } from './selection-types'
import { createStudyCardFromAssistantMessage, deleteStudyCard, getStudyCardBySourceMessage, updateStudyCardAnnotations } from '../study-cards/study-card-service'

type CanonicalOf = (anchor: TextAnchor) => string

export async function loadMessageAnnotations(conversationId: string, messageId: string): Promise<Annotation[]> {
  const [card, legacy] = await Promise.all([getStudyCardBySourceMessage(messageId), getAnnotationsByMessage(conversationId, messageId)])
  const canonical = card?.source.conversationId === conversationId ? (card.annotations ?? []) : []
  const seen = new Set(canonical.map(annotation => annotation.id))
  return [...canonical, ...legacy.filter(annotation => !seen.has(annotation.id))]
}
export async function deleteConvAnnotations(conversationId: string): Promise<void> { await deleteConversationAnnotations(conversationId) }

async function persistUnifiedAnnotations(conversationId: string, messageId: string, next: Annotation[], branchId?: string): Promise<Annotation[]> {
  const legacy = await getAnnotationsByMessage(conversationId, messageId)
  let card = await getStudyCardBySourceMessage(messageId)
  if (next.length === 0) {
    if (card?.source.conversationId === conversationId) {
      if (card.collectionMode === 'marked') await deleteStudyCard(card.id)
      else await updateStudyCardAnnotations(card.id, [])
    }
    if (legacy.length) await deleteAnnotationsByIds(legacy.map(annotation => annotation.id))
    return []
  }
  if (!card) {
    const created = await createStudyCardFromAssistantMessage({ conversationId, assistantMessageId: messageId, ...(branchId ? { branchId } : {}), collectionMode: 'marked' })
    if (created.kind === 'created' || created.kind === 'existing') card = created.card
  }
  if (!card || card.source.conversationId !== conversationId) {
    // A malformed or not-yet-stable source must not make marking fail. Keep the legacy
    // row and let the idempotent boot migration retry when the source becomes available.
    await saveAnnotations(next)
    const nextIds = new Set(next.map(annotation => annotation.id))
    const removed = legacy.filter(annotation => !nextIds.has(annotation.id)).map(annotation => annotation.id)
    if (removed.length) await deleteAnnotationsByIds(removed)
    return next
  }
  const updated = await updateStudyCardAnnotations(card.id, next)
  if (!updated) throw new Error('学习卡片标记同步失败')
  if (legacy.length) await deleteAnnotationsByIds(legacy.map(annotation => annotation.id))
  return updated.annotations ?? []
}

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

export async function toggleTextSelection(conversationId: string, messageId: string, segments: TextSelectionSegment[], canonicalOf: CanonicalOf, branchId?: string): Promise<Annotation[]> {
  const existing = await loadMessageAnnotations(conversationId, messageId)
  const segs = segments.map((seg) => ({ anchor: (seg.cell ? { scope: 'table-cell', tableId: seg.cell.tableId, row: seg.cell.row, column: seg.cell.column } : { scope: 'block', blockId: seg.blockId }) as TextAnchor, start: seg.start, end: seg.end }))
  const mode = shouldToggleAll(segs, existing)
  const next = applyMode(conversationId, messageId, segs, existing, mode, canonicalOf)
  return persistUnifiedAnnotations(conversationId, messageId, next, branchId)
}
export async function toggleMathAnnotation(conversationId: string, messageId: string, mathId: string, mathKind: 'inline' | 'block', branchId?: string): Promise<Annotation[]> {
  const existing = await loadMessageAnnotations(conversationId, messageId)
  const { keep } = tm(conversationId, messageId, mathId, mathKind, existing)
  return persistUnifiedAnnotations(conversationId, messageId, keep, branchId)
}
export async function toggleTableCellsAnnotation(conversationId: string, messageId: string, tableId: string, bounds: TableBounds, branchId?: string): Promise<Annotation[]> {
  const existing = await loadMessageAnnotations(conversationId, messageId)
  const { keep } = tc(conversationId, messageId, tableId, bounds, existing)
  return persistUnifiedAnnotations(conversationId, messageId, keep, branchId)
}
export async function toggleWholeTableAnnotation(conversationId: string, messageId: string, tableId: string, branchId?: string): Promise<Annotation[]> {
  const existing = await loadMessageAnnotations(conversationId, messageId)
  const { keep } = wt(conversationId, messageId, tableId, existing)
  return persistUnifiedAnnotations(conversationId, messageId, keep, branchId)
}
