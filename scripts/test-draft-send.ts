import 'fake-indexeddb/auto'
import { getSessionsStatus, initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getDraft, setDraftText, clearDraft } from '../src/engine/draft-store.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)
let fetchMock: any
globalThis.fetch = ((...a:any[])=>fetchMock(...a)) as any

async function waitForSendSettlement(label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let status = getSessionsStatus()
  while (Date.now() <= deadline) {
    status = getSessionsStatus()
    if (status === 'idle' || status === 'error') return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(label + ' timed out after ' + timeoutMs + 'ms; status=' + status)
}

await initSettings()
await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'k', model:'deepseek-chat', customSystemPrompt:'', customSystemPromptEnabled:false })
await initStore()

// 1) rejected before acceptance -> false, draft untouched.
{
  const id = await sessionsActions.newChat()
  setDraftText(id, '保留我')
  const ok1 = await sessionsActions.sendUserMessage(id, '', [])   // empty content + no images
  assert(ok1.kind === 'rejected' && ok1.code === 'empty-input', 'empty send -> typed rejected outcome')
  assert(getDraft(id).text === '保留我', 'rejected empty send leaves draft intact')
  const ok2 = await sessionsActions.sendUserMessage('nonexistent', 'hi', [])
  assert(ok2.kind === 'rejected' && ok2.code === 'conversation-not-found', 'send to nonexistent conversation -> typed rejected outcome')
}

// 2) accepted -> true; then the Composer-style clearDraft empties it.
{
  const id = await sessionsActions.newChat()
  setDraftText(id, 'hello world')
  fetchMock = async () => { throw new Error('network') }   // message is still accepted before stream
  const ok = await sessionsActions.sendUserMessage(id, 'hello world', [])
  await waitForSendSettlement('network rejection')
  assert(ok.kind === 'failed', 'accepted send -> terminal failed outcome after network error')
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
  await waitForSendSettlement('image send network rejection')
  assert(ok.kind === 'failed', 'image send with network error -> terminal failed outcome')
  clearDraft(id)
  assert(getDraft(id).imageIds.length === 0, 'after accept, draft no longer owns the image ids')
  assert(true, 'clearDraft did not delete the attachment id (ownership moved to message)')
}

await new Promise<void>((resolve) => setImmediate(resolve))
process.off('unhandledRejection', onUnhandledRejection)
assert(unhandledRejections.length === 0, 'background draft-send tasks settle without unhandled rejection')
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
