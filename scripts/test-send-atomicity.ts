import 'fake-indexeddb/auto'
import { commitAcceptedUserMessage, LAST_CONVERSATION_ID_KEY, getConversation, getSetting } from '../src/storage/storage.ts'
import { idbRunTxn, idbGet, idbClearAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import { draftSettingKey } from '../src/engine/draft-store.ts'
import type { Conversation, Message } from '../src/engine/types.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

await idbClearAll()
const id = newStableId()

// --- A+NORMAL acceptance: conversation + lastConversationId + draft-delete all commit ---
// Seed a draft row (as if the user typed text / added an image).
const draftKey = draftSettingKey(id)
await idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: draftKey, value: { version: 1, text: 'unsent', imageIds: ['img-1'] } }) })
const mUser: Message = { id: newStableId(), role: 'user', content: 'hi', images: ['img-1'], createdAt: 1, updatedAt: 1 }
const conv: Conversation = { id, title: 'h', createdAt: 1, updatedAt: 1, messages: [mUser] }
await commitAcceptedUserMessage(conv, id, draftKey)

// Conversation durable + has the new user message.
const stored = await getConversation(id)
assert(stored && stored.messages.length === 1 && stored.messages[0].role === 'user' && stored.messages[0].content === 'hi', 'A: conversation durable with the new user message')
// lastConversationId updated.
assert((await getSetting(LAST_CONVERSATION_ID_KEY)) === id, 'A: lastConversationId updated in same txn')
// Draft row is gone (no stale draft after acceptance).
assert((await idbGet('settings', draftKey)) === undefined, 'C: draft row absent immediately after acceptance txn')


// --- B+transaction-abort via explicit txn.abort(): nothing commits ---
const id2 = newStableId()
const draftKey2 = draftSettingKey(id2)
await idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: draftKey2, value: { version: 1, text: 'keep-me', imageIds: [] } }) })
await idbRunTxn(['settings'], (t) => { t.objectStore('settings').put({ key: LAST_CONVERSATION_ID_KEY, value: 'some-other' }) })
const mUser2: Message = { id: newStableId(), role: 'user', content: 'should-not-commit', images: [], createdAt: 1, updatedAt: 1 }
const conv2: Conversation = { id: id2, title: 'x', createdAt: 1, updatedAt: 1, messages: [mUser2] }
// idbRunTxn passes the transaction to fn; abort it so the pending puts are rolled back.
let committed = false
try {
  await idbRunTxn(['conversations', 'settings'], (t) => {
    t.objectStore('conversations').put(conv2)
    t.objectStore('settings').put({ key: LAST_CONVERSATION_ID_KEY, value: id2 })
    t.objectStore('settings').delete(draftKey2)
    t.abort()
  })
  committed = true
} catch (e) { committed = false }
assert(committed === false, 'B: aborted transaction rejects (nothing committed)')
assert((await getConversation(id2)) === undefined, 'B: conversation unchanged after aborted accept')
const d2 = await idbGet('settings', draftKey2)
assert(d2 && d2.value.text === 'keep-me', 'B: draft still present after aborted accept')
assert((await getSetting(LAST_CONVERSATION_ID_KEY)) === 'some-other', 'B: lastConversationId unchanged after aborted accept')

// --- D+attachment ownership ---
const stored2 = await getConversation(id)
assert(stored2 && stored2.messages[0].images.length === 1 && stored2.messages[0].images[0] === 'img-1', 'D: accepted message keeps its image ids (ownership to message)')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
