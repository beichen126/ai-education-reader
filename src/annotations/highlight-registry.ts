function supported(): boolean { return typeof window !== 'undefined' && ('Highlight' in window) && !!CSS.highlights }
export function highlightSupported(): boolean { return supported() }
const perMessage = new Map<string, Range[]>()
let rebuildQueued = false
function rebuild() {
  if (!supported()) return
  const all: Range[] = []
  perMessage.forEach((rs) => all.push(...rs))
  if (all.length) CSS.highlights.set('study-highlight', new (window as any).Highlight(...all))
  else CSS.highlights.delete('study-highlight')
}
function queueRebuild(): void {
  if (rebuildQueued) return
  rebuildQueued = true
  queueMicrotask(() => { rebuildQueued = false; rebuild() })
}
export function setMessageRanges(messageId: string, ranges: Range[]): void { perMessage.set(messageId, ranges); queueRebuild() }
export function removeMessageRanges(messageId: string): void { perMessage.delete(messageId); queueRebuild() }
export function clearAllRanges(): void { perMessage.clear(); queueRebuild() }
