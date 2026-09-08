import { quickFollowUpAnchor } from '../src/cockpit/quick-follow-up-anchor'
import type { Message } from '../src/engine/types'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}
const msg = (id: string, role: Message['role'], content: string, status?: Message['status']): Message => ({
  id, role, content, images: [], createdAt: 1, updatedAt: 1, ...(status ? { status } : {}),
})

assert(quickFollowUpAnchor([msg('u1', 'user', '问题'), msg('a1', 'assistant', '回答')]) === 'a1', 'completed assistant at timeline tail is the anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答'), msg('a2', 'assistant', '部分', 'failed')]) === undefined, 'failed tail hides an older completed anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答'), msg('a2', 'assistant', '部分', 'aborted')]) === undefined, 'aborted tail hides an older completed anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答'), msg('u2', 'user', '新问题')]) === undefined, 'pending user tail has no assistant anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答'), msg('a2', 'assistant', ' \n\u00a0\t')]) === undefined, 'whitespace-only assistant is not an anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答')], 'a1') === undefined, 'active streaming tail has no anchor')
assert(quickFollowUpAnchor([msg('a1', 'assistant', '回答'), msg('a2', 'assistant', '部分', 'failed'), msg('u3', 'user', '重试'), msg('a3', 'assistant', '新回答')]) === 'a3', 'new successful tail gets a fresh anchor')
assert(quickFollowUpAnchor([msg('branch-old', 'assistant', '兄弟分支回答')]) === 'branch-old', 'anchor only sees the caller-provided visible timeline')

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
