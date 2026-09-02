// Cross-message event-ownership regression: a formula / selection in message A must
// never get picked up by the AnnotatedMarkdown instance of message B.
import { ownedMath, containsNode } from '../src/annotations/ownership.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }

// Minimal fake element tree: getAttribute/parentElement/contains (Node.contains semantics).
function node(attrs: Record<string,string> = {}, parent: any = null): any {
  const self: any = { getAttribute: (k:string) => (k in attrs ? attrs[k] : null), parentElement: null }
  self.contains = (n:any) => { for (let e:any = n; e; e = e.parentElement) if (e === self) return true; return false }
  self.parentElement = parent
  return self
}

const msgA = node({ 'data-message-id':'msgA' })
const blockA = node({}, msgA)
const formulaA = node({ 'data-math-id':'msgA/math-inline-0-3', 'data-math-kind':'inline' }, blockA)
const textA = node({}, blockA)

const msgB = node({ 'data-message-id':'msgB' })
const formulaB = node({ 'data-math-id':'msgB/math-block-0-2', 'data-math-kind':'block' }, msgB)

// 1) containsNode semantics.
assert(containsNode(msgA, formulaA), 'containsNode true for a descendant inside the same message')
assert(!containsNode(msgA, formulaB), 'containsNode false for a descendant of ANOTHER message')
assert(!containsNode(null, formulaA), 'containsNode false when root is null')
assert(!containsNode(msgA, null), 'containsNode false when target is null')

// 2) ownedMath: instance A only owns formulas inside A.
assert(ownedMath(msgA, formulaA)?.id === 'msgA/math-inline-0-3', 'A owns its inline formula')
assert(ownedMath(msgA, formulaA)?.kind === 'inline', 'A reads the kind of its formula')
assert(ownedMath(msgA, formulaB) === null, 'A does NOT own B\'s formula (cross-message math guard)')
assert(ownedMath(msgB, formulaB)?.id === 'msgB/math-block-0-2', 'B owns its block formula')
assert(ownedMath(msgB, formulaB)?.kind === 'block', 'B reads block kind')
assert(ownedMath(msgA, textA) === null, 'plain text (no formula) -> null')
assert(ownedMath(msgA, null) === null, 'null target -> null')

// 3) Simulate the pointer sequence: instance A taps formula B -> its pressedMath stays null.
let pressed: any = ownedMath(msgA, formulaB)
assert(pressed === null, 'pointerdown on B formula never enters A pending-math')
pressed = ownedMath(msgA, formulaA)
assert(!!pressed, 'pointerdown on A formula enters A pending-math')

// 4) Two instances each own their own formula (no cross-talk toggling).
assert(ownedMath(msgA, formulaA)!.id !== ownedMath(msgB, formulaB)!.id, 'A and B formula ids differ (scoped per message)')

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

