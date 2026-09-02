
import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsStatus } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getConversation } from '../src/storage/storage.ts'
let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function delta(content:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\n' }
function deltaReason(content:string, fr:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:fr}]})+'\n\n' }
function done():string{ return 'data: [DONE]\n\n' }
let fetchMock: any
globalThis.fetch = ((...a:any[])=>fetchMock(...a)) as any
await initSettings(); await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'test-key-x', model:'deepseek-chat' })
await initStore()

// PARTIAL preserved on mid-stream failure (error AFTER delivering chunks, like real network)
{
  const id = await sessionsActions.newChat()
  const enc = new TextEncoder()
  fetchMock = async () => new Response(new ReadableStream<Uint8Array>({ start(c){ c.enqueue(enc.encode(delta('部分'))); c.enqueue(enc.encode(delta('内容'))); setTimeout(()=>c.error(new Error('socket closed')), 40) } }), { status:200 })
  await sessionsActions.sendUserMessage(id, '问题', [])
  await new Promise(r=>setTimeout(r,150))
  const conv = await getConversation(id); const msgs = conv ? conv.messages : []
  assert(msgs.length===2, 'user + partial assistant retained (got '+msgs.length+')')
  const ac = (msgs[1] as any).content
  assert(ac==='部分内容', 'partial assistant content retained (got '+JSON.stringify(ac)+')')
  assert(getSessionsStatus()==='error', 'status error after network failure')
}
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
