import 'fake-indexeddb/auto'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'
import { saveFiles, cleanupOrphanAttachments } from '../src/engine/attachment-service.ts'
import { saveConversation, listConversations, idbGetAll } from '../src/storage/storage.ts'
import { idbScan, idbClearAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import { draftSettingKey } from '../src/engine/draft-store.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const page = (n: number) => ({ blob: new Blob([new Uint8Array([137, 80, 78, 71, n])], { type: 'image/png' }), pageNumber: n, width: 1, height: 1, mimeType: 'image/png' })

await idbClearAll()

// --- 1: target conversation deleted -> no commit (no orphan attachment graph) ---
{
  const cid = newStableId()
  // No conversation row for cid (simulating a deleted target).
  const res = await addPdfContextToDraft(cid, { fileName: 'a.pdf', selection: { kind: 'manual', ranges: [] }, pages: [page(1), page(2)] })
  assert(res.ok === false, '1: add to a missing conversation fails (ok=false)')
  let attachCount = 0
  await idbScan('attachments', () => { attachCount++ })
  assert(attachCount === 0, '1: no orphan attachment rows committed (got ' + attachCount + ')')
}


// --- helper: count attachment rows ---
async function attachCount(): Promise<number> { let n = 0; await idbScan('attachments', () => { n++ }); return n }

// --- 2: reachability GC preserves a message-referenced attachment ---
{
  const cid = newStableId()
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,1])], 'm.png', { type: 'image/png' })])
  await saveConversation({ id: cid, title: 'c', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'x', images: [a[0].id], createdAt: 1, updatedAt: 1 }] })
  const r = await cleanupOrphanAttachments(0)
  const still = await (await import('../src/storage/storage.ts')).attachmentExists(a[0].id)
  assert(still, '2: GC preserves a message-referenced attachment (removed=' + r.removed + ')')
}

// --- 3: GC preserves a draft-referenced attachment ---
{
  const cid = newStableId()
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,2])], 'd.png', { type: 'image/png' })])
  // write a persisted draft row referencing the attachment
  await (await import('../src/storage/idb.ts')).idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: draftSettingKey(cid), value: { version: 1, text: '', imageIds: [a[0].id] } }) })
  const r = await cleanupOrphanAttachments(0)
  const still = await (await import('../src/storage/storage.ts')).attachmentExists(a[0].id)
  assert(still, '3: GC preserves a draft-referenced attachment (removed=' + r.removed + ')')
}

// --- 4: GC removes an OLD true orphan (not referenced by any message/draft) ---
{
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,3])], 'o.png', { type: 'image/png' })])
  // age it: rewrite meta.createdAt far in the past
  const row = await (await import('../src/storage/storage.ts')).getAttachmentRow(a[0].id)
  await (await import('../src/storage/idb.ts')).idbRunTxn(['attachments'], (t) => { t.objectStore('attachments').put({ ...row, meta: { ...row.meta, createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2 } }) })
  const r = await cleanupOrphanAttachments(24 * 60 * 60 * 1000)
  const still = await (await import('../src/storage/storage.ts')).attachmentExists(a[0].id)
  assert(!still && r.removed >= 1, '4: GC removes an old true orphan (removed=' + r.removed + ')')
}

// --- 5: GC never removes a NEW/in-flight attachment (younger than grace) ---
{
  const a = await saveFiles([new File([new Uint8Array([137,80,78,71,4])], 'new.png', { type: 'image/png' })])
  const r = await cleanupOrphanAttachments(24 * 60 * 60 * 1000)
  const still = await (await import('../src/storage/storage.ts')).attachmentExists(a[0].id)
  assert(still, '5: GC does NOT remove a fresh in-flight attachment (removed=' + r.removed + ')')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
