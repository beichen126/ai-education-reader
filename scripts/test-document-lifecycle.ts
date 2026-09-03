// Stage 9.2B1.1: lifecycle hardening — session idempotence / A-B isolation,
// url-owner revoke semantics, reader-leave stale invalidation model.
import { closePdfSession } from '../src/pdf/pdf-session-core'
import { createUrlOwner } from '../src/documents/url-owner'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// ---- session lifecycle: idempotent close + A/B isolation ----
function fakeSession() {
  let destroys = 0
  const session = { loadingTask: { destroy: async () => { destroys++ } }, documentProxy: {} }
  return { session, destroys: () => destroys }
}
const A = fakeSession(), B = fakeSession()
await closePdfSession(A.session)
await closePdfSession(A.session) // double cleanup (leave effect + app unmount) — no-op
assert(A.destroys() === 1, 'closePdfSession idempotent (destroy called exactly once)')
await closePdfSession(B.session)
assert(B.destroys() === 1 && A.destroys() === 1, 'B session unaffected by A cleanup (A=1, B=1)')
await closePdfSession(null); await closePdfSession(undefined)
assert(true, 'closePdfSession(null/undefined) no-op')
// A closed session stays closed even if a late cleaner runs again
await closePdfSession(A.session)
assert(A.destroys() === 1, 'late re-close of A is a no-op (destroy still 1)')

// ---- url-owner: replace revokes previous, revokeAll drops current ----
const urlStats = { created: 0, revoked: 0 }
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
;(URL as any).createObjectURL = () => { urlStats.created++; return 'blob:url-' + urlStats.created }
;(URL as any).revokeObjectURL = (u: string) => { urlStats.revoked++; void u }
try {
  const owner = createUrlOwner()
  owner.replace('blob:url-1')
  owner.replace('blob:url-2')
  assert(urlStats.revoked === 1, 'page switch: old URL revoked exactly once')
  assert(owner.current === 'blob:url-2', 'url owner tracks the current URL')
  owner.revokeAll()
  assert(urlStats.revoked === 2 && owner.current === null, 'reader leave: current URL revoked + cleared')
  owner.revokeAll(); owner.replace(null); owner.replace('blob:url-3')
  assert(urlStats.revoked === 2, 'revokeAll on empty + replace(null) are no-ops (no extra revoke)')
  assert(owner.current === 'blob:url-3', 'recorded again after no-op clears')
  owner.revokeAll()
} finally {
  ;(URL as any).createObjectURL = realCreate
  ;(URL as any).revokeObjectURL = realRevoke
}

// ---- render stale: reader-LEAVE invalidates a pending render (no new render happens) ----
let latest = 0
let currentGen = 0
const nextGen = () => ++currentGen
const applyResult = (resultGen: number, p: number) => { if (resultGen === currentGen) latest = p }
const gA = nextGen()      // Document A page render starts (token 1)
nextGen()                 // reader leaves / switches — generation invalidated WITHOUT a new render
applyResult(gA, 20)       // A resolves AFTER the leave — must be discarded
assert(latest === 0, 'reader-leave invalidates the pending render (document switch stale)')
const gB = nextGen()      // Document B renders
applyResult(gB, 1)
assert(latest === 1, 'new document fresh render accepted')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
