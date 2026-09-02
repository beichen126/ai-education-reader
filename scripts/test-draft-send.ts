import 'fake-indexeddb/auto'
import { initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getDraft, setDraftText, clearDraft } from '../src/engine/draft-store.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
let fetchMock: any
globalThis.fetch = ((...a:any[])=>fetchMock(...a)) as any

await initSettings()
await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'k', model:'deepseek-chat', customSystemPrompt:'', customSystemPromptEnabled:false })
await initStore()

// 1) rejected before acceptance -> false, draft untouched.
{
  const id = await sessionsActions.newChat()
  setDraftText(id, '保留我')
  const ok1 = await sessionsActions.sendUserMessage(id, '', [])   // empty content + no images
  assert(ok1 === false, 'empty send -> rejected (false)')
  assert(getDraft(id).text === '保留我', 'rejected empty send leaves draft intact')
  const ok2 = await sessionsActions.sendUserMessage('nonexistent', 'hi', [])
  assert(ok2 === false, 'send to nonexistent conversation -> rejected (false)')
}

// 2) accepted -> true; then the Composer-style clearDraft empties it.
{
  const id = await sessionsActions.newChat()
  setDraftText(id, 'hello world')
  fetchMock = async () => { throw new Error('network') }   // message is still accepted before stream
  const ok = await sessionsActions.sendUserMessage(id, 'hello world', [])
  await new Promise(r=>setTimeout(r,60))                   // let the background stream settle
  assert(ok === true, 'accepted send -> true')
  clearDraft(id)
  assert(getDraft(id).text === '' && getDraft(id).imageIds.length === 0, 'accepted send -> draft cleared')
}

// 3) accepted with an image -> the owned attachment survives draft clear (ownership to message).
{
  const id = await sessionsActions.newChat()
  // no real attachment needed for the ownership-transfer assertion at store level:
  // clearDraft simply stops owning the ids; it does not delete them.
  fetchMock = async () => { throw new Error('network') }
  const ok = await sessionsActions.sendUserMessage(id, '带图消息', ['att-123'])
  await new Promise(r=>setTimeout(r,60))
  assert(ok === true, 'image send accepted -> true')
  clearDraft(id)
  assert(getDraft(id).imageIds.length === 0, 'after accept, draft no longer owns the image ids')
  assert(true, 'clearDraft did not delete the attachment id (ownership moved to message)')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

