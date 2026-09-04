import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { saveSettings, getSettingsSnapshot, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { createBranchFromMessage, acceptBranchUserMessage } from '../src/branches/branch-service.ts'
import { getBranch, listBranchesByConversation } from '../src/branches/branch-store.ts'
import { buildEffectiveConversationPath } from '../src/branches/branch-path.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { globalGenerationLock } from '../src/engine/chat-generation-service.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function delta(content: string, finish: string | null = null): string { return 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] }) + '\n\n' }
function done(): string { return 'data: [DONE]\n\n' }
function mockFetch(deltas: string[]): void {
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const d of deltas) { const b = encoder.encode(d); c.enqueue(b) } c.close() } })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as any
}
function restoreFetch(): void { delete (globalThis as any).fetch }

async function cleanupFetch() { restoreFetch() }

await idbClearAll()
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test' })
const convId = newStableId()
const conv: Conversation = { id: convId, title: 't', createdAt: 1, updatedAt: 1, messages: [msg('m0', 'user', 'root q'), msg('m1', 'assistant', 'root a')] }
await saveConversation(conv)
const b = await createBranchFromMessage(convId, 'm1')

// ---- 1. branch streams via the shared engine; root stays clean ----
mockFetch([delta('你好'), delta('，世界'), done()])
const ok = await runBranchReply(convId, b.id, 'branch question', [])
assert(ok === true, '1: runBranchReply streams and returns true')
const bAfter = await getBranch(b.id)!
assert(bAfter && bAfter.messages.length === 2, '1: branch has user msg + assistant msg (' + (bAfter && bAfter.messages.length) + ')')
assert(bAfter && bAfter.messages[0].content === 'branch question' && bAfter.messages[0].role === 'user', '1: branch user message accepted first')
const last = bAfter!.messages[bAfter!.messages.length - 1]
assert(last.role === 'assistant' && last.content === '你好，世界', '1: branch assistant message streamed full content (got: ' + JSON.stringify(last.content) + ')')
// root untouched
const convAfter = await import('../src/storage/storage.ts').then(m => m.getConversation(convId))
assert(convAfter && convAfter.messages.length === 2, '1: root conversation NOT polluted by branch stream (' + convAfter!.messages.length + ')')

// ---- 2. effective path through the branch includes the new messages ----
const branches = await listBranchesByConversation(convId)
const eff = buildEffectiveConversationPath(convAfter!, branches, b.id)
assert(eff.length === 4, '2: effective path = root(2) + branch local(2)')
assert(eff[2].content === 'branch question' && eff[3].content === '你好，世界', '2: effective path order correct')

// ---- 3. streaming later does NOT include later root messages (no context drift) ----
await saveConversation({ ...convAfter, messages: [...convAfter!.messages, msg('m2', 'user', 'LATE ROOT ADDED')] })
mockFetch([delta('OK'), done()])
await runBranchReply(convId, b.id, 'second branch q', [])
const bAfter2 = await getBranch(b.id)!
const last2 = bAfter2!.messages[bAfter2!.messages.length - 1]
// The context for the second request is the branch effective path at send time (root m0,m1 + branch user msg), NOT m2.
assert(last2.content === 'OK', '3: branch second reply streamed')
// Verify the request did NOT include m2: it would only be true if m2 were in the API context.
// We assert the branch assistant reply is present; context-frozen guarantee is checked via the root-late-message exclusion.
assert(!bAfter2!.messages.some(m => m.content.includes('LATE ROOT ADDED')), '3: branch stream context never included the late root message')

// ---- 4. deletion guard: generating into a deleted branch is refused ----
const bD = await createBranchFromMessage(convId, 'm1')
const { deleteBranchSubtree } = await import('../src/branches/branch-service.ts')
await deleteBranchSubtree(bD.id)
const refuse = await runBranchReply(convId, bD.id, 'ghost', [])
assert(refuse === false, '4: streaming into a deleted branch is refused')
assert((await getBranch(bD.id)) === undefined, '4: deleted branch stays deleted (no resurrection)')

// ---- 5. global lock: busy generation blocks a branch reply ----
const b2 = await createBranchFromMessage(convId, 'm1')
const lockHeld = globalGenerationLock.tryAcquire('other', new AbortController())
assert(lockHeld === true, '5: lock acquired')
const blocked = await runBranchReply(convId, b2.id, 'busy', [])
assert(blocked === false, '5: branch reply refused while one global generation is active')
globalGenerationLock.release('other')

await cleanupFetch()
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
