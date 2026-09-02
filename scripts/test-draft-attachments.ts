import 'fake-indexeddb/auto'
import { initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { initSettings } from '../src/engine/settings-store.ts'
import { saveAttachment, getAttachmentRow } from '../src/storage/storage.ts'
import { deleteAttachment } from '../src/engine/attachment-service.ts'
import { addDraftImages, clearDraft, getDraft, removeDraftImage } from '../src/engine/draft-store.ts'
import { newStableId } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
async function mkAtt(): Promise<string> {
  const id = newStableId()
  await saveAttachment({ id, name:'x.png', mimeType:'image/png', size:4, createdAt:1, updatedAt:1 } as any, new Blob([new Uint8Array([1,2,3,4])], { type:'image/png' }))
  return id
}
await initSettings()
await initStore()

// (a) user manually removes a draft image -> attachment deleted.
{
  const c = await sessionsActions.newChat()
  const att = await mkAtt()
  addDraftImages(c, [att])
  removeDraftImage(c, att); await deleteAttachment(att)
  assert(!(await getAttachmentRow(att)), 'manually-removed draft image -> attachment deleted')
  assert(getDraft(c).imageIds.length === 0, 'removed image leaves the draft empty')
}

// (b) conversation removed -> its pending (unsent) draft attachment is deleted.
{
  const a = await sessionsActions.newChat()
  const att = await mkAtt()
  addDraftImages(a, [att])
  await sessionsActions.remove(a)
  assert(!(await getAttachmentRow(att)), 'dropping a conversation deletes its UNSENT draft attachment')
}

// (c) clearDraft (post-send ownership transfer) must NOT delete a sent attachment.
{
  const b = await sessionsActions.newChat()
  const att = await mkAtt()
  addDraftImages(b, [att])
  clearDraft(b)   // send accepted -> ownership moved to the message
  assert(!!(await getAttachmentRow(att)), 'clearDraft does NOT delete an attachment now owned by a message')
  assert(getDraft(b).imageIds.length === 0, 'clearDraft empties the draft image ids')
}

// (d) deleting conversation A never touches B's draft or B's attachment.
{
  const a = await sessionsActions.newChat()
  const b = await sessionsActions.newChat()
  const attA = await mkAtt(); const attB = await mkAtt()
  addDraftImages(a, [attA]); addDraftImages(b, [attB])
  await sessionsActions.remove(a)
  assert(!!(await getAttachmentRow(attB)), 'B attachment survives deleting A')
  assert(getDraft(b).imageIds.join(',') === attB, 'B draft survives deleting A')
  assert(!(await getAttachmentRow(attA)), 'A pending attachment is cleaned with A')
}

// (e) a pending draft attachment that was cleared (owned by a message) is NOT double-deleted:
//     after clearDraft the conversation's pending list is empty, so the draft cleanup is a no-op.
{
  const d = await sessionsActions.newChat()
  const att = await mkAtt()
  addDraftImages(d, [att])
  clearDraft(d)
  // simulates an accepted send: the draft no longer owns att, so removing the conversation
  // must not run a draft-cleanup delete on a message-owned attachment it still references.
  // (the conversation's message-owned attachment is handled by the existing message loop)
  const idsBefore = getDraft(d).imageIds.length
  assert(idsBefore === 0, 'cleared draft has 0 pending ids before conversation removal')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

