import 'fake-indexeddb/auto'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getConversation, saveConversation } from '../src/storage/storage.ts'
import { appendConversationPromptTransition } from '../src/prompts/prompt-transition-service.ts'
import type { PromptSnapshot, PromptTransition } from '../src/prompts/prompt-types.ts'
import type { Conversation } from '../src/engine/types.ts'
import { appendPromptTransition, promptTransitionBoundaries, replacePromptTransitionAtHead } from '../src/prompts/prompt-timeline.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

function snapshot(name: string, revision: number): PromptSnapshot {
  return { profileId: 'mode-' + name, kind: 'conversation-mode', name, content: name, revision, source: 'custom', capturedAt: revision }
}

function transition(id: string, afterMessageId: string | null, name: string, revision = 1): PromptTransition {
  return { id, afterMessageId, snapshot: snapshot(name, revision), createdAt: Number(id.slice(1)) }
}

const a = transition('t1', null, 'A')
const b = transition('t2', 'm0', 'B')
const c = transition('t3', 'm1', 'C')
const initial: PromptTransition[] = []
const afterA = appendPromptTransition(initial, a)
const afterB = appendPromptTransition(afterA, b)
const afterC = appendPromptTransition(afterB, c)
assert(initial.length === 0, 'append does not mutate the source array')
assert(afterC.map((item) => item.snapshot.name).join(',') === 'A,B,C', 'initial A -> messages -> B -> messages -> C keeps canonical order')
assert(promptTransitionBoundaries(afterC).join(',') === ',m0,m1', 'timeline preserves null and message boundaries')

const b2 = transition('t4', 'm1', 'B2')
const c2 = transition('t5', 'm1', 'C2', 2)
const switched = appendPromptTransition(appendPromptTransition(afterA, b2), c2)
assert(switched.length === 2, 'same-boundary mode switches replace the pending head')
assert(switched[1].snapshot.name === 'C2' && switched[1].id === 't5', 'last same-boundary transition wins by identity')

const replaced = replacePromptTransitionAtHead(afterC, transition('t6', 'm1', 'D'))
assert(replaced.length === 3 && replaced[2].snapshot.name === 'D', 'explicit replace-at-head is pure and positional')
assert(afterC[2].snapshot.name === 'C', 'replace-at-head does not mutate the original timeline')
assert(afterC[1].snapshot.revision === 1 && switched[1].snapshot.revision === 2, 'new profile revision is a distinct immutable snapshot')

await idbClearAll()
const rootConversation: Conversation = { id: 'timeline-conversation', title: 'Timeline', createdAt: 1, updatedAt: 1, messages: [{ id: 'm0', role: 'user', content: '问题', images: [], createdAt: 1, updatedAt: 1 }] }
await saveConversation(rootConversation)
await appendConversationPromptTransition(rootConversation.id, transition('t7', 'm0', 'B'))
const reloaded = await getConversation(rootConversation.id) as Conversation | undefined
assert(reloaded?.promptTransitions?.length === 1 && reloaded.promptTransitions[0].id === 't7', 'root transition is durable on the conversation row')
assert(reloaded?.messages.length === 1 && reloaded.messages[0].id === 'm0', 'root transition persistence does not rewrite message history')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
