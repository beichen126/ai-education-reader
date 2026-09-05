// Document Library sorting (Agent B, B1). Pure + persistence helpers. The service still
// returns a deterministic default order (updatedAt DESC); the Library UI applies one of
// these keys as the user's persisted preference. All sort keys use METADATA ONLY — a sort
// never reads a PDF Blob.

export type DocumentSortKey = 'last-read' | 'last-import' | 'name-asc' | 'name-desc' | 'pages' | 'size'

export const DOCUMENT_SORT_KEYS: DocumentSortKey[] = ['last-read', 'last-import', 'name-asc', 'name-desc', 'pages', 'size']

export const DOCUMENT_SORT_LABELS: Record<DocumentSortKey, string> = {
  'last-read': '最近阅读',
  'last-import': '最近导入',
  'name-asc': '文件名 A → Z',
  'name-desc': '文件名 Z → A',
  'pages': '页数',
  'size': '文件大小',
}

/** The default preference. '最近阅读' falls back to '最近导入' for never-read docs (their
 *  lastReadAt is backfilled to createdAt/updatedAt), which matches B1. */
export const DEFAULT_DOCUMENT_SORT: DocumentSortKey = 'last-read'

export function isDocumentSortKey(v: unknown): v is DocumentSortKey {
  return typeof v === 'string' && (DOCUMENT_SORT_KEYS as string[]).includes(v)
}

/** Coerce an arbitrary persisted value into a valid sort key (never throws). */
export function sanitizeDocumentSortKey(v: unknown): DocumentSortKey {
  return isDocumentSortKey(v) ? v : DEFAULT_DOCUMENT_SORT
}

export interface SortableDocumentMeta {
  fileName: string
  fileSize: number
  pageCount: number
  lastReadAt: number
  createdAt: number
}

export function sortDocuments<T extends SortableDocumentMeta>(items: T[], key: DocumentSortKey): T[] {
  const arr = [...items]
  switch (key) {
    case 'last-read':
      return arr.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
    case 'last-import':
      return arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    case 'name-asc':
      return arr.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-Hans-CN', { numeric: true }))
    case 'name-desc':
      return arr.sort((a, b) => b.fileName.localeCompare(a.fileName, 'zh-Hans-CN', { numeric: true }))
    case 'pages':
      return arr.sort((a, b) => b.pageCount - a.pageCount)
    case 'size':
      return arr.sort((a, b) => b.fileSize - a.fileSize)
    default:
      return arr
  }
}

export const DOCUMENT_SORT_STORAGE_KEY = 'dsh:document-sort'

/** Persisted preference with a small, injectable storage seam for tests. */
export function loadSortPreference(storage: Pick<Storage, 'getItem'> = realStorage()): DocumentSortKey {
  try {
    const v = storage.getItem(DOCUMENT_SORT_STORAGE_KEY)
    return sanitizeDocumentSortKey(v)
  } catch { return DEFAULT_DOCUMENT_SORT }
}

export function saveSortPreference(key: DocumentSortKey, storage: Pick<Storage, 'setItem'> = realStorage()): void {
  try { storage.setItem(DOCUMENT_SORT_STORAGE_KEY, key) } catch { /* non-fatal */ }
}

function realStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  if (typeof localStorage !== 'undefined') return localStorage
  return { getItem: () => null, setItem: () => {} }
}
