// Document domain UI state (Stage 9.2B1): closed | library | reader are MUTUALLY
// EXCLUSIVE overlays. Kept in its own store — the document domain must never be
// stuffed into gallery-store / ui-store / sessions-store.
import { useSyncExternalStore } from 'react'

export type DocumentUiState =
  | { view: 'closed' }
  | { view: 'library' }
  | { view: 'reader'; documentId: string }

let s: DocumentUiState = { view: 'closed' }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useDocumentUi<T>(sel: (s: DocumentUiState) => T): T {
  return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s))
}
export const documentUiActions = {
  openLibrary() { s = { view: 'library' }; notify() },
  openReader(documentId: string) { s = { view: 'reader', documentId }; notify() },
  backToLibrary() { s = { view: 'library' }; notify() },
  close() { s = { view: 'closed' }; notify() },
}
/** Read-only snapshot for tests / non-hook consumers. */
export function getDocumentUiState(): DocumentUiState { return s }
export { useDocumentUi }
