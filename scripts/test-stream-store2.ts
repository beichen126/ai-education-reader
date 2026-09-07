
import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsStatus } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getConversation } from '../src/storage/storage.ts'
let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)
function delta(content:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\n' }
function deltaReason(content:string, fr:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:fr}]})+'\n\n' }
function done():string{ return 'data: [DONE]\n\n' }
let fetchMock: any
globalThis.fetch = ((...a:any[])=>fetchMock(...a)) as any
async function waitForSettled(id: string, expected: (status: string, messages: any[]) => boolean, timeoutMs = 2000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs
  let status = getSessionsStatus()
  let messages: any[] = []
  while (Date.now() <= deadline) {
    const conv = await getConversation(id)
    status = getSessionsStatus()
    messages = conv?.messages ?? []
    if (expected(status, messages)) return messages
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('stream-store2 timed out; status=' + status + '; messages=' + JSON.stringify(messages))
}
await initSettings(); await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'test-key-x', model:'deepseek-chat' })
await initStore()

// PARTIAL preserved on mid-stream failure (error AFTER delivering chunks, like real network)
{
  const id = await sessionsActions.newChat()
  const enc = new TextEncoder()
  fetchMock = async () => new Response(new ReadableStream<Uint8Array>({ start(c){ c.enqueue(enc.encode(delta('部分'))); c.enqueue(enc.encode(delta('内容'))); setTimeout(()=>c.error(new Error('socket closed')), 40) } }), { status:200 })
  await sessionsActions.sendUserMessage(id, '问题', [])
  const msgs = await waitForSettled(id, (status, messages) => status === 'error' && messages.length === 2 && messages[1].content === '部分内容')
  assert(msgs.length===2, 'user + partial assistant retained (got '+msgs.length+')')
  const ac = (msgs[1] as any).content
  assert(ac==='部分内容', 'partial assistant content retained (got '+JSON.stringify(ac)+')')
  assert(getSessionsStatus()==='error', 'status error after network failure')
}
await new Promise<void>((resolve) => setImmediate(resolve))
process.off('unhandledRejection', onUnhandledRejection)
assert(unhandledRejections.length === 0, 'background stream tasks settle without unhandled rejection')
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
