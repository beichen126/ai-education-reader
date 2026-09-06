import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { saveAttachment } from '../src/storage/storage.ts'
import { derivePdfContext, derivePdfContexts } from '../src/pdf/pdf-message-context.ts'
import { normalizeMessagePdfContexts, pdfContextsOf, type Message } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(condition: boolean, message: string) { if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) } }
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
const meta = (id: string, source?: any) => ({ id, name: id + '.png', mimeType: 'image/png', size: 3, createdAt: 1, updatedAt: 1, ...(source ? { source } : {}) })

await idbClearAll()
await saveAttachment(meta('p3', { type: 'pdf-page', groupId: 'g', documentId: 'doc-1', fileName: '教材.pdf', pageNumber: 3, selection: { kind: 'manual', ranges: [{ startPage: 3, endPage: 4 }] } }), blob)
await saveAttachment(meta('p4', { type: 'pdf-page', groupId: 'g', documentId: 'doc-1', fileName: '教材.pdf', pageNumber: 4, selection: { kind: 'manual', ranges: [{ startPage: 3, endPage: 4 }] } }), blob)
await saveAttachment(meta('ordinary'), blob)
const onePage = await derivePdfContexts(['p3'], 99)
assert(onePage.length === 1 && onePage[0].documentId === 'doc-1' && onePage[0].pageNumbers.join(',') === '3' && onePage[0].createdAt === 99, 'single PDF single page provenance')
const context = await derivePdfContexts(['ordinary', 'p4', 'p3'], 99)
assert(context.length === 1 && context[0].documentId === 'doc-1' && context[0].pageNumbers.join(',') === '3,4', 'single PDF multi-page provenance is sorted')
await saveAttachment(meta('b17', { type: 'pdf-page', groupId: 'g2', documentId: 'doc-2', fileName: 'other.pdf', pageNumber: 17, selection: { kind: 'manual', ranges: [{ startPage: 17, endPage: 17 }] } }), blob)
await saveAttachment(meta('b17-dup', { type: 'pdf-page', groupId: 'g2', documentId: 'doc-2', fileName: 'other.pdf', pageNumber: 17, selection: { kind: 'manual', ranges: [{ startPage: 17, endPage: 17 }] } }), blob)
const multi = await derivePdfContexts(['b17-dup', 'p4', 'b17', 'p3'], 100)
assert(multi.length === 2 && multi[0].documentId === 'doc-1' && multi[0].pageNumbers.join(',') === '3,4' && multi[1].documentId === 'doc-2' && multi[1].pageNumbers.join(',') === '17', 'multi-document regression keeps A [3,4] and B [17]')
assert((await derivePdfContext(['ordinary'], 100)) === undefined, 'legacy single-context helper returns undefined for ordinary chat')
const legacy: Message = { id: 'legacy', role: 'user', content: '', images: [], createdAt: 1, updatedAt: 1, pdfContext: { documentId: 'doc-1', pageNumbers: [4], createdAt: 1 } }
const canonical: Message = { ...legacy, pdfContexts: [{ documentId: 'doc-2', pageNumbers: [17], createdAt: 2 }] }
assert(pdfContextsOf(legacy)[0].documentId === 'doc-1', 'legacy pdfContext normalizes to one canonical context')
assert(pdfContextsOf(canonical)[0].documentId === 'doc-2', 'pdfContexts takes precedence over legacy pdfContext')
const normalized = normalizeMessagePdfContexts(legacy)
assert(normalized.pdfContexts?.length === 1 && normalized.pdfContext === undefined, 'normalized legacy message writes canonical shape')
assert((await derivePdfContexts(['ordinary'], 100)).length === 0, 'message without provenance has no contexts')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
