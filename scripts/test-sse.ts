
import { SSEParser, streamTextChat, DeepSeekError, sendTextChat } from '../src/api/deepseek.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string){ if(c){ pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function sseEvents(...parts: string[]): string { return parts.join('') }
function delta(content: string, finish?: string | null): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ?? null }] }) + '\n\n'
}
function doneEvent(): string { return 'data: [DONE]\n\n' }

// ---- test 1: SSEParser, one event one chunk ----
{
  const p = new SSEParser()
  const ev = p.feed('data: {"a":1}\n\n')
  assert(ev.length === 1 && ev[0] === '{"a":1}', 'one event in one chunk')
}

// ---- test 2: one event split across chunks (mid JSON) ----
{
  const p = new SSEParser()
  const a = p.feed('data: {"choices":[{"delta":{"content":"你')
  const b = p.feed('好"}}]}\n\n')
  assert(a.length === 0, 'no complete event yet when cut mid JSON')
  assert(b.length === 1 && b[0].includes('你') && b[0].includes('好'), 'event completed after second chunk (mid-JSON split)')
}

// ---- test 3: one chunk with multiple events ----
{
  const p = new SSEParser()
  const ev = p.feed(delta('a') + delta('b') + doneEvent())
  assert(ev.length === 3, 'one chunk with multiple events -> 3 events')
  assert(ev[0].includes('a') && ev[1].includes('b') && ev[2] === '[DONE]', 'event contents correct')
}

// ---- test 4: JSON cut exactly mid string across chunks ----
{
  const p = new SSEParser()
  const ev = p.feed('data: {"choices":[{"delta":{"content":"流水线的数据冒险主要"')
  const ev2 = p.feed('……"}}]}\n\ndata: [DONE]\n\n')
  assert(ev.length === 0, 'cut mid string yields no event')
  assert(ev2.length === 2 && ev2[0].includes('数据冒险') && ev2[1] === '[DONE]', 'reassembled mid-string + done')
}

// ---- test 5: multiple content deltas concatenate (via streamTextChat) ----
async function runStream(chunks: string[], expect: string): Promise<string> {
  let calls = 0
  const encoder = new TextEncoder()
  // build a ReadableStream from awkward byte boundaries
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) { const b = encoder.encode(ch); c.enqueue(b.subarray(0, Math.floor(b.length/2))); c.enqueue(b.subarray(Math.floor(b.length/2))) } c.close() },
  })
  const orig = globalThis.fetch
  const origRes = globalThis.Response
  globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as any
  let acc = ''
  const r = await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', messages: [], onDelta: d => { acc += d; calls++ } })
  globalThis.fetch = orig
  return acc + '__' + r.content + '__calls' + calls
}
// ---- stream accumulation across split chunks ----
{
  const res = await runStream([delta('你好'), delta('，世界'), doneEvent()], '你好，世界')
  const [acc, content] = res.split('__')
  assert(content === '你好，世界', 'streamTextChat aggregates all deltas to full content (got ' + content + ')')
}

// ---- test 6: empty delta skipped ----
{
  const res = await runStream([ 'data: {"choices":[{"delta":{}}]}\n\n', delta('ok'), doneEvent() ], 'ok')
  const [acc, content] = res.split('__')
  assert(content === 'ok', 'empty delta does not corrupt content')
}

// ---- test 7: [DONE] terminates ----
{
  const res = await runStream([delta('done'), doneEvent()], 'done')
  const [acc, content] = res.split('__')
  assert(content === 'done', '[DONE] terminates stream, content correct')
}

// ---- test 8: HTTP non-2xx ----
{
  const orig = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as any
  let kind = ''
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'unauthorized', 'non-2xx 401 -> unauthorized kind')
}

// ---- test 9: network mid-stream failure throws network-or-cors ----
{
  const orig = globalThis.fetch
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); c.error(new Error('socket closed')) },
  })
  globalThis.fetch = (async () => new Response(stream, { status: 200 })) as any
  let kind = ''
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'network-or-cors', 'mid-stream failure -> network-or-cors')
}

// ---- test 10: AbortController ----
{
  const orig = globalThis.fetch
  globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => { const sig = (init as any).signal; if (sig.aborted) { rej(new DOMException('aborted', 'AbortError')); return } sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))) })) as any
  const c = new AbortController(); c.abort()
  let kind = ''
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], signal: c.signal, onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'aborted', 'abort -> aborted kind')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
