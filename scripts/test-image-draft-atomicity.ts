import 'fake-indexeddb/auto'
import { saveImagesAndDraft } from '../src/engine/attachment-service.ts'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'
import { saveConversation, getConversation } from '../src/storage/storage.ts'
import { attachmentExists } from '../src/storage/storage.ts'
import { idbScan, idbGet, idbClearAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import { getDraft, resetDrafts, updateDraftMemory, draftSettingKey } from '../src/engine/draft-store.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const png = (n) => new File([new Uint8Array([137,80,78,71,n])], 'img' + n + '.png', { type: 'image/png' })

await idbClearAll(); resetDrafts()
async function attachCount() { let n = 0; await idbScan('attachments', () => { n++ }); return n }

// --- A: ordinary image upload success (matches Composer onFiles production path) ---
{
  const cid = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const d0 = getDraft(cid)
  const atts = await saveImagesAndDraft([png(1), png(2)], { conversationId: cid, text: d0.text, existingImageIds: d0.imageIds })
  updateDraftMemory(cid, { text: d0.text, imageIds: [...new Set([...d0.imageIds, ...atts.map(a => a.id)])] })
  assert(atts.length === 2, 'A: two attachments returned')
  assert(getDraft(cid).imageIds.length === 2, 'A: in-memory Draft has the 2 ids')
  assert(await attachmentExists(atts[0].id) && await attachmentExists(atts[1].id), 'A: attachment rows exist')
  const dr = await idbGet('settings', draftSettingKey(cid))
  assert(dr && dr.value.imageIds.length === 2 && dr.value.imageIds.includes(atts[0].id), 'A: persisted draft references the ids')
}

// --- B: forced transaction abort -> neither attachment nor draft refs, in-memory unchanged ---
await idbClearAll(); resetDrafts()
{
  const cid = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const d0 = getDraft(cid)
  let threw = false
  try { await saveImagesAndDraft([png(3)], { conversationId: cid, text: d0.text, existingImageIds: d0.imageIds }, { failTxn: true }) } catch (e) { threw = true }
  assert(threw, 'B: forced abort throws')
  assert((await attachCount()) === 0, 'B: NO attachment rows committed after abort')
  assert((await idbGet('settings', draftSettingKey(cid))) === undefined, 'B: NO draft row committed after abort')
  assert(getDraft(cid).imageIds.length === 0, 'B: in-memory Draft unchanged (no new ids)')
}

// --- C: existing Draft merge (text preserved, imageIds unioned) ---
await idbClearAll(); resetDrafts()
{
  const cid = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const existingA = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const attachBefore = await (async () => { const a = await (await import('../src/engine/attachment-service.ts')).saveFiles([new File([new Uint8Array([137,80,78,71,9])], 'existing.png', { type: 'image/png' }) ]); return a })()
  updateDraftMemory(cid, { text: 'hello', imageIds: [existingA] })
  // Seed a persisted draft row with text 'hello' + imageIds [existingA] (as if the Composer had one).
  await (await import('../src/storage/idb.ts')).idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: draftSettingKey(cid), value: { version: 1, text: 'hello', imageIds: [existingA] } }) })
  const d0 = { text: 'hello', imageIds: [existingA] }
  const atts = await saveImagesAndDraft([png(4)], { conversationId: cid, text: d0.text, existingImageIds: d0.imageIds })
  updateDraftMemory(cid, { text: d0.text, imageIds: [...new Set([...d0.imageIds, ...atts.map(a => a.id)])] })
  const dr = await idbGet('settings', draftSettingKey(cid))
  assert(dr && dr.value.text === 'hello', 'C: existing draft text preserved')
  assert(dr && dr.value.imageIds.includes(existingA) && dr.value.imageIds.includes(atts[0].id), 'C: imageIds = [existingA, newB]')
  assert(getDraft(cid).imageIds.includes(existingA) && getDraft(cid).imageIds.includes(atts[0].id), 'C: in-memory Draft merged')
}

// --- D: missing/deleted conversation -> no ownership graph committed ---
await idbClearAll(); resetDrafts()
{
  const cid = newStableId()
  let threw = false
  try { await saveImagesAndDraft([png(5)], { conversationId: cid, text: '', existingImageIds: [] }) } catch (e) { threw = true }
  assert(threw, 'D: missing conversation -> image upload throws')
  assert((await attachCount()) === 0, 'D: no attachment rows committed for missing conversation')
  assert((await idbGet('settings', draftSettingKey(cid))) === undefined, 'D: no draft row committed for missing conversation')
}

// --- E: PDF Context atomicity stays green (regression) ---
await idbClearAll(); resetDrafts()
{
  const cid = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const res = await addPdfContextToDraft(cid, { fileName: 'a.pdf', selection: { kind: 'outline', title: 'c1', ranges: [{ startPage: 1, endPage: 2 }] }, pages: [{ blob: new Blob([new Uint8Array([137,80,78,71,1])], { type: 'image/png' }), pageNumber: 1, width: 1, height: 1, mimeType: 'image/png' }, { blob: new Blob([new Uint8Array([137,80,78,71,2])], { type: 'image/png' }), pageNumber: 2, width: 1, height: 1, mimeType: 'image/png' }] })
  assert(res.ok === true && res.count === 2, 'E: PDF Context atomic commit ok (count 2)')
  const dr = await idbGet('settings', draftSettingKey(cid))
  assert(dr && dr.value.imageIds.length === 2, 'E: PDF Context draft row references the 2 pages')
  assert((await attachCount()) === 2, 'E: PDF Context attachment rows committed')
}


// --- F: id identity invariant: returned Attachment.id === StoredAttachmentRow.id === meta.id === Draft ref id === Message image ref id ---
await idbClearAll(); resetDrafts()
{
  const cid = newStableId()
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  const atts = await saveImagesAndDraft([png(6), png(7)], { conversationId: cid, text: '', existingImageIds: [] })
  assert(atts.length === 2, 'F: two attachments returned')
  // No path may generate a second, independent id for a logical attachment.
  const r0 = await idbGet('attachments', atts[0].id)
  const r1 = await idbGet('attachments', atts[1].id)
  assert(r0 && r0.id === atts[0].id && r0.meta.id === atts[0].id, 'F: stored row.id === meta.id === returned id (image 0)')
  assert(r1 && r1.id === atts[1].id && r1.meta.id === atts[1].id, 'F: stored row.id === meta.id === returned id (image 1)')
  assert(r0 && r1 && r0.id !== r1.id, 'F: the two images carry two DISTINCT ids')
  // The persisted draft references exactly the returned ids.
  const dr = await idbGet('settings', draftSettingKey(cid))
  assert(dr && dr.value.imageIds.includes(atts[0].id) && dr.value.imageIds.includes(atts[1].id), 'F: draft refs use the SAME returned ids')
  // A message built from the returned ids persists them verbatim (message image reference id).
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'x', images: atts.map(a => a.id), createdAt: 1, updatedAt: 1 }] })
  const conv = await getConversation(cid)
  assert(conv && conv.messages[0].images.includes(atts[0].id) && conv.messages[0].images.includes(atts[1].id), 'F: message image reference uses the SAME ids')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
