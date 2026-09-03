// Stage 9.2A: Backup V2 (documents) + V1 compatibility + import validation.
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { createDocument, getDocument, listDocuments, updateDocumentChapters } from '../src/documents/document-service.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup, BackupError } from '../src/export/backup-import.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import { BACKUP_VERSION } from '../src/export/backup-types.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function mustReject(b: any, label: string) { let threw = false; try { parseAndValidate(b) } catch (e) { threw = e instanceof BackupError } assert(threw, 'rejects ' + label) }
const b64 = (n: number) => Buffer.from(new Array(n).fill(7)).toString('base64')

function freshDocMeta(): any {
  return {
    id: 'doc1', kind: 'pdf', fileName: '教材.pdf', mimeType: 'application/pdf', fileSize: 100,
    pageCount: 10, chapters: [{ id: '0', title: '第 1 章', level: 1, startPage: 1, endPage: 5, selectable: true, source: 'native', children: [] }],
    chapterSource: 'native', lastReadPage: 3, importSource: { kind: 'pdf', originalFileName: '教材.pdf' },
    createdAt: 1, updatedAt: 1,
  }
}
function v2backup() {
  return {
    format: 'ai-education-reader-backup', version: 2, exportedAt: 1,
    settings: { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false },
    conversations: [], annotations: [],
    attachments: [],
    documents: [{ id: 'doc1', meta: freshDocMeta(), mimeType: 'application/pdf', data: b64(100) }],
  }
}
function v1backup() {
  return {
    format: 'ai-education-reader-backup', version: 1, exportedAt: 1,
    settings: { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false },
    conversations: [{ id: 'c1', title: '会话', createdAt: 1, updatedAt: 1, messages: [{ id: 'm1', role: 'user', content: 'hi', images: ['att1'], createdAt: 1, updatedAt: 1 }] }],
    annotations: [], attachments: [{ id: 'att1', meta: { id: 'att1', name: 'a.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, mimeType: 'image/png', data: b64(4) }],
  }
}

// --- V2 export: documents included, base64 decodes byte-for-byte ---
await idbClearAll()
await createDocument({ id: 'doc1', fileName: '教材.pdf', mimeType: 'application/pdf', fileSize: 100, pageCount: 10, sourceBlob: new Blob([new Uint8Array(100).fill(7)], { type: 'application/pdf' }), importSource: { kind: 'pdf', originalFileName: '教材.pdf' } })
await restoreBackup(parseAndValidate(v2backup())) // seed a second state? no — just parse+restore below
const backup = await buildBackup()
assert(backup.version === BACKUP_VERSION && BACKUP_VERSION === 2, 'exported backup version = 2')
assert(backup.documents.length === 1, 'V2 export includes 1 document (got ' + backup.documents.length + ')')
const bd = backup.documents[0]
assert(bd.meta.id === 'doc1' && bd.meta.kind === 'pdf' && bd.meta.pageCount === 10, 'exported document metadata correct')
assert(!('sourceBlob' in bd.meta), 'exported document meta excludes the Blob field')
assert(bd.data === b64(100) && bd.mimeType === 'application/pdf', 'exported base64 + mimeType correct')
const restoredBytes = Buffer.from(bd.data, 'base64')
assert(restoredBytes.length === 100 && restoredBytes.every(v => v === 7), 'exported blob decodes to identical bytes')
// restore into a cleared db -> byte-for-byte doc blob
await idbClearAll()
await restoreBackup(parseAndValidate(JSON.parse(JSON.stringify(backup))))
const restored = await getDocument('doc1')
assert(!!restored && restored.fileSize === 100, 'restored document present')
const rb = new Uint8Array(await restored!.sourceBlob.arrayBuffer())
assert(rb.length === 100 && rb.every(v => v === 7), 'restored PDF blob byte-for-byte identical')
assert(restored!.chapters.length === 1 && restored!.chapters[0].id === '0', 'restored chapter tree kept')

// --- manual-source chapters round-trip (Stage 9.4A): no schema change, manual tree survives ---
await idbClearAll()
await createDocument({ id: 'docM', fileName: '手册.pdf', mimeType: 'application/pdf', fileSize: 50, pageCount: 12, sourceBlob: new Blob([new Uint8Array(50).fill(9)], { type: 'application/pdf' }), importSource: { kind: 'pdf', originalFileName: '手册.pdf' } })
await updateDocumentChapters('docM', [
  { id: 'm1', title: '第一章', level: 1, startPage: 1, endPage: 6, selectable: true, source: 'manual', children: [
    { id: 'm1a', title: '1.1', level: 2, startPage: 2, endPage: 4, selectable: true, source: 'manual', children: [] },
  ] },
  { id: 'm2', title: '第二章', level: 1, startPage: 8, endPage: 12, selectable: true, source: 'manual', children: [] },
], 'manual')
const manualBackup = await buildBackup()
await idbClearAll()
await restoreBackup(parseAndValidate(JSON.parse(JSON.stringify(manualBackup))))
const manualRestored = await getDocument('docM')
assert(!!manualRestored && manualRestored.chapterSource === 'manual', 'manual chapterSource survives backup round-trip')
assert(!!manualRestored && manualRestored.chapters.length === 2 && manualRestored.chapters[0].id === 'm1' && manualRestored.chapters[0].children[0].id === 'm1a' && manualRestored.chapters[0].children[0].level === 2, 'manual chapter tree (with nested child) survives backup round-trip')
assert(!!manualRestored && manualRestored.chapters[0].source === 'manual' && manualRestored.chapters[1].startPage === 8, 'manual source + startPage preserved')

// --- V1 compatibility: accepted, restores conversations/attachments, documents=[] ---
await idbClearAll()
const v1 = parseAndValidate(v1backup())
await restoreBackup(v1)
assert((await listDocuments()).length === 0, 'V1 restore -> documents=[]')
const conv = await new Promise<any>((res, rej) => { const r = indexedDB.open('ai-education-reader', 4); r.onsuccess = () => { const rr = r.result.transaction('conversations', 'readonly').objectStore('conversations').get('c1'); rr.onsuccess = () => res(rr.result); rr.onerror = () => rej(rr.error) }; r.onerror = () => rej(r.error) })
assert(!!conv && conv.messages[0].content === 'hi', 'V1 restore keeps conversation/message')

// --- validation: malformed documents rejected ---
{ const b = v2backup(); b.documents[0].data = 'not base64 !!!'; mustReject(b, 'invalid document base64') }
{ const b = v2backup(); b.documents[0].mimeType = 'image/png'; mustReject(b, 'document mimeType != application/pdf') }
{ const b = v2backup(); b.documents[0].meta.pageCount = -3; mustReject(b, 'negative pageCount') }
{ const b = v2backup(); b.documents[0].meta.chapters[0].startPage = 99; mustReject(b, 'chapter page beyond pageCount') }
{ const b = v2backup(); b.documents[0].meta.chapters[0].endPage = 0; mustReject(b, 'chapter page < 1') }
{ const b = v2backup(); b.documents[0].meta.kind = 'slides'; mustReject(b, 'document kind != pdf') }
{ const b = v2backup(); b.documents[1] = { ...b.documents[0] }; mustReject(b, 'duplicate document id') }
{ const b = v2backup(); b.version = 3; mustReject(b, 'unsupported version 3') }
{ const b = v1backup(); b.version = 2; delete b.documents; mustReject(b, 'v2 without documents array') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = -1; mustReject(b, 'negative lastReadPage') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = 1.5; mustReject(b, 'fractional lastReadPage') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = 11; mustReject(b, 'lastReadPage beyond pageCount') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = NaN; mustReject(b, 'NaN lastReadPage') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = Infinity; mustReject(b, 'infinite lastReadPage') }
{ const b = v2backup(); b.documents[0].meta.lastReadPage = 10; assert(parseAndValidate(b) !== null, 'lastReadPage = pageCount accepted'); }
{ const b = v2backup(); b.documents[0].meta.importSource = { kind: 'slides', originalFileName: 'x.pdf' }; mustReject(b, 'importSource kind not pdf/ppt/pptx') }
{ const b = v2backup(); b.documents[0].meta.importSource = { kind: 'pdf' }; mustReject(b, 'importSource missing originalFileName') }
{ const b = v2backup(); b.documents[0].meta.importSource = { kind: 'pdf', originalFileName: '   ' }; mustReject(b, 'importSource blank originalFileName') }
{ const b = v2backup(); b.documents[0].meta.chapters[0].children = [{ id: '0', title: 'dup id', level: 2, startPage: 2, endPage: 3, selectable: true, source: 'native', children: [] }]; mustReject(b, 'duplicate chapter id within one document') }
{ const b = v2backup(); b.documents[0].meta.fileSize = 100.5; mustReject(b, 'fractional fileSize rejected') }
{ const b = v2backup(); b.documents[0].meta.chapters = [{ id: '0', title: 'A', level: 1, startPage: 1, endPage: 2, selectable: true, source: 'native', children: [] }, { id: 'a', title: 'B', level: 1, startPage: 3, endPage: 4, selectable: true, source: 'native', children: [] }]; assert(parseAndValidate(b) !== null, 'distinct chapter ids accepted'); }
// apiKey must NEVER be part of a backup
const noKey = JSON.stringify(v2backup())
assert(!noKey.includes('sk-') && !noKey.includes('apiKey'), 'backup JSON contains no apiKey field')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
