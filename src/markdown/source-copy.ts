// Source-aware copying for rendered Markdown. The renderer records source ranges on
// leaves and formatting containers; this module turns a DOM selection back into the
// corresponding slice of the original model response.

type SourceRange = { start: number; end: number }

function sourceRangeOf(element: Element): SourceRange | null {
  const start = Number(element.getAttribute('data-source-start'))
  const end = Number(element.getAttribute('data-source-end'))
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null
  return { start, end }
}

function containsBoundary(element: Element, node: Node): boolean {
  return node === element || element.contains(node)
}

/** Visible-text offsets selected inside an element. Boundaries outside it clamp to its ends. */
function selectedTextOffsets(range: Range, element: Element): { start: number; end: number } {
  const length = element.textContent?.length ?? 0
  let start = 0
  let end = length
  if (containsBoundary(element, range.startContainer)) {
    const prefix = document.createRange()
    prefix.selectNodeContents(element)
    try {
      prefix.setEnd(range.startContainer, range.startOffset)
      start = prefix.toString().length
    } catch { start = 0 }
  }
  if (containsBoundary(element, range.endContainer)) {
    const prefix = document.createRange()
    prefix.selectNodeContents(element)
    try {
      prefix.setEnd(range.endContainer, range.endOffset)
      end = prefix.toString().length
    } catch { end = length }
  }
  return { start: Math.max(0, Math.min(length, start)), end: Math.max(0, Math.min(length, end)) }
}

function fullySelected(range: Range, element: Element): boolean {
  const offsets = selectedTextOffsets(range, element)
  return offsets.start === 0 && offsets.end === (element.textContent?.length ?? 0)
}

function intersects(range: Range, element: Element): boolean {
  try { return range.intersectsNode(element) } catch { return false }
}

function mappedTextBoundary(source: string, element: Element, visibleOffset: number, edge: 'start' | 'end'): number | null {
  const bounds = sourceRangeOf(element)
  if (!bounds) return null
  const visible = element.textContent ?? ''
  const raw = source.slice(bounds.start, bounds.end)
  if (visibleOffset <= 0) return bounds.start
  if (visibleOffset >= visible.length) return bounds.end
  // Normal mdast text leaves are byte-for-byte source slices. If Markdown escaping or
  // entity decoding made them differ, snap to the leaf edge instead of returning a
  // corrupt half escape/entity.
  if (raw !== visible) return edge === 'start' ? bounds.start : bounds.end
  return bounds.start + visibleOffset
}

function expandThroughFullySelectedContainers(range: Range, leaf: Element, root: Element, edge: 'start' | 'end', initial: number): number {
  let result = initial
  let current = leaf.parentElement
  while (current && current !== root) {
    if (current.hasAttribute('data-source-copy-container') && fullySelected(range, current)) {
      const bounds = sourceRangeOf(current)
      if (bounds) result = edge === 'start' ? bounds.start : bounds.end
    }
    current = current.parentElement
  }
  return result
}

/**
 * Return the original Markdown/LaTeX represented by a selection in one rendered message.
 * Returns null when the range cannot be mapped safely, allowing the browser's normal copy.
 */
export function markdownSourceForRange(root: Element, source: string, range: Range): string | null {
  if (range.collapsed || !containsBoundary(root, range.startContainer) || !containsBoundary(root, range.endContainer)) return null
  const leaves = Array.from(root.querySelectorAll<HTMLElement>('[data-source-copy-leaf]')).filter((leaf) => {
    if (!intersects(range, leaf)) return false
    const kind = leaf.getAttribute('data-source-copy-leaf')
    if (kind === 'text') {
      const offsets = selectedTextOffsets(range, leaf)
      return offsets.end > offsets.start
    }
    return true
  })
  if (leaves.length === 0) return null

  const first = leaves[0]
  const last = leaves[leaves.length - 1]
  const firstRange = sourceRangeOf(first)
  const lastRange = sourceRangeOf(last)
  if (!firstRange || !lastRange) return null

  const firstKind = first.getAttribute('data-source-copy-leaf')
  const lastKind = last.getAttribute('data-source-copy-leaf')
  const firstOffsets = selectedTextOffsets(range, first)
  const lastOffsets = selectedTextOffsets(range, last)
  let start = firstKind === 'text'
    ? mappedTextBoundary(source, first, firstOffsets.start, 'start')
    : firstRange.start
  let end = lastKind === 'text'
    ? mappedTextBoundary(source, last, lastOffsets.end, 'end')
    : lastRange.end
  if (start === null || end === null) return null

  start = expandThroughFullySelectedContainers(range, first, root, 'start', start)
  end = expandThroughFullySelectedContainers(range, last, root, 'end', end)
  if (end <= start || start < 0 || end > source.length) return null
  return source.slice(start, end)
}
