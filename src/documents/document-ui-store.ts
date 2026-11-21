// Document domain UI state (Stage 9.2B1): closed | library | reader are MUTUALLY
// EXCLUSIVE overlays. Kept in its own store — the document domain must never be
// stuffed into gallery-store / ui-store / sessions-store.
import { useSyncExternalStore } from 'react'

export type DocumentUiState =
  | { view: 'closed' }
  | { view: 'library'; projectId?: string; importFile?: File }
  | { view: 'reader'; documentId: string; pageNumber?: number; requestId: number; projectId?: string }

let s: DocumentUiState = { view: 'closed' }
let readerRequestId = 0
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useDocumentUi<T>(sel: (s: DocumentUiState) => T): T {
  return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s))
}
export const documentUiActions = {
  openLibrary(projectId?: string) { s = projectId ? { view: 'library', projectId } : { view: 'library' }; notify() },
  importPdf(file: File) { s = { view: 'library', importFile: file }; notify() },
  acceptImport(file: File) {
    if (s.view !== 'library' || s.importFile !== file) return false
    s = { view: 'library' }
    notify()
    return true
  },
  openReader(documentId: string, pageNumber?: number, projectId?: string) {
    readerRequestId += 1
    s = { view: 'reader', documentId, ...(Number.isInteger(pageNumber) && pageNumber! > 0 ? { pageNumber } : {}), requestId: readerRequestId, ...(projectId ? { projectId } : {}) }
    notify()
  },
  backToLibrary(projectId?: string) { documentUiActions.openLibrary(projectId) },
  close() { s = { view: 'closed' }; notify() },
}
/** Read-only snapshot for tests / non-hook consumers. */
export function getDocumentUiState(): DocumentUiState { return s }
export { useDocumentUi }
