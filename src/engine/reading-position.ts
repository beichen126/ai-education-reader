/** Small synchronous checkpoints survive pagehide without waiting for an IDB transaction.
 * No message text is stored. Cap history so abandoned/deleted threads cannot grow forever. */
export const READING_POSITIONS_KEY = 'ai-reader:reading-positions:v1'
export type ReadingPosition = {
  messageId: string; offset: number; scrollTop: number; atBottom: boolean; updatedAt: number
}
type Positions = Record<string, ReadingPosition>
let epoch=0
export function readingPositionEpoch(): number {return epoch}
export function readingPositionKey(conversationId: string, branchId?: string): string {
  return JSON.stringify([conversationId, branchId ?? null])
}
export function validReadingPosition(value: unknown): value is ReadingPosition {
  const p = value as ReadingPosition | null
  return !!p && typeof p.messageId === 'string' && p.messageId.length <= 512
    && Number.isFinite(p.offset) && Number.isFinite(p.scrollTop) && p.scrollTop >= 0
    && typeof p.atBottom === 'boolean' && Number.isFinite(p.updatedAt) && p.updatedAt >= 0
}
function readPositions(): Positions {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_POSITIONS_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string,ReadingPosition] => validReadingPosition(entry[1])))
  } catch { return {} }
}
export function loadReadingPosition(key: string): ReadingPosition | undefined { return readPositions()[key] }
export function saveReadingPosition(key: string, position: ReadingPosition): void {
  if (!validReadingPosition(position)) return
  try {
    const entries = Object.entries({ ...readPositions(), [key]: position })
      .sort((a,b) => b[1].updatedAt - a[1].updatedAt).slice(0,200)
    localStorage.setItem(READING_POSITIONS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* Storage can be blocked/full; never interrupt chat or navigation. */ }
}
export function clearReadingPositions(): void {
  epoch++
  try { localStorage.removeItem(READING_POSITIONS_KEY) } catch {}
}

export function messageElements(root: HTMLElement): HTMLElement[] {
  const seen = new Set<string>()
  return Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]')).filter(el => {
    const id=el.dataset.messageId
    if (!id || seen.has(id)) return false
    seen.add(id); return true
  })
}
export function captureReadingPosition(root: HTMLElement, rows: HTMLElement[]): ReadingPosition | null {
  if (!rows.length || !root.clientHeight || !root.clientWidth || !root.isConnected) return null
  const top=root.getBoundingClientRect().top
  // Message rows are in document order. Find the row crossing the viewport top
  // with logarithmic layout reads, rather than measuring every long-chat message.
  let lo=0, hi=rows.length-1
  while(lo<hi) {
    const mid=Math.floor((lo+hi)/2)
    if(rows[mid].getBoundingClientRect().bottom<=top)lo=mid+1
    else hi=mid
  }
  const anchor=rows[lo]
  if(!anchor.isConnected)return null
  return { messageId:anchor.dataset.messageId!, offset:anchor.getBoundingClientRect().top-top,
    scrollTop:root.scrollTop, atBottom:root.scrollHeight-root.clientHeight-root.scrollTop<=60, updatedAt:Date.now() }
}
export function restoreReadingPosition(root: HTMLElement, rows: HTMLElement[], position: ReadingPosition): void {
  if(position.atBottom) {root.scrollTop=root.scrollHeight; return}
  const anchor=rows.find(row=>row.dataset.messageId===position.messageId)
  root.scrollTop=anchor ? root.scrollTop+anchor.getBoundingClientRect().top-root.getBoundingClientRect().top-position.offset : position.scrollTop
}
