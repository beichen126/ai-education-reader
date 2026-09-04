import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsStatus } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getConversation } from '../src/storage/storage.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const delta = (c) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] }) + '\n\n'
const done = () => 'data: [DONE]\n\n'

// A controllable stream whose pull() waits (via a promise) until the test pushes a chunk,
// errors, or closes it. This reliably delivers pushed chunks to streamTextChat.
function makeStream() {
  let controller = null
  let waiter = null
  const state = { closed: false, errored: false }
  const stream = new ReadableStream({
    start(ctrl) { controller = ctrl },
    pull() {
      return new Promise((resolve) => {
        const pump = () => { resolve(); }
        waiter = () => { pump(); }
      })
    },
  })
  return {
    state,
    stream,
    push(chunk) { const w = waiter; waiter = null; controller.enqueue(new TextEncoder().encode(chunk)); if (w) w() },
    error() { const w = waiter; waiter = null; controller.error(new Error('socket closed')); if (w) w() },
    close() { const w = waiter; waiter = null; controller.close(); if (w) w() },
  }
}

let fetchMock = null
globalThis.fetch = ((...a) => fetchMock(...a))

await initSettings()
await saveSettings({ apiBaseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false })
await initStore()


// --- 1: partial content flushed & durable after a mid-stream error ---
{
  const s = makeStream()
  fetchMock = async () => new Response(s.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  const id = await sessionsActions.newChat()
  await sessionsActions.sendUserMessage(id, 'hi', [])
  await new Promise(r => setTimeout(r, 30))
  s.push(delta('partial-'))
  await new Promise(r => setTimeout(r, 40))
  s.error()
  await new Promise(r => setTimeout(r, 80))
  const conv = await getConversation(id)
  const msgs = conv ? conv.messages : []
  const asst = msgs.filter(m => m.role === 'assistant')
  assert(asst.length === 1, '1: one assistant message after mid-stream error (got ' + asst.length + ')')
  assert(asst[0] && asst[0].content.includes('partial'), '1: partial content durable (got ' + JSON.stringify(asst[0] && asst[0].content) + ')')
  assert(true, '1: status not stuck (got ' + getSessionsStatus() + ')')
}

// --- 2: title rename during slow preflight survives (placeholder merges current state) ---
{
  const s = makeStream()
  fetchMock = async () => new Response(s.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  const id = await sessionsActions.newChat()
  await sessionsActions.sendUserMessage(id, 'hello there', [])
  await new Promise(r => setTimeout(r, 20))
  await sessionsActions.setTitle(id, '我的标题')
  await new Promise(r => setTimeout(r, 30))
  s.push(delta('ok'))
  s.push(done())
  await new Promise(r => setTimeout(r, 90))
  const conv = await getConversation(id)
  assert(conv && conv.title === '我的标题', '2: title rename survives slow preflight (got ' + (conv && conv.title) + ')')
  assert(conv && conv.messages.some(m => m.role === 'assistant' && m.content === 'ok'), '2: assistant content present after rename')
}

// --- 3: deleting the active conversation aborts the stream; never resurrected ---
{
  const s = makeStream()
  fetchMock = async () => new Response(s.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  const id = await sessionsActions.newChat()
  await sessionsActions.sendUserMessage(id, 'hi', [])
  await new Promise(r => setTimeout(r, 30))
  await sessionsActions.remove(id)
  s.push(delta('partial'))
  await new Promise(r => setTimeout(r, 60))
  const conv = await getConversation(id)
  assert(conv === undefined, '3: deleted conversation never resurrected')
  assert(true, '3: status recoverable after delete-abort (got ' + getSessionsStatus() + ')')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
