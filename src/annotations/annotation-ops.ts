import { newStableId } from '../engine/types'
import type { Annotation, TextAnnotationTarget, TextAnchor, TableBounds } from './annotation-types'

/** Narrow an annotation to its text target, or undefined for math/table/table-cells targets. */
function tgt(a: Annotation): TextAnnotationTarget | undefined { return a.target.type === 'text' ? a.target : undefined }
export function sameKey(a: Annotation, anchor: TextAnchor): boolean { const t = tgt(a); return !!t && sameAnchor(t.anchor, anchor) }

/** anchor key — annotations never merge across different blocks / table cells. */
export function anchorKey(a: TextAnchor): string {
  // Non-text annotations (math / table / table-cells targets) carry no .anchor.
  // Never treat them as a text anchor: return a sentinel that can't match a real one,
  // so text toggles exclude (and preserve) them instead of crashing on undefined.scope.
  if (!a || typeof (a as any).scope !== 'string') return 'NONE'
  return a.scope === 'block' ? 'B:' + a.blockId : 'C:' + a.tableId + ':' + a.row + ':' + a.column
}
export function sameAnchor(a: TextAnchor, b: TextAnchor): boolean { return anchorKey(a) === anchorKey(b) }
export function isCovered(target: TextAnnotationTarget, start: number, end: number): boolean {
  return target.start <= start && end <= target.end
}
export function overlaps(a: TextAnnotationTarget, s: number, e: number): boolean { return a.start < e && s < a.end }

/** Rebuild quote from canonical text + interval (exact === slice invariant). */
export function rebuildQuote(canonical: string, start: number, end: number, ctx = 32): { exact: string; prefix: string; suffix: string } {
  const exact = canonical.slice(start, end)
  const prefix = canonical.slice(Math.max(0, start - ctx), start)
  const suffix = canonical.slice(end, end + ctx)
  return { exact, prefix, suffix }
}

export function makeAnnotation(conversationId: string, messageId: string, anchor: TextAnchor, canonical: string, start: number, end: number, id?: string): Annotation {
  const now = Date.now()
  return { id: id || newStableId(), conversationId, messageId, target: { type: 'text', anchor, start, end, quote: rebuildQuote(canonical, start, end) }, createdAt: now, updatedAt: now, version: 1 }
}

/**
 * Normalize a list of text annotations within one anchor: merge overlapping /
 * adjacent intervals. Returns a new list sorted by start. Merge keeps the leftmost
 * (and by precedence earliest-created) annotation's ID.
 */
export function normalizeAnchor(anns: Annotation[], anchor: TextAnchor): Annotation[] {
  const mine = anns.filter((a) => sameKey(a, anchor))
  if (mine.length === 0) return []
  const sorted = [...mine].sort((a, b) => tgt(a)!.start - tgt(b)!.start || (a.createdAt - b.createdAt))
  const out: Annotation[] = []
  for (const a of sorted) {
    if (out.length === 0) { out.push(a); continue }
    const last = out[out.length - 1]
    const ta = tgt(a)!, tl = tgt(last)!
    const s = ta.start, e = ta.end
    // overlap or adjacency
    if (s <= tl.end) {
      const newStart = Math.min(tl.start, s)
      const newEnd = Math.max(tl.end, e)
      const mergedTarget: TextAnnotationTarget = { ...tl, start: newStart, end: newEnd, quote: { ...tl.quote } }
      out[out.length - 1] = { ...last, target: mergedTarget, updatedAt: Date.now() }
      mergedTarget.quote = rebuildQuote('', newStart, newEnd) // caller re-quotes with canonical
    } else out.push(a)
  }
  return out
}

/**
 * Toggle a [start,end) interval over one anchor within a canonical text.
 * Returns { keep, add } where keep are normalized surviving annotations (fully same anchor) and add are new annotations to insert.
 * Rule: if the interval is fully covered by existing coverage -> subtract (split), otherwise union (add, merging overlaps).
 */
export function toggleWithin(canonical: string, conversationId: string, messageId: string, anchor: TextAnchor, start: number, end: number, existing: Annotation[]): { remove: Annotation[]; keep: Annotation[]; add: Annotation[] } {
  const anchorAnns = existing.filter((a) => sameKey(a, anchor))
  const covered = isCoveredBy(anchorAnns, start, end)
  const requote2 = (a: Annotation): Annotation => { const t = tgt(a)!; return { ...a, target: { ...t, quote: rebuildQuote(canonical, t.start, t.end) } } }
  if (covered) {
    const keep: Annotation[] = []
    const remove: Annotation[] = []
    for (const a of anchorAnns) {
      const t = tgt(a)!
      const as = t.start, ae = t.end
      if (start <= as && ae <= end) { remove.push(a); continue }
      if (as < start) keep.push({ ...a, target: { ...t, start: as, end: start }, updatedAt: Date.now() })
      if (ae > end) keep.push({ ...a, id: newStableId(), target: { ...t, start: end, end: ae }, updatedAt: Date.now() })
      remove.push(a)
    }
    return { remove, keep: normalizeAnchor(keep, anchor).map(requote2), add: [] }
  }
  const merged = normalizeAnchor([...anchorAnns, makeAnnotation(conversationId, messageId, anchor, canonical, start, end)], anchor).map(requote2)
  const mergedIds = new Set(merged.map((m) => m.id))
  const remove = anchorAnns.filter((a) => !mergedIds.has(a.id))
  const nonAnchor = existing.filter((a) => !sameKey(a, anchor))
  return { remove, keep: [...nonAnchor, ...merged], add: [] }
}

