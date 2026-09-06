import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { deleteDocumentNotes, getDocumentNote, listDocumentNotes, saveDocumentNote } from '../src/documents/document-note-service.ts'
import { createDocument, deleteDocument } from '../src/documents/document-service.ts'

let pass = 0, fail = 0
function assert(condition: boolean, message: string) { if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) } }

await idbClearAll()
await createDocument({ id: 'doc-1', fileName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 5, sourceBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }) })
const first = await saveDocumentNote('doc-1', 3, '重点：观察这个例子')
assert(!!first && first.documentId === 'doc-1' && first.pageNumber === 3, 'saves a document/page note')
const loaded = await getDocumentNote('doc-1', 3)
assert(loaded?.content === '重点：观察这个例子', 'loads the note after persistence')
await saveDocumentNote('doc-1', 3, '更新后的笔记')
const all = await listDocumentNotes('doc-1')
assert(all.length === 1 && all[0].content === '更新后的笔记' && all[0].createdAt === first!.createdAt, 'updates the same page note')
await deleteDocumentNotes('doc-1')
assert((await listDocumentNotes('doc-1')).length === 0, 'deletes all notes for a document')

// Rapid concurrent callers must serialize by document/page, not merely leave the
// final value to IndexedDB scheduling luck.
await Promise.all([
  saveDocumentNote('doc-1', 2, 'A'),
  saveDocumentNote('doc-1', 2, 'AB'),
  saveDocumentNote('doc-1', 2, 'ABC'),
])
assert((await getDocumentNote('doc-1', 2))?.content === 'ABC', 'rapid A -> AB -> ABC saves latest value')

await saveDocumentNote('doc-1', 2, '')
assert((await getDocumentNote('doc-1', 2)) === undefined, 'blank content deletes the note')

// A missing document is not a valid note owner, even if the caller is late or
// an old orphan row happens to exist.
await saveDocumentNote('missing-doc', 1, 'must not persist')
assert((await getDocumentNote('missing-doc', 1)) === undefined, 'orphan documentId does not persist a note')

await createDocument({ id: 'doc-owned', fileName: 'owned.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 2, sourceBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }) })
await saveDocumentNote('doc-owned', 1, 'should be cascaded')
await deleteDocument('doc-owned')
assert((await getDocumentNote('doc-owned', 1)) === undefined, 'deleting a document cascades its page notes')

// The queued save starts after the document deletion transaction. The ownership
// check must reject it instead of recreating the deleted note.
await createDocument({ id: 'doc-race', fileName: 'race.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 2, sourceBlob: new Blob([new Uint8Array([4, 5, 6])], { type: 'application/pdf' }) })
const pending = Promise.all([
  saveDocumentNote('doc-race', 1, 'first'),
  saveDocumentNote('doc-race', 1, 'late second'),
])
await deleteDocument('doc-race')
await pending
assert((await getDocumentNote('doc-race', 1)) === undefined, 'pending save cannot revive a deleted document note')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
