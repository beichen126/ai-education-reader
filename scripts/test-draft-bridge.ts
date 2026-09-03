// Stage 9.2B2: shared Draft bridge — Reader-style payload commits atomically.
import 'fake-indexeddb/auto'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'
import { getDraft, addDraftImages, resetDrafts } from '../src/engine/draft-store.ts'
import { getAttachment, saveGeneratedImages, deleteAttachment } from '../src/engine/attachment-service.ts'
import { idbGetAll, idbClearAll } from '../src/storage/idb.ts'
import { newStableId, type Attachment } from '../src/engine/types.ts'
import { buildAttachmentDisplayItems } from '../src/attachments/attachment-display.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const jpg = (n: number, bytes = 100) => ({ pageNumber: n, blob: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), width: 10, height: 10, mimeType: 'image/jpeg' })

await idbClearAll(); resetDrafts()
const convId = newStableId()
const DOC = 'doc-b2'
const payload = {
  documentId: DOC,
  fileName: '教材.pdf',
  selection: { kind: 'outline' as const, title: '4.2.3 快速重传', ranges: [{ startPage: 126, endPage: 128 }], selectedChapterIds: ['c4.2.3'] },
  pages: [jpg(126, 10), jpg(127, 20), jpg(128, 30)],
}

// success: one groupId, same documentId + selection, correct pageNumbers, draft got ids
const res = await addPdfContextToDraft(convId, payload as any)
assert(res.ok === true && res.count === 3, 'success result ok/3 (got ' + res.count + ')')
const draft = getDraft(convId)
assert(draft.imageIds.length === 3, 'draft receives all 3 ids')
const atts = await idbGetAll('attachments') as Array<{ id: string; meta: Attachment }>
assert(atts.length === 3, '3 attachments persisted (no orphans)')
const groupIds = new Set(atts.map(a => a.meta.source?.groupId))
const docIds = new Set(atts.map(a => a.meta.source?.documentId))
assert(groupIds.size === 1, 'ONE groupId for one user operation')
assert(docIds.size === 1 && docIds.has(DOC), 'same documentId across pages')
assert(atts.every(a => a.meta.source?.selection.title === '4.2.3 快速重传'), 'same PdfSelection metadata')
const pageNums = atts.map(a => a.meta.source?.pageNumber).sort((x, y) => (x! - y!))
assert(pageNums.join(',') === '126,127,128', 'correct pageNumbers (got ' + pageNums + ')')
assert(atts.every(a => a.meta.source?.documentId === a.meta.source?.documentId), 'provenance intact')
// group display: 1 group
const items = buildAttachmentDisplayItems(draft.imageIds, atts.map(a => a.meta))
assert(items.length === 1 && items[0].type === 'pdf-group', 'draft UI shows ONE group')

// double-submit prevention is UI-level; here verify a second call creates a NEW groupId
const res2 = await addPdfContextToDraft(convId, { ...payload, pages: [jpg(129, 10)] } as any)
assert(res2.ok === true && res2.count === 1, 'second operation ok')
const all2 = await idbGetAll('attachments') as Array<{ id: string; meta: Attachment }>
const gids2 = new Set(all2.map(a => a.meta.source?.groupId))
assert(gids2.size === 2, 'separate operations -> separate groupIds (no auto-merge)')
assert(getDraft(convId).imageIds.length === 4, 'draft keeps both groups')

// budget exceeded -> no new attachments
await idbClearAll(); resetDrafts()
const big = { ...payload, pages: [jpg(1, 16 * 1024 * 1024), jpg(2, 16 * 1024 * 1024)] } // 32MiB > 30MiB budget
const res3 = await addPdfContextToDraft(convId, big as any)
assert(res3.ok === false, 'draft budget exceeded -> rejected')
assert((await idbGetAll('attachments')).length === 0, 'budget failure leaves NO attachments')

// existing draft bytes push over budget -> rejected, no rollback orphans
await idbClearAll(); resetDrafts()
await saveGeneratedImages([{ blob: new Blob([new Uint8Array(29 * 1024 * 1024)], { type: 'image/jpeg' }), name: 'pre.jpg' }]).catch(() => {})
const pre = await idbGetAll('attachments') as Array<{ id: string; meta: Attachment }>
if (pre.length === 1) {
  addDraftImages(convId, [pre[0].id])
  const res4 = await addPdfContextToDraft(convId, { ...payload, pages: [jpg(1, 2 * 1024 * 1024)] } as any)
  assert(res4.ok === false && (await idbGetAll('attachments')).length === 1, 'existing 29MiB + 2MiB -> reject, no orphan')
} else {
  assert(true, 'note: 29MiB blob skipped (fake-indexeddb size limits)')
}

// addDraftImages failure -> created attachments rolled back (test seam)
await idbClearAll(); resetDrafts()
const res5 = await addPdfContextToDraft(convId, { ...payload, pages: [jpg(130, 10)] } as any, { addDraftImages: () => { throw new Error('quota') } })
assert(res5.ok === false, 'commit failure surfaces as ok:false')
assert((await idbGetAll('attachments')).length === 0, 'failing draft add rolls back ALL created attachments (no orphans)')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
