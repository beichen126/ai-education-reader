// Stage 3 unit tests for src/pdf/pdf-outline.ts (mock doc; no real PDF, no UI).
import { parsePdfOutline, PdfOutlineError, type PdfOutlineItem, type PdfOutlineDocument } from '../src/pdf/pdf-outline.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- mock helpers ---
const pg = (n1: number) => ({ num: n1 - 1, gen: 0 })  // ref to 1-based page n1
function node(title: string, dest: any, children: any[] = [], url: string | null = null) {
  return { title, dest, url, items: children }
}
function mockDoc(numPages: number, outline: any[] | null, namedDests: Record<string, any> = {}, pageIndex: (ref: any) => number = (ref) => ref.num): PdfOutlineDocument {
  return {
    numPages,
    getOutline: async () => outline as any,
    getDestination: async (name: string) => (name in namedDests ? namedDests[name] : null),
    getPageIndex: async (ref: any) => pageIndex(ref),
  }
}
function byTitle(items: PdfOutlineItem[], title: string): PdfOutlineItem | undefined {
  for (const it of items) { if (it.title === title) return it; const d = byTitle(it.children, title); if (d) return d }
  return undefined
}

// --- A: no outline -> empty tree ---
let r = await parsePdfOutline(mockDoc(10, null))
assert(r.items.length === 0 && r.diagnostics.length === 0, 'A: null outline -> empty result')
r = await parsePdfOutline(mockDoc(10, []))
assert(r.items.length === 0 && r.diagnostics.length === 0, 'A: [] outline -> empty result')

// --- B: explicit destination -> getPageIndex -> 1-based page ---
const bDoc = mockDoc(10, [node('sec', [pg(5)])])
r = await parsePdfOutline(bDoc)
assert(r.items.length === 1, 'B: one item')
assert(r.items[0].startPage === 5 && r.items[0].resolution === 'direct' && r.items[0].selectable, 'B: explicit dest -> startPage 5, direct, selectable')
assert(r.items[0].endPage === 10, 'B: last node endPage = numPages 10')

// --- C: named destination -> getDestination -> page ---
const cDoc = mockDoc(10, [node('c', 'chapter1')], { chapter1: [pg(7)] })
r = await parsePdfOutline(cDoc)
assert(r.items[0].startPage === 7, 'C: named dest resolves to page 7')

// --- D: missing named dest -> only that node unresolved ---
const dDoc = mockDoc(10, [node('bad', 'nope'), node('good', [pg(3)])])
r = await parsePdfOutline(dDoc)
assert(r.items[0].startPage === null && r.items[0].selectable === false && r.items[0].resolution === 'unresolved', 'D: missing named dest -> bad node unresolved')
assert(r.items[1].startPage === 3, 'D: sibling still resolves')
assert(r.diagnostics.some(d => d.code === 'unresolved-destination' && d.title === 'bad'), 'D: diagnostic unresolved-destination')

// --- E: parent dest=null, derived-from-child ---
const eChild = node('1.1', [pg(12)])
const eChild2 = node('1.2', [pg(20)])
const eDoc = mockDoc(50, [node('第一章', null, [eChild, eChild2]), node('第二章', [pg(40)])])
r = await parsePdfOutline(eDoc)
const ch1 = byTitle(r.items, '第一章')!
assert(ch1.directStartPage === null, 'E: parent directStartPage null')
assert(ch1.startPage === 12 && ch1.resolution === 'derived-from-child' && ch1.selectable, 'E: derived from first child (12)')
assert(ch1.endPage === 39, 'E: derived parent endPage = next chapter 40 - 1 = 39')

// --- F: external url -> not selectable, children still parse ---
const fDoc = mockDoc(10, [node('主页', null, [node('s1', [pg(2)])], 'https://example.com')])
r = await parsePdfOutline(fDoc)
assert(r.items[0].resolution === 'external' && r.items[0].selectable === false && r.items[0].startPage === null, 'F: external node not selectable')
assert(r.items[0].children.length === 1 && r.items[0].children[0].startPage === 2, 'F: external parent children still parsed')

// --- G: hierarchy depth/path/children ---
const gDoc = mockDoc(10, [node('ch', [pg(1)], [node('s', [pg(2)], [node('ss', [pg(3)])])])])
r = await parsePdfOutline(gDoc)
const ch = r.items[0], s = ch.children[0], ss = s.children[0]
assert(ch.depth === 0 && ch.path.join('.') === '0', 'G: root depth0 path 0')
assert(s.depth === 1 && s.path.join('.') === '0.0' && s.id === '0.0', 'G: child depth1 path 0.0')
assert(ss.depth === 2 && ss.path.join('.') === '0.0.0', 'G: grandchild depth2 path 0.0.0')

