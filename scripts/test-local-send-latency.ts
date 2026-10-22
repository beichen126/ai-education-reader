import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { initSettings, patchSettings } from '../src/engine/settings-store.ts'
import { initStore, sessionsActions, getSessionsStatus, getSessionsSendError } from '../src/engine/sessions-store.ts'
import { getConversation } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import { getLocalStatus } from '../src/api/openai-local.ts'
import { providerPreflight } from '../src/api/chat-provider.ts'
import { getSettingsSnapshot } from '../src/engine/settings-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://127.0.0.1:5173' } })
const originalFetch = globalThis.fetch
let release!: () => void, requested!: () => void, statusCalls = 0, chatCalls = 0
let gate = Promise.resolve(), began = Promise.resolve()
let nextStatus: any = { provider: 'openai-local', ready: true, auth: 'authorized', models: ['mock-model'], images: false }
function slowStatus() {
  gate = new Promise<void>(resolve => { release = resolve })
  began = new Promise<void>(resolve => { requested = resolve })
}
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).endsWith('/status')) {
    statusCalls++; requested?.()
    await Promise.race([gate, new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }))])
    return Response.json(nextStatus)
  }
  chatCalls++
  return new Response('data: {"type":"delta","text":"OK"}\n\ndata: {"type":"completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}) as typeof fetch
try {
  await initSettings(); await initStore()
  await patchSettings({ chatProvider: 'openai-local', openaiLocalModel: 'mock-model', webSearchEnabled: false })
  const id = await sessionsActions.newChat()
  slowStatus()
  const pending = sessionsActions.sendUserMessage(id, 'hello')
  await began
  assert.equal(getSessionsStatus(), 'sending', 'busy feedback starts while status is still pending')
  const duplicates = await Promise.all(Array.from({ length: 10 }, () => sessionsActions.sendUserMessage(id, 'hello')))
  assert.ok(duplicates.every(outcome => outcome.kind === 'rejected' && outcome.code === 'generation-busy'))
  assert.equal(statusCalls, 1); assert.equal(chatCalls, 0)
  assert.equal((await getConversation(id))?.messages.length, 0, 'no optimistic acceptance before preflight')
  release()
  assert.equal((await pending).kind, 'completed')
  assert.equal(statusCalls, 1, 'text sends do not repeat image capability checks')
  assert.equal(chatCalls, 1); assert.equal((await getConversation(id))?.messages.length, 2)
  assert.equal(getSessionsSendError(), undefined)
  const branch = await createBranchFromMessage(id, (await getConversation(id))!.messages[1].id)
  // Fresh settings checks bypass the positive send cache.
  nextStatus = { ...nextStatus, ready: false, errorCode: 'openai_network_unavailable' }
  await getLocalStatus()
  assert.equal((await providerPreflight(getSettingsSnapshot()))?.code, 'openai_network_unavailable', 'network failures are not authorization failures')
  nextStatus = { ...nextStatus, ready: true, errorCode: undefined }
  slowStatus()
  const cancel = runBranchReply(id, branch.id, 'cancel before acceptance')
  await began
  assert.equal(getSessionsStatus(), 'sending')
  sessionsActions.stopGenerating()
  assert.equal((await cancel).kind, 'aborted')
  assert.equal((await getBranch(branch.id))?.messages.length, 0, 'cancelled branch preflight never persists a message')
  assert.equal(getSessionsStatus(), 'idle')
  release()
  console.log('PASS: immediate busy state, ten rapid sends yield one request, no duplicate text/image checks, real errors preserved, cancellable branch preflight')
} finally { globalThis.fetch = originalFetch; closeDb() }
process.exit(0)
