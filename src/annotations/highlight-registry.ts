function supported(): boolean { return typeof window !== 'undefined' && ('Highlight' in window) && !!CSS.highlights }
export function highlightSupported(): boolean { return supported() }
const perMessage = new Map<string, Range[]>()
const spokenSelections = new Map<string, Range[]>()
let rebuildQueued = false
function rebuild() {
  if (!supported()) return
  const all: Range[] = []
  perMessage.forEach((rs) => all.push(...rs))
  if (all.length) CSS.highlights.set('study-highlight', new (window as any).Highlight(...all))
  else CSS.highlights.delete('study-highlight')
  const spoken = [...spokenSelections.values()].flat()
  if (spoken.length) CSS.highlights.set('spoken-selection', new (window as any).Highlight(...spoken))
  else CSS.highlights.delete('spoken-selection')
}
function queueRebuild(): void {
  if (rebuildQueued) return
  rebuildQueued = true
  queueMicrotask(() => { rebuildQueued = false; rebuild() })
}
export function setMessageRanges(messageId: string, ranges: Range[]): void { perMessage.set(messageId, ranges); queueRebuild() }
export function removeMessageRanges(messageId: string): void { perMessage.delete(messageId); queueRebuild() }
export function clearAllRanges(): void { perMessage.clear(); queueRebuild() }
export function setSpokenSelectionRanges(owner: string, ranges: Range[]): void {
  if (ranges.length) spokenSelections.set(owner, ranges)
  else spokenSelections.delete(owner)
  queueRebuild()
}
