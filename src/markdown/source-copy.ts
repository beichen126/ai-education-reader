// Source-aware copying for rendered Markdown. The renderer records source ranges on
// leaves and formatting containers; this module turns a DOM selection back into the
// corresponding slice of the original model response.

type SourceRange = { start: number; end: number }

// One document listener for all mounted renderers, including user messages and cards.
// Keep source strings out of DOM attributes and release them when their renderer leaves.
const sources = new Map<Element, string>()

function copyMarkdownSelection(event: ClipboardEvent): void {
  if (event.defaultPrevented || !event.clipboardData) return
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  const roots = Array.from(sources.keys()).filter(root => root.isConnected && intersects(range, root))
    .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  // A conversation-wide selection may end on message/list containers rather than
  // text leaves. Only allow that wider boundary inside the same explicit copy scope.
  const scopeOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-markdown-copy-scope]')
  const scope = scopeOf(range.startContainer)
  const withinScope = scope && scope === scopeOf(range.endContainer) && roots.every(root => scope.contains(root))
  const insideRoots = roots.some(root => containsBoundary(root, range.startContainer)) && roots.some(root => containsBoundary(root, range.endContainer))
  if (!insideRoots && !withinScope) return
  const parts: string[] = []
  for (const root of roots) {
    const local = document.createRange()
    local.selectNodeContents(root)
    const full = local.cloneRange()
    if (containsBoundary(root, range.startContainer)) local.setStart(range.startContainer, range.startOffset)
    if (containsBoundary(root, range.endContainer)) local.setEnd(range.endContainer, range.endOffset)
    if (local.collapsed) continue
    const source = sources.get(root)!
    const mapped = markdownSourceForRange(root, source, local)
    // A completely selected renderer must preserve even source-only Markdown.
    const whole = local.compareBoundaryPoints(Range.START_TO_START, full) === 0
      && local.compareBoundaryPoints(Range.END_TO_END, full) === 0
    if (whole) parts.push(source)
    else if (mapped !== null) parts.push(mapped)
    else if (local.toString().trim()) return // Never silently drop an unmappable selected passage.
  }
  if (!parts.length) return
  const source = parts.join('\n\n')
  try {
    event.clipboardData.setData('text/plain', source)
    try { event.clipboardData.setData('text/markdown', source) } catch {}
    event.preventDefault()
  } catch { /* Preserve native copy when clipboard access is unavailable. */ }
}

export function registerMarkdownSource(root: Element, source: string): () => void {
  if (!sources.size) document.addEventListener('copy', copyMarkdownSelection)
  sources.set(root, source)
  return () => {
    sources.delete(root)
    if (!sources.size) document.removeEventListener('copy', copyMarkdownSelection)
  }
}

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
