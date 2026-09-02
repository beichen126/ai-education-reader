import 'fake-indexeddb/auto'
import { setDraftText, addDraftImages, clearDraft, getDraft, resetDrafts, initDrafts, flushDraft } from '../src/engine/draft-store.ts'
import { getSetting, setSetting, saveAttachment, getAttachmentRow } from '../src/storage/storage.ts'
import { initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { newStableId } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const DKEY = (id:string) => 'draft:'+id
const eq = (a:any,b:any) => JSON.stringify(a) === JSON.stringify(b)
async function mkAtt(): Promise<string> { const id = newStableId(); await saveAttachment({ id, name:'x.png', mimeType:'image/png', size:4, createdAt:1, updatedAt:1 } as any, new Blob([new Uint8Array([1,2,3,4])], { type:'image/png' })); return id }

initStore()

// 1) A text draft saved.
{ setDraftText('A','hello'); await flushDraft('A'); const s = await getSetting(DKEY('A')); assert(!!s && s.version===1 && s.text==='hello' && eq(s.imageIds,[]), 'A text persisted (version 1, no images)') }

// 2) reload/init restores A.
{ resetDrafts(); await initDrafts(['A']); assert(getDraft('A').text==='hello', 'A restored after reload/init') }

// 3) A / B each restored independently.
{ setDraftText('B','bbb'); await flushDraft('B'); resetDrafts(); await initDrafts(['A','B']); assert(getDraft('A').text==='hello' && getDraft('B').text==='bbb', 'A & B restored independently') }

// 4) draft image ids restored after reload.
{ await clearDraft('A'); const a = await mkAtt(); setDraftText('A','图示'); addDraftImages('A',[a]); await flushDraft('A'); resetDrafts(); await initDrafts(['A']); assert(eq(getDraft('A').imageIds,[a]) && getDraft('A').text==='图示', 'A image ids restored after reload') }

// 5) missing attachment automatically pruned (+ re-persisted).
{ await clearDraft('A'); const x = await mkAtt(); addDraftImages('A',[x,'missing-id']); await flushDraft('A'); resetDrafts(); await initDrafts(['A']); assert(eq(getDraft('A').imageIds,[x]), 'missing draft image pruned on init'); const persisted = await getSetting(DKEY('A')); assert(!!persisted && eq(persisted.imageIds,[x]), 'pruned draft re-persisted') }

// 6) corrupt draft JSON does not break boot.
{ await setSetting(DKEY('A'), 'not-an-object'); await setSetting(DKEY('B'), { version:1, text:'ok', imageIds:[] }); resetDrafts(); await initDrafts(['A','B']); assert(getDraft('A').text==='', 'corrupt A dropped (empty draft)'); assert((await getSetting(DKEY('A')))===undefined, 'corrupt A entry deleted'); assert(getDraft('B').text==='ok', 'valid B still loaded') }

// 7) clearDraft removes the persisted record.
{ setDraftText('A','x'); await flushDraft('A'); await clearDraft('A'); assert((await getSetting(DKEY('A')))===undefined, 'clearDraft removes the persisted record') }

// 8) clearDraft does NOT delete an attachment now owned by a message.
{ const a = await mkAtt(); addDraftImages('A',[a]); await flushDraft('A'); await clearDraft('A'); assert(!!(await getAttachmentRow(a)), 'clearDraft keeps the attachment (owned by a message)') }

// 9) deleting a conversation deletes its persisted draft.
{ const cid = await sessionsActions.newChat(); setDraftText(cid,'del-me'); await flushDraft(cid); await sessionsActions.remove(cid); assert((await getSetting(DKEY(cid)))===undefined, 'conversation removal deletes its persisted draft') }

// 10) deleting A does not affect B's draft.
{ const a = await sessionsActions.newChat(); const b = await sessionsActions.newChat(); setDraftText(a,'A-draft'); await flushDraft(a); setDraftText(b,'B-draft'); await flushDraft(b); await sessionsActions.remove(a); assert((await getSetting(DKEY(b)))!==undefined && getDraft(b).text==='B-draft', 'B draft unaffected by deleting A') }

// 11) empty draft leaves no storage row.
{ setDraftText('A',''); await flushDraft('A'); assert((await getSetting(DKEY('A')))===undefined, 'empty draft leaves no storage row') }

// 12) rapid text writes debounce to the final value.
{ setDraftText('A','a'); setDraftText('A','ab'); await new Promise(r=>setTimeout(r,650)); const s = await getSetting(DKEY('A')); assert(!!s && s.text==='ab', 'debounced text writes settle to final value (ab)') }

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

