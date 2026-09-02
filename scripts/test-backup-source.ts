// Stage 5 backup compatibility: Attachment.source must survive export -> import.
import 'fake-indexeddb/auto'
import { saveGeneratedImages, getAttachment } from '../src/engine/attachment-service.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { getAttachmentRow } from '../src/storage/storage.ts'
import { newStableId } from '../src/engine/types.ts'
import { closeDb } from '../src/storage/idb.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const groupId = 'group-abc-123'
const atts = await saveGeneratedImages([
  { blob: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), name: 'doc-p0001.jpg', source: { type: 'pdf-page', groupId, fileName: 'doc.pdf', pageNumber: 1, selection: { kind: 'outline', title: '1.2 Cache', startPage: 1, endPage: 13 } } },
  { blob: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), name: 'doc-p0002.jpg', source: { type: 'pdf-page', groupId, fileName: 'doc.pdf', pageNumber: 2, selection: { kind: 'outline', title: '1.2 Cache', startPage: 1, endPage: 13 } } },
])
assert(atts.length === 2 && !!atts[0].source && atts[0].source.groupId === groupId, 'source written to attachment meta')

// reference them from a conversation message so buildBackup collects them
const now = Date.now()
await saveConversation({ id: newStableId(), title: 't', createdAt: now, updatedAt: now, messages: [{ id: newStableId(), role: 'user', content: 'hello', images: atts.map(a => a.id), createdAt: now, updatedAt: now }] })

const backup = await buildBackup()
const exported = backup.attachments.find(a => a.id === atts[0].id)
assert(!!exported && !!exported.meta.source && exported.meta.source.pageNumber === 1, 'backup export keeps meta.source (pageNumber 1)')
assert(exported!.meta.source.groupId === groupId && exported!.meta.source.selection.title === '1.2 Cache', 'export keeps groupId + selection.title')

const parsed = parseAndValidate(JSON.parse(JSON.stringify(backup)))
assert(parsed.attachments.find(a => a.id === atts[0].id)!.meta.source !== undefined, 'parseAndValidate keeps source (no whitelist drop)')
await restoreBackup(backup)
await closeDb()
const restored = await getAttachment(atts[0].id)
assert(!!restored && !!restored.source && restored.source.pageNumber === 1 && restored.source.groupId === groupId, 'restore keeps source (pageNumber + groupId)')
const row = await getAttachmentRow(atts[1].id)
assert(!!row && row.meta.source && row.meta.source.selection.kind === 'outline', 'row meta source intact after restore')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
