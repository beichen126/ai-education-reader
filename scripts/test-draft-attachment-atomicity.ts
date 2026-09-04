import 'fake-indexeddb/auto'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'
import { saveFiles, saveGeneratedImagesAndDraft, cleanupOrphanAttachments } from '../src/engine/attachment-service.ts'
import { attachmentExists } from '../src/storage/storage.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { idbScan, idbGet, idbClearAll, idbRunTxn } from '../src/storage/idb.ts'

import { newStableId } from '../src/engine/types.ts'
import { draftSettingKey } from '../src/engine/draft-store.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const page = (n: number) => ({ blob: new Blob([new Uint8Array([137, 80, 78, 71, n])], { type: 'image/png' }), pageNumber: n, width: 1, height: 1, mimeType: 'image/png' })

await idbClearAll()

async function attachCount(): Promise<number> { let n = 0; await idbScan('attachments', () => { n++ }); return n }

// --- 1: target conversation DELETED -> no commit ---
{
  const cid = newStableId()
  const res = await addPdfContextToDraft(cid, { fileName: 'a.pdf', selection: { kind: 'manual', ranges: [] }, pages: [page(1), page(2)] })
  assert(res.ok === false, '1: add to missing conversation fails')
  assert((await attachCount()) === 0, '1: no orphan attachment rows committed')
}

// --- 2: GC preserves message-referenced attachment ---
{
  const cid = newStableId()
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,1])], 'm.png', { type: 'image/png' })])
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'x', images: [a[0].id], createdAt: 1, updatedAt: 1 }] })
  const r = await cleanupOrphanAttachments(0)
  assert(await attachmentExists(a[0].id), '2: GC preserves message-referenced attachment (removed=' + r.removed + ')')
}

// --- 3: GC preserves draft-referenced attachment ---
{
  const cid = newStableId()
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,2])], 'd.png', { type: 'image/png' })])
  await idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: draftSettingKey(cid), value: { version: 1, text: '', imageIds: [a[0].id] } }) })
  const r = await cleanupOrphanAttachments(0)
  assert(await attachmentExists(a[0].id), '3: GC preserves draft-referenced attachment (removed=' + r.removed + ')')
}

// --- 4: GC removes an OLD true orphan ---
{
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,3])], 'o.png', { type: 'image/png' })])
  const row = await idbGet('attachments', a[0].id)
  await idbRunTxn(['attachments'], (t) => { t.objectStore('attachments').put({ ...row, meta: { ...row.meta, createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2 } }) })
  const r = await cleanupOrphanAttachments(24 * 60 * 60 * 1000)
  assert(!(await attachmentExists(a[0].id)) && r.removed >= 1, '4: GC removes old true orphan (removed=' + r.removed + ')')
}

// --- 5: GC never removes a NEW in-flight attachment ---
{
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,4])], 'new.png', { type: 'image/png' })])
  const r = await cleanupOrphanAttachments(24 * 60 * 60 * 1000)
  assert(await attachmentExists(a[0].id), '5: GC does NOT remove fresh in-flight attachment (removed=' + r.removed + ')')
}

// --- 6: transaction abort leaves NEITHER attachment rows NOR draft refs ---
await idbClearAll()
{
  const cid6 = newStableId()
  await saveConversation({ id: cid6, title: 'c', createdAt: 1, updatedAt: 1, messages: [] })
  let threw = false
  try { await saveGeneratedImagesAndDraft([{ blob: new Blob([new Uint8Array([1,2,3])], { type: 'image/png' }), name: 'a.png' }], { conversationId: cid6, text: '', existingImageIds: [] }, { failTxn: true }) } catch (e) { threw = true }
  assert(threw, '6: forced metadata transaction abort throws')
  assert((await attachCount()) === 0, '6: NO attachment rows committed after abort')
  assert((await idbGet('settings', draftSettingKey(cid6))) === undefined, '6: NO draft row committed after abort')
}

// --- 7: target conversation disappears before commit -> no ownership graph committed ---
await idbClearAll()
{
  const cid7 = newStableId()
  const res7 = await addPdfContextToDraft(cid7, { fileName: 'a.pdf', selection: { kind: 'manual', ranges: [] }, pages: [page(1)] })
  assert(res7.ok === false, '7: adding to missing conversation fails')
  assert((await attachCount()) === 0, '7: no attachment rows committed')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)