import 'fake-indexeddb/auto'
import { initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { getConversation } from '../src/storage/storage.ts'
import { displayTitle, sanitizeTitle, MAX_TITLE_LEN } from '../src/engine/session-title.ts'
import { NEW_TITLE, type Conversation } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }

await initStore()

// A helper little session (no DB seeding poll).
async function mkConv(title: string, msgs: any[]): Promise<Conversation> {
  const id = await sessionsActions.newChat()
  const conv = (await getConversation(id))!
  conv.title = title
  conv.messages = msgs
  return conv
}

// 1) NEW_TITLE session can be renamed to a formal title.
{
  const id = await sessionsActions.newChat()
  const before = (await getConversation(id))!
  assert(before.title === NEW_TITLE, 'new chat starts as NEW_TITLE')
  await sessionsActions.setTitle(id, '我的复习计划')
  const after = (await getConversation(id))!
  assert(after.title === '我的复习计划', 'rename NEW_TITLE -> formal title persisted')
  assert(after.id === before.id, 'rename keeps conversation ID')
  const msgsBefore = before.messages.length, msgsAfter = after.messages.length
  assert(msgsBefore === msgsAfter, 'rename keeps message count')
}

// 2) Empty / whitespace title is NOT saved.
{
  const id = await sessionsActions.newChat()
  await sessionsActions.setTitle(id, '   ')
  const after = (await getConversation(id))!
  assert(after.title === NEW_TITLE, 'whitespace-only title not saved (stays NEW_TITLE)')
  await sessionsActions.setTitle(id, '')
  const after2 = (await getConversation(id))!
  assert(after2.title === NEW_TITLE, 'empty title not saved')
}

// 3) Long title is capped at MAX_TITLE_LEN.
{
  const id = await sessionsActions.newChat()
  const long = '甲'.repeat(MAX_TITLE_LEN + 50)
  await sessionsActions.setTitle(id, long)
  const after = (await getConversation(id))!
  assert(after.title.length === MAX_TITLE_LEN, 'title capped at ' + MAX_TITLE_LEN + ' (got ' + after.title.length + ')')
  const t = sanitizeTitle('  ' + long + '  ')
  assert(t.length === MAX_TITLE_LEN, 'sanitizeTitle trims + caps')
}

// 4) sanitizeTitle rules directly.
{
  assert(sanitizeTitle('  标题  ') === '标题', 'sanitizeTitle trims')
  assert(sanitizeTitle('   ') === '', 'sanitizeTitle drops whitespace-only')
  assert(sanitizeTitle('') === '', 'sanitizeTitle drops empty')
  assert(sanitizeTitle('  短  ') === '短', 'sanitizeTitle collapses outer space only, keeps inner (string trim)')
}

// 5) displayTitle: formal title preferred; NEW_TITLE falls to auto; image-only -> 图片对话.
{
  const conv: Conversation = { id:'c1', title:'正式标题', createdAt:1, updatedAt:1, messages:[] }
  assert(displayTitle(conv) === '正式标题', 'displayTitle prefers formal title')
  const conv2: Conversation = { id:'c2', title:NEW_TITLE, createdAt:1, updatedAt:1, messages:[{ id:'m1', role:'user', content:'  请解释 **局部性原理**  ', images:[], createdAt:1, updatedAt:1 }] }
  const d2 = displayTitle(conv2)
  assert(d2 === '请解释 局部性原理' || d2 === '请解释 局部性原理…', 'displayTitle auto from first user message (got '+JSON.stringify(d2)+')')
  assert(d2.length <= 25, 'auto display title capped at ~25')
  const conv3: Conversation = { id:'c3', title:NEW_TITLE, createdAt:1, updatedAt:1, messages:[{ id:'m2', role:'user', content:'', images:['a'], createdAt:1, updatedAt:1 }] }
  assert(displayTitle(conv3) === '图片对话', 'image-only conversation -> 图片对话')
}

// 6) search uses displayTitle: an auto-titled conversation is findable by the SAME text the user sees.
{
  const q = '存储系统'
  const conv: Conversation = { id:'c6', title:NEW_TITLE, createdAt:2, updatedAt:2, messages:[{ id:'m', role:'user', content:'存储系统 层次结构', images:[], createdAt:2, updatedAt:2 }] }
  const shown = displayTitle(conv)
  assert(shown.toLowerCase().includes(q.toLowerCase()), 'auto display title ' + JSON.stringify(shown) + ' findable by search text ' + q)
  const convFormal: Conversation = { id:'c7', title:'计算机组成', createdAt:3, updatedAt:3, messages:[] }
  assert(displayTitle(convFormal).toLowerCase().includes('计算机组成'.toLowerCase()), 'formal title findable after rename')
}

// 7) rename after auto-title becomes the formal title (displayTitle then returns it).
{
  const id = await sessionsActions.newChat()
  const conv0 = (await getConversation(id))!
  // simulate a first user message so displayTitle is auto
  await sessionsActions.setTitle(id, NEW_TITLE) // no-op guard
  await sessionsActions.setTitle(id, '考研笔记')
  const after = (await getConversation(id))!
  assert(displayTitle(after) === '考研笔记', 'after rename, displayTitle returns the formal renamed title')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

