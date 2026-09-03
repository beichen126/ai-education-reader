// Stage 9.4B.1: same-page chapter boundary correctness (PURE domain).
// Validator allows same-page siblings (non-decreasing only); range derivation never
// produces end < start; insertion is stable-within-same-page; reorder stays same-parent.
import {
  validateChapterDraft, deriveChapterEndPages, buildManualChapterTree,
  insertChapterByPage, moveUp, moveDown, canApplyChapterDraftOperation,
  type ChapterDraftItem,
} from '../src/documents/chapter-builder.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const item = (id: string, title: string, level: number, startPage: number): ChapterDraftItem => ({ id, title, level, startPage })

// --- A0 validator: same-page siblings valid; global decreases invalid ---
{
  const v = validateChapterDraft([item('a','A',1,18), item('b','B',1,19), item('c','C',1,19), item('d','D',1,19), item('e','E',1,23)], 30)
  assert(v.ok === true, '18,19,19,19,23 non-decreasing -> valid')
  const bad = validateChapterDraft([item('a','A',1,18), item('b','B',1,20), item('c','C',1,19)], 30)
  assert(!bad.ok, '18,20,19 decreases -> invalid')
  const pc = validateChapterDraft([item('a','A',1,5), item('b','B',2,5)], 30)
  assert(pc.ok === true, 'same-page parent/child valid')
}

// --- A1 range derivation: never end < start ---
{
  const items = [
    item('a','A',1,10), item('b','B',2,10), item('c','C',2,12), item('d','D',2,12), item('e','E',2,18), item('f','F',1,20),
  ]
  const ends = deriveChapterEndPages(items, 30)
  assert(ends.join(',') === '19,11,12,17,19,30', 'range derivation (got ' + ends.join(',') + ')')
  assert(ends.every((e, i) => e >= items[i].startPage), 'every end >= start (got ' + ends.join(',') + ')')
}
{
  // same-page siblings collapse to own page
  const items = [item('a','A',1,19), item('b','B',1,19)]
  const ends = deriveChapterEndPages(items, 30)
  assert(ends.join(',') === '19,30', 'same-page run: A=19, B=30 (got ' + ends.join(',') + ')')
}

// --- A3 insertion: stable append-within-same-page ---
{
  const base = [item('a','A',1,5), item('b','B',1,5), item('c','C',1,9)]
  const r = insertChapterByPage(base, item('x','X',1,5))
  assert(r.ok && r.items.map(i => i.id).join(',') === 'a,b,x,c', 'same-page insert after run (got ' + r.items.map(i => i.id).join(',') + ')')
  assert(validateChapterDraft(r.items, 12).ok, 'same-page insert valid')
}
{
  // before-first / middle still work
  const r = insertChapterByPage([item('a','A',1,4), item('b','B',1,8)], item('x','X',1,2))
  assert(r.ok && r.items.map(i => i.id).join(',') === 'x,a,b', 'before-first still works')
}

// --- A2 reorder: same-page siblings enabled, different-page / cross-parent disabled ---
{
  assert(canApplyChapterDraftOperation([item('a','A',1,10), item('b','B',1,20)], 30, moveUp, 1) === false, 'different-page reorder disabled')
  assert(canApplyChapterDraftOperation([item('a','A',1,19), item('b','B',1,19)], 30, moveUp, 1) === true, 'same-page reorder enabled')
  const moved = moveUp([item('a','A',1,19), item('b','B',1,19)], 1)
  assert(moved.map(i => i.id).join(',') === 'b,a', 'same-page swap')
  const cp = [item('a','A',1,1), item('a1','A.1',2,1)]
  assert(canApplyChapterDraftOperation(cp, 10, moveDown, 1) === false, 'cross-parent moveDown disabled')
}

// --- A4 current-chapter ambiguity: deterministic, no crash, valid range ---
{
  // Within-chapter-builder the current-chapter resolver lives in reader-context; here we
  // assert the built tree stays valid when two siblings share a page, and ranges are sane.
  const tree = buildManualChapterTree([item('a','A',1,19), item('b','B',1,19), item('c','C',1,23)], 30)
  assert(tree.length === 3, '3 roots built')
  assert(tree[0].startPage === 19 && tree[0].endPage === 19, 'A range 19..19')
  assert(tree[1].startPage === 19 && tree[1].endPage === 22, 'B range 19..22 (next at 23)')
  assert(tree[2].startPage === 23 && tree[2].endPage === 30, 'C range 23..30')
  assert(tree.every(n => n.endPage >= n.startPage), 'all endPage >= startPage')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
