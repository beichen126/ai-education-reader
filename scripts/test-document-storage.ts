// Stage 9.2A: Document storage (IndexedDB v4 + documents store) CRUD + blob roundtrip.
import 'fake-indexeddb/auto'
import { createDocument, getDocument, listDocuments, updateLastReadPage, deleteDocument, updateDocumentChapters } from '../src/documents/document-service.ts'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { getStorageDiagnostics } from '../src/storage/diagnostics.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const pdfBlob = (n: number) => new Blob([new Uint8Array(n).fill(5)], { type: 'application/pdf' })

// --- DB v4: documents store + index exist, legacy stores intact ---
await idbClearAll()
const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('ai-education-reader', 4); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const names = [...db.objectStoreNames]
assert(names.includes('documents'), 'documents store exists')
for (const s of ['settings', 'conversations', 'attachments', 'annotations']) assert(names.includes(s), s + ' store still exists')
const idx = db.transaction('documents', 'readonly').objectStore('documents').indexNames
assert(idx.contains('by_updatedAt'), 'documents.by_updatedAt index exists')
db.close()

// --- create / get ---
const id = newStableId()
const doc = await createDocument({ id, fileName: '教材.pdf', mimeType: 'application/pdf', fileSize: 98765, pageCount: 200, sourceBlob: pdfBlob(98765), importSource: { kind: 'pdf', originalFileName: '教材.pdf' } })
assert(doc.id === id && doc.kind === 'pdf' && doc.pageCount === 200, 'createDocument returns full model')
assert(doc.chapters.length === 0 && doc.chapterSource === 'none' && doc.lastReadPage === 0, 'defaults: no chapters, none source, unread')
assert(!!doc.importSource && doc.importSource.kind === 'pdf', 'importSource recorded')
const got = await getDocument(id)
assert(!!got && got.fileName === '教材.pdf' && got.fileSize === 98765, 'getDocument returns persisted model')

// --- blob round-trip: size/type/bytes identical ---
const gotBlob = got!.sourceBlob
assert(gotBlob.size === 98765 && gotBlob.type === 'application/pdf', 'blob size/type preserved')
const a = new Uint8Array(await gotBlob.arrayBuffer())
const b = new Uint8Array(await pdfBlob(98765).arrayBuffer())
assert(a.length === b.length && a.every((v, i) => v === b[i]), 'blob bytes identical after round-trip')

// --- list sorted by updatedAt desc ---
const id2 = newStableId()
await createDocument({ id: id2, fileName: 'b.pdf', mimeType: 'application/pdf', fileSize: 10, pageCount: 5, sourceBlob: pdfBlob(10) })
const list = await listDocuments()
assert(list.length === 2 && list[0].id === id2, 'listDocuments sorted by updatedAt desc')

// --- updateLastReadPage / updateDocumentChapters ---
await updateLastReadPage(id, 42)
const g2 = await getDocument(id)
assert(g2!.lastReadPage === 42, 'updateLastReadPage persisted')
await updateDocumentChapters(id, [{ id: '0', title: '第 1 章', level: 1, startPage: 1, endPage: 10, selectable: true, source: 'native', children: [] }], 'native')
const g3 = await getDocument(id)
assert(g3!.chapters.length === 1 && g3!.chapters[0].title === '第 1 章' && g3!.chapterSource === 'native', 'chapter tree persisted')

// --- delete ---
await deleteDocument(id2)
assert((await getDocument(id2)) === undefined, 'deleteDocument removes row')
assert((await listDocuments()).length === 1, 'list after delete = 1')

// --- diagnostics ---
const d = await getStorageDiagnostics()
assert(d.documentCount === 1 && d.documentBytes === 98765, 'diagnostics count document + bytes (got ' + d.documentCount + '/' + d.documentBytes + ')')
assert(d.totalBytes === d.attachmentBytes + d.documentBytes, 'totalBytes = attachments + documents')

// --- clear all wipes documents ---
await idbClearAll()
assert((await listDocuments()).length === 0, 'clearAll wipes documents store')

// --- reopen keeps and still works ---
const id3 = newStableId()
await createDocument({ id: id3, fileName: 'c.pdf', mimeType: 'application/pdf', fileSize: 33, pageCount: 3, sourceBlob: pdfBlob(33) })
await closeDb()
const after = await getDocument(id3)
assert(!!after && after.fileName === 'c.pdf' && after.sourceBlob.size === 33, 'document survives db reopen')

// ---- Stage 9.2A.1: atomic read-modify-write (no lost update) ----
const idC = newStableId()
await createDocument({ id: idC, fileName: 'atomic.pdf', mimeType: 'application/pdf', fileSize: 5, pageCount: 50, sourceBlob: pdfBlob(5) })
const ch1 = [{ id: '0', title: '第 1 章', level: 1, startPage: 1, endPage: 10, selectable: true, source: 'native' as const, children: [] }]
await Promise.all([
  updateDocumentChapters(idC, ch1, 'native'),
  updateLastReadPage(idC, 42),
])
const atomic = await getDocument(idC)
assert(atomic!.chapters.length === 1 && atomic!.chapters[0].id === '0', 'concurrent updates: chapters written')
assert(atomic!.lastReadPage === 42, 'concurrent updates: lastReadPage written (no lost update, got ' + atomic!.lastReadPage + ')')

// rapid sequential progress bumps always keep other document fields intact
await Promise.all([updateLastReadPage(idC, 7), updateLastReadPage(idC, 8), updateLastReadPage(idC, 9)])
const g9 = await getDocument(idC)
assert(g9!.lastReadPage >= 7 && g9!.lastReadPage <= 9, 'rapid progress bumps land (got ' + g9!.lastReadPage + ')')
assert(g9!.chapters.length === 1 && g9!.fileName === 'atomic.pdf', 'other fields untouched by progress bumps')

// ---- lastReadPage invariant: invalid values THROW ----
for (const bad of [-1, 1.5, 51, NaN, Infinity]) {
  let threw = false
  try { await updateLastReadPage(idC, bad) } catch { threw = true }
  assert(threw, 'lastReadPage ' + String(bad) + ' rejected')
}
const gBad = await getDocument(idC)
assert(gBad!.lastReadPage <= 9 && gBad!.chapters.length === 1, 'invalid writes left the document unchanged')
// not-found throws
let nf = false
try { await updateLastReadPage(newStableId(), 1) } catch { nf = true }
assert(nf, 'updateLastReadPage on missing document throws')
let nf2 = false
try { await updateDocumentChapters(newStableId(), [], 'none') } catch { nf2 = true }
assert(nf2, 'updateDocumentChapters on missing document throws')
// fileSize truth source
const idF = newStableId()
const created = await createDocument({ id: idF, fileName: 'truth.pdf', mimeType: 'application/pdf', fileSize: 99999, pageCount: 2, sourceBlob: pdfBlob(44) })
assert(created.fileSize === 44, 'createDocument stores sourceBlob.size as fileSize truth (got ' + created.fileSize + ')')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
