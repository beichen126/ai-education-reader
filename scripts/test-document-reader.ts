// Stage 9.2B1: pure Reader page logic.
import { clampReaderPage, parsePageInput } from '../src/documents/reader-utils.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// initial page semantics
assert(clampReaderPage(0, 42) === 1, 'unread/lastReadPage 0 -> page 1')
assert(clampReaderPage(42, 42) === 42, 'lastReadPage 42 -> page 42')
assert(clampReaderPage(7, 42) === 7, 'lastReadPage 7 -> page 7')
assert(clampReaderPage(99, 42) === 42, 'over pageCount -> clamped to 42')
assert(clampReaderPage(-3, 42) === 1, 'negative -> 1')
assert(clampReaderPage(NaN, 42) === 1, 'NaN -> 1')
assert(clampReaderPage(Infinity, 42) === 1, 'Infinity -> 1 (defensive)')

// direct page input
const ok = (s: string, pageCount: number, expected: number) => { const r = parsePageInput(s, pageCount); return r.ok === true && r.page === expected }
assert(ok('7', 42, 7) === true, 'input 42-page: 7 accepted')
assert(ok('42', 42, 42) === true, 'input 42 accepted (boundary)')
assert(ok('1', 1, 1) === true, 'input 1 on single-page doc')
assert(parsePageInput('0', 42).ok === false, '0 rejected')
assert(parsePageInput('43', 42).ok === false, 'pageCount+1 rejected')
assert(parsePageInput('3.5', 42).ok === false, 'fraction rejected')
assert(parsePageInput('abc', 42).ok === false, 'abc rejected')
assert(parsePageInput('', 42).ok === false, 'empty rejected')
assert(parsePageInput(' 12 ', 42).ok === true, 'whitespace-trimmed valid input accepted')

// render race helper concept: the newest generation wins (token guard is in the component;
// this verifies the page setter contract used there)
let latest = 0
let currentGen = 0
const set = (p: number) => { latest = p }
const nextGen = () => ++currentGen
const applyResult = (resultGen: number, p: number) => { if (resultGen === currentGen) set(p) }
// user flips 1 -> 2 -> 3 quickly: page 2's render resolves AFTER page 3 started
const g2 = nextGen()   // render for page 2 starts (token 1)
const g3 = nextGen()   // page 3 requested -> token 2 (page 2 result is now stale)
applyResult(g2, 2)     // late stale result for page 2 — must be DISCARDED
applyResult(g3, 3)     // fresh result for page 3 — accepted
assert(latest === 3, 'stale render result discarded -> UI keeps the latest page')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
