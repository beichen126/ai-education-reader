import { SSEParser, streamTextChat, DeepSeekError } from '../src/api/deepseek.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const delta = (content: string, finish?: string | null) => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ?? null }] }) + '\n\n'
const doneEvent = () => 'data: [DONE]\n\n'

// --- CRLF split EXACTLY between chunks (chunk A ends '\r', chunk B starts '\n') ---
{
  const p = new SSEParser()
  const a = p.feed('data: {"a":1}\r');
  const b = p.feed('\ndata: [DONE]\n\n');
  assert(a.length === 0, 'CRLF: no event from the half (trailing CR held)')
  assert(b.length === 2 && b[0] === '{"a":1}' && b[1] === '[DONE]', 'CRLF split -> event + done (got ' + JSON.stringify(b) + ')')
}

// --- bare CR line ending (no LF) ---
{
  const p = new SSEParser()
  const ev = p.feed('data: {\"a\":2}\r\rdata: [DONE]\r\n\r\n');
  assert(ev.length === 2 && ev[0] === '{\"a\":2}' && ev[1] === '[DONE]', 'bare CR line endings handled (got ' + JSON.stringify(ev) + ')')
}

// --- mixed CRLF and LF ---
{
  const p = new SSEParser()
  const ev = p.feed(delta('a').replace('\n\n', '\r\n\n') + delta('b') + doneEvent());
  assert(ev.length === 3, 'mixed CRLF/LF yields 3 events (got ' + ev.length + ')')
}


// --- arbitrary byte splitting (every possible split point of a full event) ---
{
  const full = delta('你好世界') + doneEvent()
  let ok = true
  for (let split = 1; split < full.length; split++) {
    const p = new SSEParser()
    const ev = [...p.feed(full.slice(0, split)), ...p.feed(full.slice(split)), ...p.finish()]
    if (!(ev.length === 2 && ev[0].includes('你好世界') && ev[1] === '[DONE]')) { ok = false; break }
  }
  assert(ok, 'any byte split point reconstructs the event + [DONE]')
}

// --- malformed non-empty JSON must throw bad-json (not silently empty) ---
{
  let kind = ''
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {not valid json}\n\n')); c.close() } })
  const orig = globalThis.fetch; globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as any
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'bad-json', 'malformed JSON event -> bad-json (got ' + kind + ')')
}

// --- comment-only stream (no data events) -> no-content on streamTextChat ---
{
  let kind = ''
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(': keepalive\n\n')); c.close() } })
  const orig = globalThis.fetch; globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as any
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'no-content', 'comment-only stream -> no-content (got ' + kind + ')')
}

// --- empty body (no events) -> no-content ---
{
  let kind = ''
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
  const orig = globalThis.fetch; globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as any
  try { await streamTextChat({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm', messages: [], onDelta: () => {} }) } catch (e) { kind = (e as DeepSeekError).kind }
  globalThis.fetch = orig
  assert(kind === 'no-content', 'empty body stream -> no-content (got ' + kind + ')')
}

// --- trailing event without a final blank line ---
{
  const p = new SSEParser()
  const a = p.feed('data: {"x":1}\n\n');
  const b = p.finish();
  assert(a.length === 1, 'trailing: first event emitted')
  assert(b.length === 0, 'trailing: no stray second event')
}

// --- [DONE] without blank line flush ---
{
  const p = new SSEParser()
  const a = p.feed('data: [DONE]');
  const b = p.finish();
  assert(a.length === 0 && b.length === 1 && b[0] === '[DONE]', '[DONE] flushed from trailing buffer')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)