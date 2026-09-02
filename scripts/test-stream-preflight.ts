import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsStatus, getSessionsSendError } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { saveAttachment } from '../src/storage/storage.ts'
import { getConversation } from '../src/storage/storage.ts'
import { newStableId } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function delta(content:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\n' }
function deltaReason(content:string, fr:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:fr}]})+'\n\n' }
function done():string{ return 'data: [DONE]\n\n' }
let fetchMock: any
globalThis.fetch = ((...a:any[])=>fetchMock(...a)) as any

async function mkAttachment(): Promise<string> {
  const id = newStableId()
  const meta = { id, name:'x.png', mimeType:'image/png', size:4, createdAt:1, updatedAt:1 }
  await saveAttachment(meta as any, new Blob([new Uint8Array([137,80,78,71])], { type:'image/png' }))
  return id
}

await initSettings()

// 1) vision-unsupported preflight -> NO ghost assistant, correct error (not a fetch).
{
  await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'k', model:'deepseek-chat', customSystemPrompt:'', customSystemPromptEnabled:false })
  await initStore()
  const id = await sessionsActions.newChat()
  fetchMock = async () => { throw new Error('should not fetch') }
  await sessionsActions.sendUserMessage(id, '描述图', ['missing-id'])
  await new Promise(r=>setTimeout(r,50))
  const conv = await getConversation(id); const msgs = conv ? conv.messages : []
  assert(msgs.length === 1, 'vision-unsupported leaves NO assistant placeholder (msgs='+msgs.length+')')
  assert(getSessionsStatus()==='error', 'vision-unsupported -> status error')
  const se = getSessionsSendError() || ''
  assert(se.includes('支持') && se.includes('Vision') || se.includes('Vision'), 'vision error label mentions model support (got '+JSON.stringify(se)+')')
}

// 2) missing historical attachment -> attachment error, NOT network/CORS; no ghost.
{
  await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'k', model:'deepseek-vision', customSystemPrompt:'', customSystemPromptEnabled:false })
  await initStore()
  const id = await sessionsActions.newChat()
  fetchMock = async () => { throw new Error('should not fetch') }
  await sessionsActions.sendUserMessage(id, '解释', ['missing-id'])
  await new Promise(r=>setTimeout(r,50))
  const conv = await getConversation(id); const msgs = conv ? conv.messages : []
  assert(msgs.length === 1, 'missing historical attachment leaves NO assistant placeholder (msgs='+msgs.length+')')
  assert(getSessionsStatus()==='error', 'missing attachment -> status error')
  const se = getSessionsSendError() || ''
  assert(se.includes('附件') && se.includes('丢失'), 'attachment error label kept (got '+JSON.stringify(se)+')')
  assert(!se.includes('网络') && !se.includes('CORS'), 'missing attachment NOT reported as network/CORS (got '+JSON.stringify(se)+')')
}

// 3) success with a real attachment on a vision model -> one stable assistant message + content.
{
  await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'k', model:'deepseek-vision', customSystemPrompt:'', customSystemPromptEnabled:false })
  await initStore()
  const id = await sessionsActions.newChat()
  const imgId = await mkAttachment()
  const framed = delta('图示') + deltaReason('完成', 'stop') + done()
  const bytes = new TextEncoder().encode(framed)
  fetchMock = async () => new Response(new ReadableStream<Uint8Array>({ start(c){ c.enqueue(bytes); c.close() } }), { status:200 })
  await sessionsActions.sendUserMessage(id, '解释图', [imgId])
  await new Promise(r=>setTimeout(r,80))
  const conv = await getConversation(id); const msgs = conv ? conv.messages : []
  assert(msgs.length === 2, 'success -> user + ONE assistant (msgs='+msgs.length+')')
  assert(msgs[1].role === 'assistant', 'second message is assistant')
  assert(msgs[1].content === '图示完成', 'assistant content aggregated (got '+JSON.stringify(msgs[1].content)+')')
  assert(getSessionsStatus()==='idle', 'success -> status idle')
}

// 4) mid-stream network failure after partial -> content preserved, still ONE assistant.
{
  await initStore()
  const id = await sessionsActions.newChat()
  const enc = new TextEncoder()
  fetchMock = async () => new Response(new ReadableStream<Uint8Array>({ start(c){ c.enqueue(enc.encode(delta('部分'))); c.enqueue(enc.encode(delta('内容'))); setTimeout(()=>c.error(new Error('socket')), 40) } }), { status:200 })
  await sessionsActions.sendUserMessage(id, '问题', [])
  await new Promise(r=>setTimeout(r,140))
  const conv = await getConversation(id); const msgs = conv ? conv.messages : []
  assert(msgs.length === 2, 'mid-stream failure -> user + ONE partial assistant (msgs='+msgs.length+')')
  assert(msgs[1].content === '部分内容', 'partial assistant content preserved (got '+JSON.stringify(msgs[1].content)+')')
  assert(getSessionsStatus()==='error', 'mid-stream failure -> status error')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

