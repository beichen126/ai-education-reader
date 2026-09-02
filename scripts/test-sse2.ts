
import { SSEParser, streamTextChat, DeepSeekError } from '../src/api/deepseek.ts'
let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function delta(content:string):string{ return 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\n' }

// test 10: abort -> aborted kind
{
  const orig = globalThis.fetch
  const c = new AbortController()
  globalThis.fetch = ((_u:any, init:any) => { if((init as any).signal.aborted) return Promise.reject(new DOMException('aborted','AbortError')); return Promise.reject(new DOMException('aborted','AbortError')) }) as any
  c.abort()
  let kind=''
  try { await streamTextChat({ apiKey:'k', baseUrl:'https://api.deepseek.com', model:'m', messages:[], signal:c.signal, onDelta:()=>{} }) } catch(e){ kind=(e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind==='aborted', 'abort -> aborted kind (got '+kind+')')
}

// test 11: stream ends with a trailing event lacking a final blank line -> finish() flushes it
{
  const orig = globalThis.fetch
  const encoder = new TextEncoder()
  const text = delta('尾') + 'data: {"choices":[{"delta":{"content":"部"},"finish_reason":"stop"}]}'
  // no trailing blank line; and split mid-way to stress buffer
  const bytes = encoder.encode(text)
  const stream = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(bytes.subarray(0, 17)); c.enqueue(bytes.subarray(17)); c.close() } })
  globalThis.fetch = (async () => new Response(stream, { status:200 })) as any
  let acc=''; const r = await streamTextChat({ apiKey:'k', baseUrl:'https://api.deepseek.com', model:'m', messages:[], onDelta:d=>{acc+=d} })
  globalThis.fetch = orig
  assert(r.content==='尾部', 'finish() flushes trailing event; content=' + JSON.stringify(r.content))
  assert(acc==='尾部', 'onDelta called for trailing delta; acc=' + JSON.stringify(acc))
  assert(r.finishReason==='stop', 'finish_reason captured from trailing event')
}
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
