import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { saveAttachment } from '../src/storage/storage.ts'
import { derivePdfContext } from '../src/pdf/pdf-message-context.ts'

let pass = 0, fail = 0
function assert(condition: boolean, message: string) { if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) } }
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
const meta = (id: string, source?: any) => ({ id, name: id + '.png', mimeType: 'image/png', size: 3, createdAt: 1, updatedAt: 1, ...(source ? { source } : {}) })

await idbClearAll()
await saveAttachment(meta('p3', { type: 'pdf-page', groupId: 'g', documentId: 'doc-1', fileName: '教材.pdf', pageNumber: 3, selection: { kind: 'manual', ranges: [{ startPage: 3, endPage: 4 }] } }), blob)
await saveAttachment(meta('p4', { type: 'pdf-page', groupId: 'g', documentId: 'doc-1', fileName: '教材.pdf', pageNumber: 4, selection: { kind: 'manual', ranges: [{ startPage: 3, endPage: 4 }] } }), blob)
await saveAttachment(meta('ordinary'), blob)
const context = await derivePdfContext(['ordinary', 'p4', 'p3'], 99)
assert(!!context && context.documentId === 'doc-1' && context.pageNumbers.join(',') === '3,4' && context.createdAt === 99, 'derives sorted PDF document/page provenance')
assert((await derivePdfContext(['ordinary'], 100)) === undefined, 'ordinary chat has no PDF context')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
