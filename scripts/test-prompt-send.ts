import 'fake-indexeddb/auto'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { getConversation, saveConversation } from '../src/storage/storage.ts'
import { saveSettings, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { sessionsActions } from '../src/engine/sessions-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { prepareAcceptedSendContext } from '../src/prompts/prompt-send.ts'
import { projectLogicalPromptContext } from '../src/prompts/prompt-compile-strategies.ts'
import { savePromptRecord, deletePromptRecord } from '../src/prompts/prompt-store.ts'
import { setDefaultConversationModeId } from '../src/prompts/prompt-preferences.ts'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import type { PromptSnapshot } from '../src/prompts/prompt-types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function snapshot(id: string, name: string, content: string, revision = 1): PromptSnapshot {
  return { profileId: id, kind: 'conversation-mode', name, content, revision, source: 'custom', capturedAt: revision }
}
function definition(id: string, name: string, content: string, revision = 1): any {
  return { id, kind: 'conversation-mode', name, description: name, source: 'custom', enabled: true, createdAt: 1, updatedAt: revision, revision, systemPrompt: content }
}
function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1 }
}
function deltaDone(): string { return 'data: [DONE]\n\n' }

let requests: any[] = []
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body || '{}')))
  return new Response(deltaDone(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}) as any

await idbClearAll()
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat' })
const modeA = definition('mode-a', '模式 A', 'A prompt')
const modeB = definition('mode-b', '模式 B', 'B prompt')
const modeC = definition('mode-c', '模式 C', 'C prompt')
await savePromptRecord(modeA)
await savePromptRecord(modeB)
await savePromptRecord(modeC)
await setDefaultConversationModeId(modeA.id)

// Root send: transition + user message are both durable before the stream starts.
const conversationId = await sessionsActions.newChat()
requests = []
assert(await sessionsActions.sendUserMessage(conversationId, 'first', []), 'root send accepts through the canonical path')
await new Promise((resolve) => setTimeout(resolve, 50))
let conversation = await getConversation(conversationId) as Conversation
assert(conversation.messages.length === 2, 'root acceptance stores user plus streamed assistant')
assert(conversation.promptTransitions?.length === 1 && conversation.promptTransitions[0].snapshot.content === 'A prompt', 'root acceptance stores the mode transition with the user message')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('A prompt'), 'request uses the accepted frozen mode snapshot')

// A mode switch creates one new boundary; it does not rewrite the previous snapshot.
await setDefaultConversationModeId(modeB.id)
requests = []
assert(await sessionsActions.sendUserMessage(conversationId, 'second', []), 'mode B send accepts')
await new Promise((resolve) => setTimeout(resolve, 50))
conversation = await getConversation(conversationId) as Conversation
assert(conversation.promptTransitions?.map((item) => item.snapshot.content).join('|') === 'A prompt|B prompt', 'A to B creates a second ordered transition')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('B prompt'), 'mode B request uses B without changing A history')

// Profile edits after acceptance cannot change the already prepared logical request.
const before = conversation.messages
const frozen = await prepareAcceptedSendContext({
  threadRef: { type: 'root', conversationId },
  messagesBeforeAcceptance: before,
  candidateMessages: [...before, msg('frozen-user', 'user', 'frozen')],
  effectiveTransitions: conversation.promptTransitions ?? [],
  localTransitions: conversation.promptTransitions ?? [],
  acceptedMessageId: 'frozen-user',
  currentModeSnapshot: snapshot(modeB.id, '模式 B', 'B prompt', 1),
  now: 10,
})
await savePromptRecord(definition(modeB.id, '模式 B', 'B prompt edited after send', 2))
const frozenProjected = await projectLogicalPromptContext(frozen.context.logical, frozen.context.compilePolicy.systemMessagePolicy)
assert(JSON.stringify(frozenProjected).includes('B prompt') && !JSON.stringify(frozenProjected).includes('edited after send'), 'profile revision after acceptance cannot alter the frozen request')

// Branch send inherits root history but stores a branch-local mode transition only.
const forkMessageId = conversation.messages[conversation.messages.length - 1].id
const branch = await createBranchFromMessage(conversationId, forkMessageId)
await setDefaultConversationModeId(modeC.id)
requests = []
// The branch path is read before acceptance and becomes the sole input to compile + stream.
assert(await (await import('../src/engine/branch-thread.ts')).runBranchReply(conversationId, branch.id, 'branch', []), 'branch send accepts through the same semantic pipeline')
await new Promise((resolve) => setTimeout(resolve, 50))
const branchAfter = await getBranch(branch.id) as ConversationBranch
const rootAfterBranch = await getConversation(conversationId) as Conversation
assert(branchAfter.promptTransitions?.some((item) => item.snapshot.content === 'C prompt') === true, 'branch stores its local mode transition')
assert(rootAfterBranch.promptTransitions?.map((item) => item.snapshot.content).join('|') === 'A prompt|B prompt', 'branch send does not mutate root timeline')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('C prompt'), 'branch request uses inherited timeline plus local mode')
assert(rootAfterBranch.messages.every((item) => item.content !== 'branch'), 'branch user message does not pollute root')

// Invalid timeline is rejected before acceptance; no caller should commit its candidate.
const badConversation: Conversation = {
  id: 'bad', title: 'bad', createdAt: 1, updatedAt: 1,
  messages: [msg('bad-m0', 'user', 'bad')],
}
await saveConversation(badConversation)
let rejected = false
try {
  await prepareAcceptedSendContext({
    threadRef: { type: 'root', conversationId: 'bad' },
    messagesBeforeAcceptance: badConversation.messages,
    candidateMessages: [...badConversation.messages, msg('bad-m1', 'user', 'new')],
    effectiveTransitions: [
      { id: 't1', afterMessageId: null, snapshot: snapshot('mode-a', '模式 A', 'A prompt'), createdAt: 1 },
      { id: 't2', afterMessageId: null, snapshot: snapshot('mode-b', '模式 B', 'B prompt'), createdAt: 2 },
    ],
    localTransitions: [],
    acceptedMessageId: 'bad-m1',
    currentModeSnapshot: snapshot('mode-a', '模式 A', 'A prompt'),
  })
} catch { rejected = true }
assert(rejected, 'invalid prompt timeline fails before message acceptance')
assert((await getConversation('bad'))?.messages.length === 1, 'compile failure leaves the durable conversation unchanged')

await deletePromptRecord(modeA.id)
await deletePromptRecord(modeB.id)
await deletePromptRecord(modeC.id)
await closeDb()
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
