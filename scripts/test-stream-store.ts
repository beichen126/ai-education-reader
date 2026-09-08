
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
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({ start(c){ for(const ch of chunks){ c.enqueue(enc.encode(ch)) } c.close() } })
}
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
  throw new Error('stream-store timed out; status=' + status + '; messages=' + JSON.stringify(messages))
}

await initSettings(); await saveSettings({ apiBaseUrl:'https://api.deepseek.com', apiKey:'test-key-x', model:'deepseek-chat' })
await initStore()

// SUCCESS streaming
{
  const id = await sessionsActions.newChat()
  // each event properly framed; also split an event mid-way to stress the parser
  const framed = delta('流水线') + delta('的') + delta('数据') + deltaReason('冒险', 'stop') + done()
  const bytes = new TextEncoder().encode(framed)
  const odd = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(bytes.subarray(0,19)); c.enqueue(bytes.subarray(19,41)); c.enqueue(bytes.subarray(41)); c.close() } })
  fetchMock = async () => new Response(odd, { status:200 })
  void sessionsActions.sendUserMessage(id, '解释一下', [])
  const msgs = await waitForSettled(id, (status, messages) => status === 'idle' && messages.length === 2 && messages[1].content === '流水线的数据冒险')
  assert(msgs.length===2, 'user + assistant messages (got '+msgs.length+')')
  assert(msgs[0].role==='user' && msgs[0].content==='解释一下', 'user content correct')
  const ac = (msgs[1] as any).content
  assert(ac==='流水线的数据冒险', 'assistant content = full concatenated deltas (got '+JSON.stringify(ac)+')')
  assert(typeof (msgs[1] as any).id==='string', 'assistant stable id')
  assert(getSessionsStatus()==='idle', 'status idle after success')
}

// PARTIAL preserved on mid-stream failure
{
  const id = await sessionsActions.newChat()
  const enc = new TextEncoder()
  fetchMock = async () => new Response(new ReadableStream<Uint8Array>({ start(c){ c.enqueue(enc.encode(delta('部分'))); c.enqueue(enc.encode(delta('内容'))); setTimeout(()=>c.error(new Error('socket closed')), 40) } }), { status:200 })
  void sessionsActions.sendUserMessage(id, '问题', [])
  const msgs = await waitForSettled(id, (status, messages) => status === 'error' && messages.length === 2 && messages[1].content === '部分内容')
  assert(msgs.length===2, 'user + partial assistant retained (got '+msgs.length+')')
  const ac = (msgs[1] as any).content
  assert(ac==='部分内容', 'partial assistant content retained (got '+JSON.stringify(ac)+')')
  assert(getSessionsStatus()==='error', 'status error after network failure')
}

// ABORT keeps partial
{
  const id = await sessionsActions.newChat()
  const enc = new TextEncoder()
  let markStreamStarted!: () => void
  let markChunkConsumed!: () => void
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let releasePendingRead: (() => void) | undefined
  const streamStarted = new Promise<void>((resolve) => { markStreamStarted = resolve })
  const chunkConsumed = new Promise<void>((resolve) => { markChunkConsumed = resolve })
  fetchMock = async (_u:any, init:any) => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { streamController = c; c.enqueue(enc.encode(delta('已生成'))); markStreamStarted() },
      pull() { markChunkConsumed(); return new Promise<void>((resolve) => { releasePendingRead = resolve }) },
    })
    ;(init as any).signal.addEventListener('abort', () => { streamController?.error(new DOMException('aborted','AbortError')); releasePendingRead?.() })
    return new Response(stream, { status:200 })
  }
  const p = sessionsActions.sendUserMessage(id, 'hey', [])
  await streamStarted
  await chunkConsumed
  sessionsActions.stopGenerating()
  await p.catch(()=>{})
  const msgs = await waitForSettled(id, (status, messages) => status === 'idle' && messages.length === 2 && messages[1].content === '已生成')
  assert(msgs.length===2 && (msgs[1] as any).content==='已生成', 'abort keeps partial content (got '+JSON.stringify((msgs[1] as any).content)+')')
  assert(getSessionsStatus()==='idle', 'abort -> status idle (not error)')
}

await new Promise<void>((resolve) => setImmediate(resolve))
process.off('unhandledRejection', onUnhandledRejection)
assert(unhandledRejections.length === 0, 'background stream tasks settle without unhandled rejection')
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
