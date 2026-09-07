import 'fake-indexeddb/auto'
import { closeDb } from '../src/storage/idb.ts'
import { DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { generationRegistry } from '../src/engine/generation-registry.ts'
import { runThreadReply, type ReplyThread } from '../src/engine/stream-reply.ts'
import type { Message } from '../src/engine/types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
}) as any

const user: Message = { id: 'ownership-user', role: 'user', content: '问题', images: [], createdAt: 1, updatedAt: 1 }
let placeholderCreated = false
const thread: ReplyThread = {
  genKey: 'root:target',
  getContextMessages: () => [user],
  createAssistantPlaceholder: () => { placeholderCreated = true },
  updateAssistantContent: () => undefined,
  persistCheckpoint: () => undefined,
  persistFinal: async () => undefined,
  drainWrites: async () => undefined,
  exists: () => true,
  setStreaming: () => undefined,
  setIdle: () => undefined,
  setError: () => undefined,
}

generationRegistry.cancel()
const occupied = new AbortController()
assert(generationRegistry.begin('root:other', occupied, 'streaming'), 'test setup owns a different generation thread')
await runThreadReply(thread, { ...DEFAULT_SETTINGS, apiKey: 'sk-test' }, new AbortController())
assert(!placeholderCreated, 'occupied registry rejects a new thread before assistant placeholder')
assert(fetchCalls === 0, 'occupied registry rejects a new thread before network request')
generationRegistry.cancel()

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
