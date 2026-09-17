import { useCallback, useSyncExternalStore } from 'react'
import { loadMessageAnnotations, toggleTextSelection, toggleTableCellsAnnotation, toggleWholeTableAnnotation, toggleMathAnnotation, deleteConvAnnotations as deletePersistedConversationAnnotations } from './annotation-service'
import type { Annotation } from './annotation-types'
import type { TextAnchor } from './annotation-types'
import type { TextSelectionSegment } from './selection-types'
import type { TableBounds } from './annotation-types'

const key = (c: string, m: string) => c + '::' + m
const EMPTY: Annotation[] = []
const cache = new Map<string, Annotation[]>()
const subs = new Map<string, Set<() => void>>()
function notify(cacheKey: string) { subs.get(cacheKey)?.forEach((f) => f()) }
function getSnapshot(c: string, m: string): Annotation[] { const v = cache.get(key(c, m)); return v === undefined ? EMPTY : v }
export function useMessageAnnotations(conversationId: string, messageId: string): Annotation[] {
  const cacheKey = key(conversationId, messageId)
  const subscribe = useCallback((fn: () => void) => {
    let listeners = subs.get(cacheKey)
    if (!listeners) { listeners = new Set(); subs.set(cacheKey, listeners) }
    listeners.add(fn)
    return () => {
      listeners!.delete(fn)
      if (listeners!.size === 0) { subs.delete(cacheKey); cache.delete(cacheKey) }
    }
  }, [cacheKey])
  return useSyncExternalStore(subscribe, () => getSnapshot(conversationId, messageId))
}
export async function refreshMessageAnnotations(conversationId: string, messageId: string): Promise<void> {
  const cacheKey = key(conversationId, messageId)
  const annotations = await loadMessageAnnotations(conversationId, messageId)
  // A long conversation can unmount/recycle messages while IndexedDB is still
  // reading. Do not let a late result repopulate an otherwise bounded cache.
  if (!subs.has(cacheKey)) return
  cache.set(cacheKey, annotations)
  notify(cacheKey)
}
export async function toggleMessageSelection(conversationId: string, messageId: string, segments: TextSelectionSegment[], canonicalOf: (a: TextAnchor) => string, branchId?: string): Promise<void> {
  const cacheKey = key(conversationId, messageId); cache.set(cacheKey, await toggleTextSelection(conversationId, messageId, segments, canonicalOf, branchId)); notify(cacheKey)
}
export function setMessageAnnotations(conversationId: string, messageId: string, anns: Annotation[]): void { const cacheKey = key(conversationId, messageId); cache.set(cacheKey, anns); notify(cacheKey) }
export function dropMessageAnnotations(conversationId: string, messageId: string): void { const cacheKey = key(conversationId, messageId); cache.delete(cacheKey); notify(cacheKey) }
export function clearAnnotationCache(): void { cache.clear(); for (const listeners of subs.values()) listeners.forEach(fn => fn()) }
export async function deleteConvAnnotations(conversationId: string): Promise<void> {
  await deletePersistedConversationAnnotations(conversationId)
  const prefix = conversationId + '::'
  for (const cacheKey of [...cache.keys()]) {
    if (cacheKey.startsWith(prefix)) { cache.delete(cacheKey); notify(cacheKey) }
  }
}
export async function toggleTableCellsMessage(conversationId: string, messageId: string, tableId: string, bounds: TableBounds, branchId?: string): Promise<void> {
  const cacheKey = key(conversationId, messageId); cache.set(cacheKey, await toggleTableCellsAnnotation(conversationId, messageId, tableId, bounds, branchId)); notify(cacheKey)
}
export async function toggleWholeTableMessage(conversationId: string, messageId: string, tableId: string, branchId?: string): Promise<void> {
  const cacheKey = key(conversationId, messageId); cache.set(cacheKey, await toggleWholeTableAnnotation(conversationId, messageId, tableId, branchId)); notify(cacheKey)
}
export async function toggleMathMessage(conversationId: string, messageId: string, mathId: string, mathKind: 'inline' | 'block', branchId?: string): Promise<void> {
  const cacheKey = key(conversationId, messageId); cache.set(cacheKey, await toggleMathAnnotation(conversationId, messageId, mathId, mathKind, branchId)); notify(cacheKey)
}
