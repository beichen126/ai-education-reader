
import 'fake-indexeddb/auto'
import { newStableId } from '../src/engine/types.ts'
import type { Conversation, Message, Attachment } from '../src/engine/types.ts'
import { getSetting, setSetting, getConversation, listConversations, saveConversation, deleteConversation } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'

let pass = 0, fail = 0
function assert(cond: boolean, msg: string){ if(cond){ pass++; console.log('  ok: ' + msg) } else { fail++; console.log('  FAIL: '+msg) } }

console.log('=== persistence / stable-id test ===')
const aid = newStableId(); const mid = newStableId(); const imgId = newStableId()
const img: Attachment = { id: imgId, url: 'blob:x', name: 'p.png', createdAt: 1, updatedAt: 1 }
const m: Message = { id: mid, role: 'user', content: '你好', images: [img], createdAt: 2, updatedAt: 2 }
const convA: Conversation = { id: aid, title: '测试会话', createdAt: 3, updatedAt: 3, messages: [m] }
await saveConversation(convA)

let got = await getConversation(aid)
assert(!!got && got.id === aid, 'getConversation returns A by id')
assert(!!got && got.messages[0].id === mid, 'messageId preserved on read')
assert(!!got && got.messages[0].images[0].id === imgId, 'attachmentId preserved on read')

let list = await listConversations()
assert(list.some(c => c.id === aid), 'listConversations includes A')

await closeDb()
got = await getConversation(aid)
assert(!!got && got.id === aid, 'after reopen still returns A')
assert(!!got && got.messages[0].id === mid && got.messages[0].content === '你好', 'after reopen message content+id stable')

const bid = newStableId(); const convB: Conversation = { id: bid, title: 'B', createdAt: 4, updatedAt: 4, messages: [] }
await saveConversation(convB)
list = await listConversations()
assert(list.length === 2 && list.some(c=>c.id===aid) && list.some(c=>c.id===bid), 'two conversations persist separately')

await deleteConversation(aid)
list = await listConversations()
assert(!list.some(c=>c.id===aid) && list.some(c=>c.id===bid), 'A gone after delete')
await closeDb()
list = await listConversations()
assert(!list.some(c=>c.id===aid) && list.some(c=>c.id===bid), 'A does not revive after reopen (delete durable)')

await setSetting('lastConversationId', bid)
const last = await getSetting('lastConversationId')
assert(last === bid, 'setting persisted and read back')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
