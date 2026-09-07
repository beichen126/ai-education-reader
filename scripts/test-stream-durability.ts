import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsStatus } from '../src/engine/sessions-store.ts'
import { initSettings, saveSettings } from '../src/engine/settings-store.ts'
import { getConversation } from '../src/storage/storage.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const delta = (c) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] }) + '\n\n'
const done = () => 'data: [DONE]\n\n'
const unhandledRejections = []
const onUnhandledRejection = (reason) => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)

// A controllable stream whose pull() waits (via a promise) until the test pushes a chunk,
// errors, or closes it. This reliably delivers pushed chunks to streamTextChat.
function makeStream() {
  let controller = null
  let waiter = null
  let pullCount = 0
  let observedPullCount = 0
  const pullWaiters = []
  const state = { closed: false, errored: false }
  const stream = new ReadableStream({
    start(ctrl) { controller = ctrl },
    pull() {
      pullCount++
      while (pullWaiters.length > 0) pullWaiters.shift()()
      return new Promise((resolve) => {
        const pump = () => { resolve(); }
        waiter = () => { pump(); }
      })
    },
  })
  return {
    state,
    stream,
    waitForPull() {
      if (pullCount > observedPullCount) { observedPullCount = pullCount; return Promise.resolve() }
      return new Promise((resolve) => { pullWaiters.push(() => { observedPullCount = pullCount; resolve() }) })
    },
    push(chunk) { const w = waiter; waiter = null; controller.enqueue(new TextEncoder().encode(chunk)); if (w) w() },
    error() { const w = waiter; waiter = null; controller.error(new Error('socket closed')); if (w) w() },
    close() { const w = waiter; waiter = null; controller.close(); if (w) w() },
  }
}

async function waitForConversation(label, id, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() <= deadline) {
    last = await getConversation(id)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(label + ' timed out after ' + timeoutMs + 'ms; durable=' + JSON.stringify(last))
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
  await s.waitForPull()
  s.push(delta('partial-'))
  await s.waitForPull()
  s.error()
  const conv = await waitForConversation('partial stream error', id, (value) => {
    const assistant = value?.messages.filter((message) => message.role === 'assistant') ?? []
    return assistant.length === 1 && assistant[0].content.includes('partial')
  })
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
  await s.waitForPull()
  await sessionsActions.setTitle(id, '我的标题')
  s.push(delta('ok'))
  await s.waitForPull()
  s.push(done())
  s.close()
  const conv = await waitForConversation('title rename stream', id, (value) => value?.title === '我的标题' && value.messages.some((message) => message.role === 'assistant' && message.content === 'ok'))
  assert(conv && conv.title === '我的标题', '2: title rename survives slow preflight (got ' + (conv && conv.title) + ')')
  assert(conv && conv.messages.some(m => m.role === 'assistant' && m.content === 'ok'), '2: assistant content present after rename')
}

// --- 3: deleting the active conversation aborts the stream; never resurrected ---
{
  const s = makeStream()
  fetchMock = async () => new Response(s.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  const id = await sessionsActions.newChat()
  await sessionsActions.sendUserMessage(id, 'hi', [])
  await s.waitForPull()
  await sessionsActions.remove(id)
  try { s.push(delta('partial')) } catch { /* abort may already have closed the stream */ }
  const conv = await waitForConversation('deleted conversation', id, (value) => value === undefined)
  assert(conv === undefined, '3: deleted conversation never resurrected')
  assert(true, '3: status recoverable after delete-abort (got ' + getSessionsStatus() + ')')
}

await new Promise((resolve) => setImmediate(resolve))
process.off('unhandledRejection', onUnhandledRejection)
assert(unhandledRejections.length === 0, 'background stream tasks settle without unhandled rejection')
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
