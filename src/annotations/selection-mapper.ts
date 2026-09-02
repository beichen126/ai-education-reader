
import { ANCHOR_CONTEXT, type SelectionMapping, type TextSelectionSegment } from './selection-types'
import type { BlockModel } from '../markdown/block-layer'

type Leaf = { el: Element; node: Node; len: number; canonicalStart: number; canonicalEnd: number; blockId: string; blockType: string; annotatable: boolean; tableId?: string; row?: number; col?: number }

function closestAttr(el: Element | null, attr: string): string | undefined {
  for (let e = el; e; e = e.parentElement) { const v = e.getAttribute(attr); if (v != null && v !== '') return v }
  return undefined
}
function closestNum(el: Element | null, attr: string): number | undefined { const v = closestAttr(el, attr); return v == null ? undefined : Number(v) }

function collectLeaves(root: Element): Leaf[] {
  const leaves: Leaf[] = []
  const els = root.querySelectorAll('[data-canonical-start]')
  els.forEach((el) => {
    const cs = Number(el.getAttribute('data-canonical-start')) || 0
    const ce = Number(el.getAttribute('data-canonical-end')) || cs
    const blockId = closestAttr(el, 'data-block-id') || ''
    const blockType = closestAttr(el, 'data-block-type') || ''
    const annotAttr = closestAttr(el, 'data-annotatable')
    const annotatable = annotAttr !== 'false'
    const tableId = closestAttr(el, 'data-table-id')
    const row = closestNum(el, 'data-row')
    const col = closestNum(el, 'data-col')
    const node: Node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : el
    const len = node.nodeType === 3 ? (node.textContent || '').length : 1
    leaves.push({ el, node, len, canonicalStart: cs, canonicalEnd: ce, blockId, blockType, annotatable, tableId, row, col })
  })
  return leaves
}

function messageOf(node: Node): string | undefined {
  for (let e: Element | null = node.nodeType === 3 ? node.parentElement : (node as Element); e; e = e.parentElement) {
    const v = e.getAttribute && e.getAttribute('data-message-id'); if (v) return v
  }
  return undefined
}

/** Overlap of a leaf with a range: canonical sub-range [lo,hi] within the leaf, or null if not intersected. */
function overlap(range: Range, leaf: Leaf): { lo: number; hi: number } | null {
  const node = leaf.node
  if (node.nodeType === 3) {
    const a = range.comparePoint(node, 0)
    const b = range.comparePoint(node, leaf.len)
    if (a === 1 || b === -1) return null
    let lo = 0, hi = leaf.len
    if (a === -1) lo = range.startContainer === node ? range.startOffset : 0
    if (b === 1) hi = range.endContainer === node ? range.endOffset : leaf.len
    if (lo >= hi) return null
    return { lo, hi }
  }
  // element leaf (e.g. <br> with a single canonical unit)
  const c = range.comparePoint(node, 0)
  if (c !== 0) return null
  return { lo: 0, hi: 1 }
}

function blockIndex(blockId: string, tableId?: string, row?: number, col?: number): string {
  return tableId != null && row != null && col != null ? 'T:' + tableId + ':' + row + ':' + col : 'B:' + blockId
}

export function mapSelection(root: Element, messageId: string, range: Range, getBlock?: (id: string) => BlockModel | undefined): SelectionMapping {
  const rootMsg = root.getAttribute('data-message-id')
  if (!rootMsg || rootMsg !== messageId) return { kind: 'unsupported', reason: 'not-in-message' }
  if (range.collapsed) return { kind: 'unsupported', reason: 'collapsed' }
  // message boundary
  const sm = messageOf(range.startContainer), em = messageOf(range.endContainer)
  if (sm !== messageId || em !== messageId) return { kind: 'unsupported', reason: 'cross-message' }
  // code block rejected (V1 selection must not pass through or sit in code)
  const anyCode = Array.from(root.querySelectorAll('[data-annotatable="false"]:not([data-math-id])')).some((el) => range.intersectsNode(el))
  if (anyCode) return { kind: 'unsupported', reason: 'code-block' }
  const leaves = collectLeaves(root)
  if (leaves.length === 0) return { kind: 'unsupported', reason: 'no-annotatable-content' }
  type Hit = { leaf: Leaf; lo: number; hi: number; cs: number; ce: number; ord: number }
  const hits: Hit[] = []
  let ord = 0
  for (const leaf of leaves) {
    const o = overlap(range, leaf)
    if (o) {
      const cs = leaf.canonicalStart + o.lo
      const ce = leaf.canonicalStart + o.hi
      if (ce > cs) hits.push({ leaf, lo: o.lo, hi: o.hi, cs, ce, ord: ord++ })
    }
  }
  if (hits.length === 0) return { kind: 'unsupported', reason: 'empty' }
  // group by block/cell, preserve DOM order
  const groups = new Map<string, { ord: number; leaf: Leaf; start: number; end: number }>()
  for (const h of hits) {
    const key = blockIndex(h.leaf.blockId, h.leaf.tableId, h.leaf.row, h.leaf.col)
    const g = groups.get(key)
    if (!g) groups.set(key, { ord: h.ord, leaf: h.leaf, start: h.cs, end: h.ce })
    else { g.start = Math.min(g.start, h.cs); g.end = Math.max(g.end, h.ce) }
  }
  const items = [...groups.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => a.ord - b.ord)
  const hasTable = items.some((i) => i.key.startsWith('T:'))
  const allTable = items.every((i) => i.key.startsWith('T:'))
  // any table leaf with a non-annotatable block? trust annotatable flag already filtered (code rejected above)
  // text mixed into table / table into text -> unsupported
  if (hasTable && !allTable) return { kind: 'unsupported', reason: 'text-into-table' }
  if (allTable) {
    const cells = items.map((i) => { const t = i.key.split(':'); return { tableId: t[1], row: Number(t[2]), column: Number(t[3]) } })
    const first = cells[0], last = cells[cells.length - 1]
    if (first.row === last.row && first.column === last.column) {
      // same cell -> text segment with cell canonical
      const leaf = items[0].leaf
      const block = leaf.blockId ? getBlock?.(leaf.blockId) : undefined
      const cellText = block && block.table ? block.table.cells.find(x => x.row === first.row && x.col === first.column)?.canonicalText : undefined
      const text = cellText ?? ''
      const start = items[0].start, end = items[0].end
      if (start >= end) return { kind: 'unsupported', reason: 'empty' }
      return { kind: 'text', segments: [{ messageId, blockId: leaf.blockId, blockType: 'table', cell: { tableId: first.tableId, row: first.row, column: first.column }, start, end, exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start), suffix: text.slice(end, end + ANCHOR_CONTEXT) }] }
    }
    return { kind: 'table-cross-cell', tableId: first.tableId, startCell: { row: first.row, column: first.column }, endCell: { row: last.row, column: last.column } }
  }
  // text segments across one or more blocks
  const segments: TextSelectionSegment[] = []
  for (const item of items) {
    if (item.start >= item.end) continue
    const block = item.leaf.blockId ? getBlock?.(item.leaf.blockId) : undefined
    const text = block ? block.canonicalText : ''
    segments.push({ messageId, blockId: item.leaf.blockId, blockType: item.leaf.blockType, start: item.start, end: item.end, exact: text.slice(item.start, item.end), prefix: text.slice(Math.max(0, item.start - ANCHOR_CONTEXT), item.start), suffix: text.slice(item.end, item.end + ANCHOR_CONTEXT) })
  }
  if (segments.length === 0) return { kind: 'unsupported', reason: 'empty' }
  return { kind: 'text', segments }
}
