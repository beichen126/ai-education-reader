function supported(): boolean { return typeof window !== 'undefined' && ('Highlight' in window) && !!CSS.highlights }
export function highlightSupported(): boolean { return supported() }
const perMessage = new Map<string, Range[]>()
function rebuild() {
  if (!supported()) return
  const all: Range[] = []
  perMessage.forEach((rs) => all.push(...rs))
  if (all.length) CSS.highlights.set('study-highlight', new (window as any).Highlight(...all))
  else CSS.highlights.delete('study-highlight')
}
export function setMessageRanges(messageId: string, ranges: Range[]): void { perMessage.set(messageId, ranges); rebuild() }
export function removeMessageRanges(messageId: string): void { perMessage.delete(messageId); rebuild() }
export function clearAllRanges(): void { perMessage.clear(); rebuild() }