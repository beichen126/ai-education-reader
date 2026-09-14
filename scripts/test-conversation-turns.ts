import { buildConversationTurns } from '../src/cockpit/conversation-turns.ts'

let pass = 0, fail = 0
function assert(value: boolean, label: string) { if (value) { pass++; console.log('  ok: ' + label) } else { fail++; console.log('  FAIL: ' + label) } }

const turns = buildConversationTurns([{ id: 'u1', role: 'user', content: '第一问' }, { id: 'a1', role: 'assistant', content: '第一答' }, { id: 'u2', role: 'user', content: '第二问' }, { id: 'a2', role: 'assistant', content: '第二答'.repeat(500) }, { id: 'u3', role: 'user', content: '' }])
assert(turns.length === 3, 'one marker is built per conversation round')
assert(turns[0].anchorMessageId === 'u1' && turns[0].assistantMessageId === 'a1', 'assistant reply is grouped into its user turn')
assert(turns[2].userMessageId === 'u3' && !turns[2].assistantMessageId, 'an interrupted trailing user turn remains reachable')
assert(turns[1].weight === 1, 'long turns clamp marker weight')
assert(turns[2].preview === '无文字内容', 'image-only turn gets an accessible fallback label')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
