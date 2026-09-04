import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { idbScan, idbGet, idbClearAll } from '../src/storage/idb.ts'
import { saveGeneratedImagesAndBranchDraft } from '../src/engine/attachment-service.ts'
import { branchDraftSettingKey, getBranchDraft, initBranchDrafts, resetDrafts } from '../src/engine/draft-store.ts'
import { createBranchFromMessage, deleteBranchSubtree } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function png(bytes: number[] = [1,2,3]) { return new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }
async function attachCount(): Promise<number> { let n = 0; await idbScan('attachments', () => { n++ }); return n }
async function draftRow(branchId: string) { return idbGet('settings', branchDraftSettingKey(branchId)) }

await idbClearAll(); resetDrafts()
const convId = newStableId()
const conv: Conversation = { id: convId, title: 't', createdAt: 1, updatedAt: 1, messages: [msg('m0'), msg('m1')] }
await saveConversation(conv)
const bA = await createBranchFromMessage(convId, 'm1')
const bB = await createBranchFromMessage(convId, 'm1')

// ---- 1. success: attachment rows + branch-draft row committed atomically ----
const imgs = await saveGeneratedImagesAndBranchDraft([{ blob: png(), name: 'a.png' }], { branchId: bA.id, text: 'branch A draft', existingImageIds: [] })
assert(imgs.length === 1, '1: branch commit returns the attachment meta')
const rowA = await draftRow(bA.id)
assert(rowA && rowA.value.text === 'branch A draft' && rowA.value.imageIds.includes(imgs[0].id), '1: draft-branch row committed with text + image id')
assert((await attachCount()) >= 1, '1: attachment rows committed')

// ---- 2. branch B isolated (different image + PDF page source), no leakage into A ----
const pdfImgs = await saveGeneratedImagesAndBranchDraft([{ blob: png([4,5,6]), name: 'book.pdf', source: { type: 'pdf-page', groupId: 'g', fileName: 'book.pdf', pageNumber: 3, selection: { kind: 'manual', ranges: [] } } }], { branchId: bB.id, text: 'branch B pdf', existingImageIds: [] })
const aRow = await draftRow(bA.id)
const bRow = await draftRow(bB.id)
const aIds = (aRow && aRow.value.imageIds) || []
const bIds = (bRow && bRow.value.imageIds) || []
assert(aIds.length === 1 && aIds.includes(imgs[0].id) && !aIds.includes(pdfImgs[0].id), '2: branch A draft image isolated (no B PDF leak)')
assert(bIds.length === 1 && bIds.includes(pdfImgs[0].id) && !bIds.includes(imgs[0].id), '2: branch B draft PDF isolated (no A image leak)')
assert((aRow && aRow.value.text) === 'branch A draft' && (bRow && bRow.value.text) === 'branch B pdf', '2: branch draft text isolated')

// ---- 3. failure injection: forced txn abort commits NEITHER attachments NOR branch draft ----
await idbClearAll(); resetDrafts()
const convId2 = newStableId()
await saveConversation({ id: convId2, title: 't2', createdAt: 1, updatedAt: 1, messages: [msg('m0'), msg('m1')] })
const bC = await createBranchFromMessage(convId2, 'm1')
let threw = false
try { await saveGeneratedImagesAndBranchDraft([{ blob: png(), name: 'c.png' }], { branchId: bC.id, text: 'draft c', existingImageIds: [] }, { failTxn: true }) } catch { threw = true }
assert(threw === true, '3: forced metadata transaction abort throws')
assert((await attachCount()) === 0, '3: NO attachment rows committed after abort')
assert((await draftRow(bC.id)) === undefined, '3: NO draft-branch row committed after abort')

// ---- 4. deletion protection: branch deleted BEFORE commit -> rejected, no orphan graph ----
const bD = await createBranchFromMessage(convId2, 'm1')
await deleteBranchSubtree(bD.id)
let threw4 = false
try { await saveGeneratedImagesAndBranchDraft([{ blob: png(), name: 'd.png' }], { branchId: bD.id, text: 'x', existingImageIds: [] }) } catch { threw4 = true }
assert(threw4 === true, '4: attachment commit for a deleted branch is rejected (deletion protection)')
assert((await getBranch(bD.id)) === undefined, '4: deleted branch stays deleted (no resurrection)')
assert((await attachCount()) === 0, '4: no orphan attachment rows committed for a deleted branch')
assert((await draftRow(bD.id)) === undefined, '4: no orphan branch-draft row committed for a deleted branch')

// ---- 5. branch draft isolation survives reload (initBranchDrafts) ----
await idbClearAll(); resetDrafts()
const convId3 = newStableId()
await saveConversation({ id: convId3, title: 't3', createdAt: 1, updatedAt: 1, messages: [msg('m0'), msg('m1')] })
const bE = await createBranchFromMessage(convId3, 'm1')
await saveGeneratedImagesAndBranchDraft([{ blob: png(), name: 'e.png' }], { branchId: bE.id, text: 'reload me', existingImageIds: [] })
resetDrafts()
await initBranchDrafts([bE.id])
const d = getBranchDraft(bE.id)
assert(d.text === 'reload me' && d.imageIds.length === 1, '5: branch draft restored after reload (initBranchDrafts)')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