function isCoveredBy(anns: Annotation[], start: number, end: number): boolean {
  if (anns.length === 0) return false
  const sorted = [...anns].sort((a, b) => tgt(a)!.start - tgt(b)!.start)
  let cur = start
  for (const a of sorted) {
    const t = tgt(a)!
    if (t.start > cur) return false
    cur = Math.max(cur, t.end)
    if (cur >= end) return true
  }
  return cur >= end
}
export function shouldToggleAll(segs: { anchor: TextAnchor; start: number; end: number }[], existing: Annotation[]): 'add' | 'remove' {
  const allCovered = segs.every((seg) => isCoveredBy(existing.filter((a) => sameKey(a, seg.anchor)), seg.start, seg.end))
  return allCovered ? 'remove' : 'add'
}
function requote(a: Annotation, canonical: string): Annotation { const t = tgt(a)!; return { ...a, target: { ...t, quote: rebuildQuote(canonical, t.start, t.end) } } }

/** Normalize two cell points (any drag direction) into a closed rectangle bounds. */
export function normalizeBounds(ar: number, ac: number, br: number, bc: number): TableBounds {
  return { rowStart: Math.min(ar, br), rowEnd: Math.max(ar, br), columnStart: Math.min(ac, bc), columnEnd: Math.max(ac, bc) }
}
export function sameBounds(a: TableBounds, b: TableBounds): boolean {
  return a.rowStart === b.rowStart && a.rowEnd === b.rowEnd && a.columnStart === b.columnStart && a.columnEnd === b.columnEnd
}
export function boundsCoverCell(b: TableBounds, row: number, col: number): boolean {
  return row >= b.rowStart && row <= b.rowEnd && col >= b.columnStart && col <= b.columnEnd
}

/** table-cells toggle: exact duplicate rectangle -> remove; otherwise create (partial overlap coexists, no 2D merge/split). */
export function toggleTableCells(conversationId: string, messageId: string, tableId: string, bounds: TableBounds, existing: Annotation[]): { remove: Annotation[]; keep: Annotation[]; add: Annotation[] } {
  const mine = existing.filter((a) => a.target.type === 'table-cells' && a.target.tableId === tableId)
  const dup = mine.find((a) => a.target.type === 'table-cells' && sameBounds(a.target.bounds, bounds))
  if (dup) return { remove: [dup], keep: existing.filter((a) => a.id !== dup.id), add: [] }
  const now = Date.now()
  const newAnn: Annotation = { id: newStableId(), conversationId, messageId, target: { type: 'table-cells', tableId, bounds }, createdAt: now, updatedAt: now, version: 1 }
  return { remove: [], keep: [...existing, newAnn], add: [newAnn] }
}

/** whole-table toggle: at most one per table; add or remove. */
export function toggleWholeTable(conversationId: string, messageId: string, tableId: string, existing: Annotation[]): { remove: Annotation[]; keep: Annotation[]; add: Annotation[] } {
  const existingTable = existing.find((a) => a.target.type === 'table' && a.target.tableId === tableId)
  if (existingTable) return { remove: [existingTable], keep: existing.filter((a) => a.id !== existingTable.id), add: [] }
  const now = Date.now()
  const newAnn: Annotation = { id: newStableId(), conversationId, messageId, target: { type: 'table', tableId }, createdAt: now, updatedAt: now, version: 1 }
  return { remove: [], keep: [...existing, newAnn], add: [newAnn] }
}

/** whole-formula toggle: at most one per mathId; add or remove. */
export function toggleMath(conversationId: string, messageId: string, mathId: string, mathKind: 'inline' | 'block', existing: Annotation[]): { remove: Annotation[]; keep: Annotation[]; add: Annotation[] } {
  const ext = existing.find((a) => a.target.type === 'math' && a.target.mathId === mathId)
  if (ext) return { remove: [ext], keep: existing.filter((a) => a.id !== ext.id), add: [] }
  const now = Date.now()
  const newAnn: Annotation = { id: newStableId(), conversationId, messageId, target: { type: 'math', mathId, mathKind }, createdAt: now, updatedAt: now, version: 1 }
  return { remove: [], keep: [...existing, newAnn], add: [newAnn] }
}
/** Whether a whole-formula annotation exists for a mathId. */
export function hasMath(existing: Annotation[], mathId: string): boolean { return existing.some((a) => a.target.type === 'math' && a.target.mathId === mathId) }

/** Whether a whole-table annotation exists for a given table. */
export function hasWholeTable(existing: Annotation[], tableId: string): boolean { return existing.some((a) => a.target.type === 'table' && a.target.tableId === tableId) }
/** Whether a rectangle annotation equals the given bounds. */
export function hasExactRectangle(existing: Annotation[], tableId: string, bounds: TableBounds): boolean { return existing.some((a) => a.target.type === 'table-cells' && a.target.tableId === tableId && sameBounds(a.target.bounds, bounds)) }
/** Whether a rectangle annotation covers a cell. */
export function rectangleCoversCell(existing: Annotation[], tableId: string, row: number, col: number): boolean { return existing.some((a) => a.target.type === 'table-cells' && a.target.tableId === tableId && boundsCoverCell(a.target.bounds, row, col)) }

