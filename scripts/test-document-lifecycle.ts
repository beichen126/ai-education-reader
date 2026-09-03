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

// ---- Stage 9.2B1.2: cleanup ownership vs the already-updated docIdRef ----
// React sequence: render(newDocId) updates docIdRef BEFORE the OLD effect cleanup runs.
// The cleanup must use the closure-captured ownedDocId, never docIdRef.current.
function makeEffectModel(initialDocId: string) {
  const writes: Array<{ id: string | null; page: number }> = []
  return {
    writes,
    ownedDocId: initialDocId,            // captured in the effect closure
    docIdRef: initialDocId,              // updated on every render (the trap)
    pageRef: 1,
    // simulate render: only the REF changes, then React runs the OLD cleanup
    render(nextDocId: string | null) { this.docIdRef = nextDocId },
    cleanupWithRef() { this.writes.push({ id: this.docIdRef, page: this.pageRef }) },   // BUGGY variant
    cleanupOwned() { this.writes.push({ id: this.ownedDocId, page: this.pageRef }) },   // FIXED variant
    persistBound(id: string | null, page: number) { this.writes.push({ id, page }) },
  }
}
// A -> B: new render already set ref = B, then A cleanup runs
{
  const m = makeEffectModel('A')
  m.pageRef = 20
  m.render('B')
  m.cleanupOwned()
  assert(m.writes.length === 1 && m.writes[0].id === 'A' && m.writes[0].page === 20, 'A->B: cleanup persists OWNED A/20 (ref already B)')
}
// reader -> closed: ref = null, cleanup still persists A/20
{
  const m = makeEffectModel('A')
  m.pageRef = 20
  m.render(null)
  m.cleanupOwned()
  assert(m.writes.length === 1 && m.writes[0].id === 'A' && m.writes[0].page === 20, 'reader->closed: cleanup persists OWNED A/20 (ref already null)')
}
// latest page wins: pageRef advanced after effect creation (initial page was 1)
{
  const m = makeEffectModel('A')
  m.render('B')
  m.cleanupWithRef()
  assert(m.writes[0].id === 'B', 'reference: BUGGY variant writes B (documents the trap)')
  const m2 = makeEffectModel('A')
  m2.pageRef = 20
  m2.render('B')
  m2.cleanupOwned()
  assert(m2.writes[0].page === 20, 'latest page used, not the stale initial page')
}
// badging variant never used by production: persist is bound at persist() call time
{
  const m = makeEffectModel('A')
  m.pageRef = 42
  m.persistBound('A', m.pageRef)
  assert(m.writes[0].id === 'A' && m.writes[0].page === 42, 'persist(docId, page) explicit binding keeps A/42')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
