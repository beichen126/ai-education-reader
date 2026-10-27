import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { initSettings, patchSettings, getSettingsSnapshot } from '../src/engine/settings-store.ts'
import { closeDb } from '../src/storage/idb.ts'
import { providerPreflight, streamProviderChat } from '../src/api/chat-provider.ts'
import { streamLocalChat, LocalProviderError, localErrorLabel, pairLocalService, disconnectLocalService, getLocalStatus } from '../src/api/openai-local.ts'

const originalFetch = globalThis.fetch
Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://127.0.0.1:5173' } })
let calls: { url: string; init: RequestInit }[] = []
const capture = (response: () => Response) => { globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init: init || {} }); return response() }) as typeof fetch }
try {
  await initSettings()
  assert.ok(localErrorLabel('invalid_status').includes('格式'))
  assert.ok(localErrorLabel('unexpected_provider_error').includes('unexpected_provider_error'))
  assert.ok(!localErrorLabel('unexpected_provider_error').includes('服务不可用'))
  assert.equal(getSettingsSnapshot().chatProvider, 'deepseek')
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'no-api-key')
  await patchSettings({ apiKey: 'test-only-deepseek', model: 'deepseek-flash', chatProvider: 'openai-local', openaiLocalModel: 'mock-model' })
  await initSettings()
  assert.equal(getSettingsSnapshot().chatProvider, 'openai-local')
  assert.equal(getSettingsSnapshot().apiKey, 'test-only-deepseek')
  capture(() => Response.json({ provider: 'openai-local', ready: false, auth: 'authorization-not-verified', models: [], images: false }))
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'authorization_not_verified')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://beichen126.github.io' } })
  calls = []
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'pairing_required'); assert.equal(calls.length, 0)
  capture(() => Response.json({ paired: true, session: 'a'.repeat(43) }))
  await pairLocalService('test-pair')
  assert.equal(calls.at(-1)?.init.credentials, 'omit')
  capture(() => Response.json({ provider: 'openai-local', ready: true, auth: 'authorized', models: ['mock-model'], images: false }))
  assert.equal(await providerPreflight(getSettingsSnapshot()), undefined)
  await patchSettings({ webSearchEnabled: true })
  assert.equal(await providerPreflight(getSettingsSnapshot()), undefined)
  await patchSettings({ webSearchEnabled: false })
  assert.equal(new Headers(calls.at(-1)?.init.headers).get('X-Reader-Session'), 'a'.repeat(43))
  await disconnectLocalService()
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'pairing_required')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://evil.test' } })
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'local_only')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://127.0.0.1:5173' } })
  capture(() => new Response('data: {"type":"delta","text":"你好"}\n\ndata: {"type":"completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  let text = ''
  assert.equal((await streamProviderChat(getSettingsSnapshot(), { apiKey: 'DO_NOT_FORWARD', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', messages: [{ role: 'user', content: 'selected context' }], onDelta: delta => { text += delta } })).content, '你好')
  assert.equal(text, '你好')
  assert.equal(calls.at(-1)?.url, 'http://127.0.0.1:8091/chat')
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /DO_NOT_FORWARD|Authorization|apiKey/)
  assert.equal(JSON.parse(String(calls.at(-1)?.init.body)).model, 'mock-model')
  const longReply = new AbortController()
  await streamLocalChat({model:'mock-model',messages:[],signal:longReply.signal,onDelta:()=>{}})
  assert.equal(calls.at(-1)?.init.signal,longReply.signal,'long replies use caller cancellation, not a 3-minute wall-clock signal')
  assert.ok(localErrorLabel('request_idle_timeout').includes('15 分钟'))
  assert.ok(!localErrorLabel('request_cancelled').includes('超时'))
  capture(() => new Response('data: {"type":"delta","text":"partial"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamLocalChat({ model: 'mock-model', messages: [], onDelta: () => {} }), (error: unknown) => error instanceof LocalProviderError && error.code === 'stream_incomplete')
  await patchSettings({ chatProvider: 'deepseek' })
  calls = []
  assert.equal(await providerPreflight(getSettingsSnapshot()), undefined); assert.equal(calls.length, 0)
  capture(() => new Response('data: {"choices":[{"delta":{"content":"original"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const args = { apiKey: 'test-only-deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', messages: [{ role: 'user' as const, content: 'hello' }], onDelta: () => {} }
  assert.equal((await streamProviderChat(getSettingsSnapshot(), args)).content, 'original')
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(JSON.parse(String(calls[0].init.body)).reasoning_effort, 'max')
  // Native cached errors must be recoverable; subscribe before asking native to refresh.
  const host = globalThis as any
  const initial = { provider: 'openai-local', ready: false, auth: 'authorized', login: 'error', errorCode: 'openai_network_unavailable', models: [] }
  const ready = { ...initial, ready: true, login: 'authorized', errorCode: null, models: ['mock-model'] }
  let listener: ((status: unknown) => void) | undefined
  let refreshes = 0
  host.AndroidChatGpt = { status: () => JSON.stringify(initial), refreshStatus: () => { refreshes++; listener?.(ready) } }
  host.__androidChatGpt = { subscribeStatus: (next: (value: unknown) => void) => { listener = next; return () => { listener = undefined } } }
  try {
    assert.equal((await getLocalStatus()).ready, true)
    assert.equal(refreshes, 1); assert.equal(listener, undefined)
    host.AndroidChatGpt.refreshStatus = () => {}
    const controller = new AbortController()
    const waiting = getLocalStatus(controller.signal)
    controller.abort()
    await assert.rejects(waiting, (error: unknown) => error instanceof LocalProviderError && error.code === 'request_cancelled')
    assert.equal(listener, undefined)
    host.__androidChatGpt.subscribeStatus = (next: (value: unknown) => void) => { next(ready); return () => { listener = undefined } }
    assert.equal((await getLocalStatus()).ready, true)
  } finally { delete host.AndroidChatGpt; delete host.__androidChatGpt }
  console.log('PASS: provider persistence, isolation, Pages memory-only pairing, untrusted-origin rejection, no key forwarding, completion requirement, unchanged DeepSeek max reasoning')
} finally { globalThis.fetch = originalFetch; closeDb() }