// --- H: normal chapter/section ranges (PRD §19) ---
const hDoc = mockDoc(50, [
  node('第一章', [pg(10)], [node('1.1', [pg(12)]), node('1.2', [pg(18)]), node('1.3', [pg(27)])]),
  node('第二章', [pg(35)]),
])
r = await parsePdfOutline(hDoc)
const H_ch1 = byTitle(r.items, '第一章')!, H_11 = byTitle(r.items, '1.1')!, H_12 = byTitle(r.items, '1.2')!, H_13 = byTitle(r.items, '1.3')!, H_ch2 = byTitle(r.items, '第二章')!
assert(H_ch1.startPage === 10 && H_ch1.endPage === 34, 'H: ch1 10-34')
assert(H_11.startPage === 12 && H_11.endPage === 17, 'H: 1.1 12-17')
assert(H_12.startPage === 18 && H_12.endPage === 26, 'H: 1.2 18-26')
assert(H_13.startPage === 27 && H_13.endPage === 34, 'H: 1.3 27-34')
assert(H_ch2.startPage === 35 && H_ch2.endPage === 50, 'H: last chapter 35-50')

// --- I: same-page bookmarks must not produce end<start ---
const iDoc = mockDoc(60, [node('a', [pg(40)]), node('b', [pg(40)]), node('c', [pg(45)])])
r = await parsePdfOutline(iDoc)
const Ia = r.items[0], Ib = r.items[1], Ic = r.items[2]
assert(Ia.startPage === 40 && Ia.endPage === 40, 'I: a = 40-40 (same page)')
assert(Ib.startPage === 40 && Ib.endPage === 44, 'I: b = 40-44 (same-page boundary -> 40)')
assert(Ic.startPage === 45 && Ic.endPage === 60, 'I: c = 45-60')
assert(Ia.endPage >= Ia.startPage && Ib.endPage >= Ib.startPage && Ic.endPage >= Ic.startPage, 'I: no end < start')

// --- J: last node endPage = numPages (covered H, but explicit) ---
assert(H_ch2.endPage === 50, 'J: last node endPage = numPages')

// --- K: bad ref / getPageIndex rejects -> whole tree returns ---
const kDoc = mockDoc(10, [node('badref', [{ num: -1, gen: 0 }]), node('ok', [pg(4)])], {}, (ref) => { if (ref.num < 0) throw new Error('bad ref'); return ref.num })
r = await parsePdfOutline(kDoc)
assert(r.items[0].startPage === null && r.items[0].resolution === 'unresolved', 'K: rejecting ref -> node unresolved')
assert(r.items[1].startPage === 4, 'K: sibling still resolves')
assert(r.diagnostics.some(d => d.code === 'invalid-page-ref'), 'K: invalid-page-ref diagnostic')

// --- L: out of range -> unresolved, no clamp ---
const lDoc = mockDoc(500, [node('tooFar', [pg(700)]), node('numTooFar', [700]), node('neg', [-1])])
r = await parsePdfOutline(lDoc)
assert(r.items[0].startPage === null && r.items[0].selectable === false, 'L: ref page 700 -> unresolved (no clamp)')
assert(r.items[1].startPage === null && r.items[1].selectable === false, 'L: numeric 700 -> unresolved (no clamp)')
assert(r.items[2].startPage === null && r.items[2].selectable === false, 'L: numeric -1 -> unresolved (no clamp)')
assert(r.diagnostics.some(d => d.code === 'page-out-of-range'), 'L: page-out-of-range diagnostic present')

// --- M: non-monotonic (50 -> 43) -> conservative range + diagnostic ---
const mDoc = mockDoc(60, [node('a', [pg(50)]), node('b', [pg(43)])])
r = await parsePdfOutline(mDoc)
assert(r.items[0].startPage === 50 && r.items[0].endPage === 50, 'M: a = 50-50 (conservative, no negative range)')
assert(r.items[1].startPage === 43 && r.items[1].endPage === 60, 'M: b = 43-60')
assert(r.diagnostics.some(d => d.code === 'non-monotonic-outline' && d.title === 'a'), 'M: non-monotonic-outline diagnostic')

// --- getOutline itself rejects -> PdfOutlineError thrown ---
const throwDoc = mockDoc(10, null); throwDoc.getOutline = async () => { throw new Error('boom') }
let threw = false
try { await parsePdfOutline(throwDoc) } catch (e) { threw = e instanceof PdfOutlineError }
assert(threw, 'getOutline rejects -> PdfOutlineError')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
