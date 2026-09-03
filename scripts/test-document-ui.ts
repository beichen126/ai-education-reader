// Stage 9.2B1: Document summaries, UI store transitions, ghost-cleanup contract.
import 'fake-indexeddb/auto'
import { createDocument, deleteDocument, listDocumentSummaries, cleanupStaleDocument, toDocumentSummary, DocumentNotFoundError, updateLastReadPage, updateDocumentChapters } from '../src/documents/document-service.ts'
import { documentUiActions, getDocumentUiState } from '../src/documents/document-ui-store.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import type { LearningDocument } from '../src/documents/document-types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const pdfBlob = (n: number) => new Blob([new Uint8Array(n).fill(3)], { type: 'application/pdf' })

await idbClearAll()
const base = (id: string, name: string, updatedAt: number, chapters: LearningDocument['chapters'] = [], lastReadPage = 0) => ({
  id, kind: 'pdf' as const, fileName: name, mimeType: 'application/pdf' as const, fileSize: 100,
  pageCount: 42, sourceBlob: pdfBlob(100), chapters, chapterSource: (chapters.length ? 'native' : 'none') as LearningDocument['chapterSource'],
  lastReadPage, createdAt: 1, updatedAt,
})
const t1 = base('d1', '旧教材.pdf', 100)
const t2 = base('d2', '新教材.pdf', 200, [{ id: '0', title: '第 1 章', level: 1, startPage: 1, endPage: 5, selectable: true, source: 'native', children: [{ id: '0.0', title: '1.1', level: 2, startPage: 1, endPage: 2, selectable: true, source: 'native', children: [] }] }], 7)
await createDocument({ id: t1.id, fileName: t1.fileName, mimeType: 'application/pdf', fileSize: 100, pageCount: 42, sourceBlob: pdfBlob(100) })
await createDocument({ id: t2.id, fileName: t2.fileName, mimeType: 'application/pdf', fileSize: 100, pageCount: 42, sourceBlob: pdfBlob(100) })
await updateDocumentChapters(t2.id, t2.chapters, 'native')
await new Promise(r => setTimeout(r, 2))

// --- summaries: no sourceBlob, chapterCount, updatedAt DESC ---
const sums = await listDocumentSummaries()
assert(sums.length === 2 && sums[0].id === 'd2', 'summaries sorted updatedAt DESC')
assert(sums[0].chapterCount === 2 && sums[0].chapterSource === 'native', 'chapterCount counts the tree (2, incl. child)')
assert(sums[0].lastReadPage === 0 && sums[1].lastReadPage === 0, 'unread -> lastReadPage 0 in summary')
assert(!('sourceBlob' in (sums[0] as any)), 'summary NEVER exposes sourceBlob')
assert(!('chapters' in (sums[0] as any)), 'summary never exposes the full chapter tree')
const doc = await (await import('../src/documents/document-service.ts')).getDocument('d1')
assert(!!doc && (toDocumentSummary(doc!).sourceBlob === undefined), 'toDocumentSummary strips blob')
assert(toDocumentSummary(doc!).chapterCount === 0, 'toDocumentSummary chapterCount 0 for no chapters')

// --- UI store transitions: closed -> library -> reader -> library -> closed ---
assert(getDocumentUiState().view === 'closed', 'ui: starts closed')
documentUiActions.openLibrary()
assert(getDocumentUiState().view === 'library', 'ui: openLibrary')
documentUiActions.openReader('d1')
assert(getDocumentUiState().view === 'reader' && (getDocumentUiState() as any).documentId === 'd1', 'ui: openReader carries id')
documentUiActions.backToLibrary()
assert(getDocumentUiState().view === 'library', 'ui: reader -> library')
documentUiActions.close()
assert(getDocumentUiState().view === 'closed', 'ui: close')

// --- ghost cleanup contract (canceled import) ---
await createDocument({ id: 'ghost1', fileName: 'ghost.pdf', mimeType: 'application/pdf', fileSize: 5, pageCount: 1, sourceBlob: pdfBlob(5) })
await cleanupStaleDocument('ghost1')
assert((await (await import('../src/documents/document-service.ts')).getDocument('ghost1')) === undefined, 'cleanupStaleDocument removes the superseded row (no ghost)')
// a REAL import keeps its document: delete only removes the target
await createDocument({ id: 'keep1', fileName: 'keep.pdf', mimeType: 'application/pdf', fileSize: 5, pageCount: 1, sourceBlob: pdfBlob(5) })
await deleteDocument('keep1')
assert((await (await import('../src/documents/document-service.ts')).getDocument('keep1')) === undefined, 'explicit delete only removes the targeted document')

// --- REAL contract: missing document -> DocumentNotFoundError (not generic Error) ---
let notFound = false
try { await updateLastReadPage('nope-' + Math.random(), 1) } catch (e) { notFound = e instanceof DocumentNotFoundError && e.name === 'DocumentNotFoundError' }
assert(notFound, 'missing document surfaces DocumentNotFoundError (real contract)')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
