import { useSyncExternalStore } from 'react'
import { loadMessageAnnotations, toggleTextSelection, toggleTableCellsAnnotation, toggleWholeTableAnnotation, toggleMathAnnotation, deleteConvAnnotations } from './annotation-service'
import type { Annotation } from './annotation-types'
import type { TextAnchor } from './annotation-types'
import type { TextSelectionSegment } from './selection-types'
import type { TableBounds } from './annotation-types'

const key = (c: string, m: string) => c + '::' + m
const EMPTY: Annotation[] = []
const cache = new Map<string, Annotation[]>()
const subs = new Set<() => void>()
function notify() { subs.forEach((f) => f()) }
function getSnapshot(c: string, m: string): Annotation[] { const v = cache.get(key(c, m)); return v === undefined ? EMPTY : v }
export function useMessageAnnotations(conversationId: string, messageId: string): Annotation[] {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => getSnapshot(conversationId, messageId))
}
export async function refreshMessageAnnotations(conversationId: string, messageId: string): Promise<void> { cache.set(key(conversationId, messageId), await loadMessageAnnotations(conversationId, messageId)); notify() }
export async function toggleMessageSelection(conversationId: string, messageId: string, segments: TextSelectionSegment[], canonicalOf: (a: TextAnchor) => string): Promise<void> {
  cache.set(key(conversationId, messageId), await toggleTextSelection(conversationId, messageId, segments, canonicalOf)); notify()
}
export function setMessageAnnotations(conversationId: string, messageId: string, anns: Annotation[]): void { cache.set(key(conversationId, messageId), anns); notify() }
export function dropMessageAnnotations(conversationId: string, messageId: string): void { cache.delete(key(conversationId, messageId)); notify() }
export function clearAnnotationCache(): void { cache.clear(); notify() }
export { deleteConvAnnotations }
export async function toggleTableCellsMessage(conversationId: string, messageId: string, tableId: string, bounds: TableBounds): Promise<void> {
  cache.set(key(conversationId, messageId), await toggleTableCellsAnnotation(conversationId, messageId, tableId, bounds)); notify()
}
export async function toggleWholeTableMessage(conversationId: string, messageId: string, tableId: string): Promise<void> {
  cache.set(key(conversationId, messageId), await toggleWholeTableAnnotation(conversationId, messageId, tableId)); notify()
}
export async function toggleMathMessage(conversationId: string, messageId: string, mathId: string, mathKind: 'inline' | 'block'): Promise<void> {
  cache.set(key(conversationId, messageId), await toggleMathAnnotation(conversationId, messageId, mathId, mathKind)); notify()
}
