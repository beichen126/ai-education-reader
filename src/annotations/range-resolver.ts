import type { TextAnnotationTarget } from './annotation-types'

type Leaf = { node: Node; br?: Element; cs: number; len: number }
function collectLeaves(scopeEl: Element): Leaf[] {
  const out: Leaf[] = []
  scopeEl.querySelectorAll('[data-canonical-start]').forEach((el) => {
    const cs = Number(el.getAttribute('data-canonical-start')) || 0
    const ce = Number(el.getAttribute('data-canonical-end')) || cs
    const n = el.firstChild
    if (n && n.nodeType === 3) out.push({ node: n, cs, len: (n.textContent || '').length })
    else if (el.tagName === 'BR') out.push({ node: el, br: el as Element, cs, len: 1 })
  })
  return out.sort((a, b) => a.cs - b.cs)
}
function boundary(leaf: Leaf, local: number): { node: Node; offset: number } {
  if (leaf.br) { const parent = leaf.br.parentElement; return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, leaf.br) + (local === 0 ? 0 : 1) } }
  return { node: leaf.node, offset: Math.max(0, local) }
}
export function resolveToRange(msgEl: Element, messageId: string, target: TextAnnotationTarget): Range | null {
  const a = target.anchor
  let scope: Element | null = null
  if (a.scope === 'block') scope = msgEl.querySelector('[data-block-id="' + a.blockId + '"]')
  else scope = msgEl.querySelector('[data-table-id="' + a.tableId + '"] td[data-row="' + a.row + '"][data-col="' + a.column + '"]')
  if (!scope) return null
  const leaves = collectLeaves(scope)
  const range = document.createRange()
  let started = false
  for (const leaf of leaves) {
    const lo = leaf.cs, hi = leaf.cs + leaf.len
    if (!started && target.start < hi && lo <= target.end) { const b = boundary(leaf, target.start - lo); range.setStart(b.node, b.offset); started = true }
    if (started && target.end <= hi && target.end > lo) { const b = boundary(leaf, target.end - lo); range.setEnd(b.node, b.offset); break }
  }
  return started ? range : null
}
/**
 * Re-anchor a text annotation by its stored quote.exact text when the offset-based
 * resolution fails or points elsewhere (e.g. the content was re-parsed so canonical
 * offsets shifted). Best-effort: searches the message text for the exact string and
 * returns a Range over it; null if the exact text is no longer present or ambiguous.
 */
export function resolveByExact(msgEl: Element, messageId: string, exact: string | undefined): Range | null {
  if (!exact) return null
  type Seg = { node: Node; start: number; end: number }
  const segs: Seg[] = []
  let acc = ''
  msgEl.querySelectorAll('[data-canonical-start]').forEach((el) => {
    const n = el.firstChild
    if (n && n.nodeType === 3) {
      const text = n.textContent || ''
      const s = acc.length
      acc += text
      segs.push({ node: n, start: s, end: s + text.length })
    }
  })
  const i = acc.indexOf(exact)
  if (i < 0) return null
  const end = i + exact.length
  let startNode: Node | null = null, startOff = 0, endNode: Node | null = null, endOff = 0
  for (const seg of segs) {
    if (!startNode && i >= seg.start && i < seg.end) { startNode = seg.node; startOff = i - seg.start }
    if (end <= seg.end && end > seg.start) { endNode = seg.node; endOff = end - seg.start }
    if (startNode && endNode) break
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  try { range.setStart(startNode, startOff); range.setEnd(endNode, endOff) } catch { return null }
  return range
}

export function rangeBox(range: Range) { return range.getBoundingClientRect() }