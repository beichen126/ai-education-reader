import 'fake-indexeddb/auto'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { getConversation } from '../src/storage/storage.ts'
import { getSessionsCurrent, getSessionsFocusTarget, initStore, sessionsActions } from '../src/engine/sessions-store.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

await idbClearAll()
await initStore()
const conversationA = getSessionsCurrent()!
await sessionsActions.addAssistant(conversationA, 'first message')
await sessionsActions.addAssistant(conversationA, 'second message')
const storedA = await getConversation(conversationA)
const firstMessage = storedA!.messages[0]
const secondMessage = storedA!.messages[1]

assert(await sessionsActions.openAtMessage(conversationA, firstMessage.id), 'already-open conversation accepts a valid target')
assert(getSessionsCurrent() === conversationA && getSessionsFocusTarget()?.messageId === firstMessage.id, 'already-open target intent retains exact message id')
sessionsActions.clearMessageFocus()
assert(getSessionsFocusTarget() === undefined, 'successful target consumption can clear the one-shot intent')

const conversationB = await sessionsActions.newChat()
await sessionsActions.addAssistant(conversationB, 'target conversation message')
const storedB = await getConversation(conversationB)
const targetB = storedB!.messages[0]
await sessionsActions.open(conversationA)
assert(await sessionsActions.openAtMessage(conversationB, targetB.id), 'closed/non-current conversation opens with a valid target')
assert(getSessionsCurrent() === conversationB && getSessionsFocusTarget()?.conversationId === conversationB && getSessionsFocusTarget()?.messageId === targetB.id, 'cross-conversation navigation carries exact target')

assert(!(await sessionsActions.openAtMessage(conversationB, 'deleted-message')), 'missing target message is rejected gracefully')
assert(getSessionsFocusTarget() === undefined, 'missing target clears stale navigation intent')
assert(!(await sessionsActions.openAtMessage('deleted-conversation', secondMessage.id)), 'missing conversation is rejected gracefully')

await closeDb()
console.log(`\nRESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
