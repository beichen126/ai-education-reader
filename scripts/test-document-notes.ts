import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { deleteDocumentNotes, getDocumentNote, listDocumentNotes, saveDocumentNote } from '../src/documents/document-note-service.ts'
import { createDocument, deleteDocument } from '../src/documents/document-service.ts'

let pass = 0, fail = 0
function assert(condition: boolean, message: string) { if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) } }

await idbClearAll()
const first = await saveDocumentNote('doc-1', 3, '重点：观察这个例子')
assert(!!first && first.documentId === 'doc-1' && first.pageNumber === 3, 'saves a document/page note')
const loaded = await getDocumentNote('doc-1', 3)
assert(loaded?.content === '重点：观察这个例子', 'loads the note after persistence')
await saveDocumentNote('doc-1', 3, '更新后的笔记')
const all = await listDocumentNotes('doc-1')
assert(all.length === 1 && all[0].content === '更新后的笔记' && all[0].createdAt === first!.createdAt, 'updates the same page note')
await deleteDocumentNotes('doc-1')
assert((await listDocumentNotes('doc-1')).length === 0, 'deletes all notes for a document')

await createDocument({ id: 'doc-owned', fileName: 'owned.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 2, sourceBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }) })
await saveDocumentNote('doc-owned', 1, 'should be cascaded')
await deleteDocument('doc-owned')
assert((await getDocumentNote('doc-owned', 1)) === undefined, 'deleting a document cascades its page notes')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
