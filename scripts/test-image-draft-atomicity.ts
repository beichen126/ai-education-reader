import 'fake-indexeddb/auto'
import { saveImagesAndDraft } from '../src/engine/attachment-service.ts'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'
import { saveConversation } from '../src/storage/storage.ts'
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

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
