// Stage 2 no-API-required chain test: generated PDF-page images -> Attachment (IDB)
// -> draft -> buildApiMessages image_url parts (base64 decodable). Runs offline with
// fake-indexeddb. Source imports only; no real DeepSeek call, no API key.
import 'fake-indexeddb/auto'
import { saveGeneratedImages, getAttachment, toDataUrl, deleteAttachment, existsAttachment, sumAttachmentBytes, isInlineImageOverBudget, MAX_INLINE_IMAGE_RAW_BYTES } from '../src/engine/attachment-service.ts'
import { addDraftImages, getDraft, resetDrafts } from '../src/engine/draft-store.ts'
import { buildApiMessages } from '../src/api/deepseek.ts'
import { pdfPageAttachmentName } from '../src/pdf/pdf-types.ts'
import { newStableId, type Message } from '../src/engine/types.ts'
import { getAttachmentRow } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const mkJpeg = (name: string, length: number) => ({ blob: new Blob([new Uint8Array(length)], { type: 'image/jpeg' }), name })

// --- naming strategy ---
assert(pdfPageAttachmentName('教材.pdf', 35) === '教材-p0035.jpg', 'naming: strip .pdf + zero-pad 4')
assert(pdfPageAttachmentName('lecture.PDF', 5) === 'lecture-p0005.jpg', 'naming: case-insensitive .pdf strip')

// --- saveGeneratedImages -> attachments ---
const inputs = [mkJpeg('x-p0001.jpg', 10), mkJpeg('x-p0002.jpg', 20), mkJpeg('x-p0003.jpg', 30), mkJpeg('x-p0004.jpg', 40)]
const atts = await saveGeneratedImages(inputs)
assert(atts.length === 4, '4 generated images saved')
assert(atts.every(a => a.mimeType === 'image/jpeg'), 'mime is image/jpeg')
assert(atts[0].size === 10, 'size recorded from blob.size')
assert(atts[0].name === 'x-p0001.jpg', 'generated name preserved')
const ids = atts.map(a => a.id)

// --- persisted in IndexedDB attachments store with stable id ---
const row = await getAttachmentRow(ids[0])
assert(!!row && row.meta.id === ids[0], 'attachment persisted in IDB with stable id')

// --- Draft chain ---
addDraftImages('conv-pdf', ids)
const draft = getDraft('conv-pdf')
assert(draft.imageIds.length === 4 && ids.every(id => draft.imageIds.includes(id)), 'addDraftImages added all 4 ids')
resetDrafts()

// --- buildApiMessages -> decodable image_url parts ---
const m: Message = { id: newStableId(), role: 'user', content: '看这几页', images: ids, createdAt: 1, updatedAt: 1 }
const api = await buildApiMessages([m], toDataUrl)
const parts = api[0].content as any[]
const imgParts = parts.filter(p => p.type === 'image_url')
assert(parts[0].type === 'text' && parts[0].text === '看这几页', 'text part first')
assert(imgParts.length === 4, 'exactly 4 image_url parts')
let allDecodable = true
for (const p of imgParts) {
  const u: string = p.image_url.url
  if (!u.startsWith('data:image/jpeg;base64,')) { allDecodable = false; break }
  const b64 = u.slice('data:image/jpeg;base64,'.length)
  const bin = atob(b64)
  if (bin.length === 0) allDecodable = false
}
assert(allDecodable, 'all 4 image_url parts are decodable base64 jpeg')
assert(parts.some(p => p.type === 'text' && p.text === '【图片 1/4】'), 'identity label 【图片 1/4】 present')

// --- inline payload guard ---
const sizes = await sumAttachmentBytes(ids)
assert(sizes === 100, 'sumAttachmentBytes = 100')
assert(!isInlineImageOverBudget(100), 'under budget -> pass')
assert(isInlineImageOverBudget(MAX_INLINE_IMAGE_RAW_BYTES + 1), 'over budget -> block')

// --- empty batch ---
let err = ''
try { await saveGeneratedImages([]) } catch (e: any) { err = e.kind }
assert(err === 'read-failed', 'empty batch -> read-failed')

// --- delete / orphan hygiene ---
await deleteAttachment(ids[0])
assert(!(await existsAttachment(ids[0])), 'deleted attachment gone')
assert(await existsAttachment(ids[1]), 'other attachments unaffected')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
