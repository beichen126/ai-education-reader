// Agent G (G6): deterministic zoom-ownership test. The stale-decision is a pure function
// (isZoomStale) so these cases run without a browser or React.
import { isZoomStale } from '../src/documents/zoom-ownership.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const S = { id: 'session' }
const ctx = (gen: number, docId: string | null, page: number, session: unknown) => ({ gen, docId, page, session })

// Baseline: same context -> NOT stale (its own result may open).
const base = ctx(2, 'docA', 10, S)
assert(!isZoomStale(base, ctx(2, 'docA', 10, S)), 'not stale when gen/doc/page/session all match')

// stale page: page 10 zoom resolves after navigating to 11 (nav bumped gen).
assert(isZoomStale(ctx(2, 'docA', 10, S), ctx(3, 'docA', 11, S)), 'stale when page turned (10 -> 11)')
// ... also stale even if gen stayed (page ref changed via direct jump).
assert(isZoomStale(ctx(2, 'docA', 10, S), ctx(2, 'docA', 30, S)), 'stale when page jumped (10 -> 30)')

// stale document: doc A render resolves after switch to doc B.
assert(isZoomStale(ctx(2, 'docA', 10, S), ctx(3, 'docB', 10, S)), 'stale when document switched (A -> B)')

// stale reader close: session torn down (session removed / nulled).
assert(isZoomStale(ctx(2, 'docA', 10, S), ctx(3, 'docA', 10, null)), 'stale when reader closed (session nulled)')

// second zoom owns result: request 1 (gen 1) resolves after request 2 (gen 2) started.
assert(isZoomStale(ctx(1, 'docA', 10, S), ctx(2, 'docA', 10, S)), 'stale when a newer zoom request owns generation')
assert(!isZoomStale(ctx(2, 'docA', 10, S), ctx(2, 'docA', 10, S)), 'newest zoom result is NOT stale (may open)')

// same page BUT a newer zoom on the same page still supersedes the older one.
assert(isZoomStale(ctx(2, 'docA', 10, S), ctx(3, 'docA', 10, S)), 'stale when a second zoom on same page supersedes first')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
