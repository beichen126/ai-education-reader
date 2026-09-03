// Stage 9.4A: Manual Chapter Builder domain tests (PURE, no React/CSS/IndexedDB).
import {
  validateChapterDraft,
  buildManualChapterTree,
  flattenManualChapters,
  cloneChapterDraft,
  makeNewChapterItem,
  chapterSourceForTree,
  deleteDraftSubtree,
  draftHasChildren,
  subtreeSize,
  moveUp,
  moveDown,
  indentSubtree,
  outdentSubtree,
  insertItem,
  deriveChapterEndPages,
  MAX_CHAPTER_LEVEL,
  type ChapterDraftItem,
  type ChapterNode,
} from '../src/documents/chapter-builder.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function hasCode(issues: any[], code: string) { return issues.some((i: any) => i.code === code) }
function okFc(items: ChapterDraftItem[], pageCount = 100): { ok: boolean; issues: any[] } {
  return validateChapterDraft(items, pageCount)
}

const item = (id: string, title: string, level: number, startPage: number): ChapterDraftItem => ({ id, title, level, startPage })

// ===================== VALIDATION =====================
{
  const v = okFc([])
  assert(v.ok === true, 'empty draft valid')
}
{
  const v = okFc([item('a', 'A', 2, 1)])
  assert(!v.ok && hasCode(v.issues, 'first-not-level-1'), 'first level != 1 invalid')
}
{
  const v = okFc([item('a', 'A', 0, 1)])
  assert(!v.ok && hasCode(v.issues, 'level-zero'), 'level 0 invalid')
}
{
  const v = okFc([item('a', 'A', 1, 1), item('b', 'B', 3, 2)])
  assert(!v.ok && hasCode(v.issues, 'level-jump'), 'level jump 1->3 invalid')
}
{
  const v = okFc([item('a', 'A', 1, 0)])
  assert(!v.ok && hasCode(v.issues, 'page-out-of-range'), 'page 0 invalid')
}
{
  const v = okFc([item('a', 'A', 1, 101)], 100)
  assert(!v.ok && hasCode(v.issues, 'page-out-of-range'), 'page > pageCount invalid')
}
{
  const v = okFc([item('a', 'A', 1, 1.5)])
  assert(!v.ok && hasCode(v.issues, 'page-not-int'), 'fraction invalid')
}
{
  const v = okFc([item('a', 'A', 1, 10), item('b', 'B', 1, 5)])
  assert(!v.ok && hasCode(v.issues, 'page-decreases'), 'global page decreases invalid')
}
{
  const v = okFc([item('a', 'A', 1, 10), item('b', 'B', 2, 10)])
  assert(v.ok === true, 'parent + child same page valid')
}
{
  const v = okFc([item('a', 'A', 1, 10), item('b', 'B', 1, 10)])
  assert(!v.ok && hasCode(v.issues, 'sibling-same-page'), 'siblings same page invalid')
}
{
  const v = okFc([item('a', '  ', 1, 1)])
  assert(!v.ok && hasCode(v.issues, 'blank-title'), 'blank title invalid')
}
{
  const v = okFc([item('a', 'A', 1, 1), item('a', 'B', 1, 2)])
  assert(!v.ok && hasCode(v.issues, 'duplicate-id'), 'duplicate ids invalid')
}
{
  const v = okFc([item('a', 'A', 1, 1), item('b', 'B', 2, 2), item('c', 'C', 3, 3), item('d', 'D', 2, 4)])
  assert(v.ok === true, '1->2->3->2 valid')
}
{
  const v = okFc([item('a', 'A', 1, 1), item('b', 'B', 1, 2)])
  assert(v.ok === true, 'valid two top-level')
}
{
  const deep = [item('a', 'A', 1, 1)]
  for (let l = 2; l <= MAX_CHAPTER_LEVEL; l++) deep.push(item('d' + l, 'D' + l, l, l))
  const v = okFc(deep)
  assert(v.ok === true, 'max level ' + MAX_CHAPTER_LEVEL + ' valid')
}
{
  const v = okFc([item('a', 'A', 1, 1), item('b', 'B', MAX_CHAPTER_LEVEL + 1, 2)])
  assert(!v.ok && hasCode(v.issues, 'level-too-deep'), 'level > ' + MAX_CHAPTER_LEVEL + ' invalid')
}

// ===================== END PAGE DERIVATION =====================
{
  const ends = deriveChapterEndPages([
    item('a', '第一章', 1, 10),
    item('b', '1.1', 2, 10),
    item('c', '1.2', 2, 20),
    item('d', '第二章', 1, 40),
  ], 100)
  assert(ends.join(',') === '39,19,39,100', 'end derivation (got ' + ends.join(',') + ')')
}
{
  const ends = deriveChapterEndPages([item('a', 'L1', 1, 10), item('b', 'L2', 2, 10), item('c', 'L3', 3, 12), item('d', 'L2', 2, 20), item('e', 'L1', 1, 30)], 100)
  assert(ends.join(',') === '29,19,19,29,100', 'nested 3-level end derivation (got ' + ends.join(',') + ')')
}

// ===================== TREE BUILD =====================
{
  const tree = buildManualChapterTree([
    item('a', '第一章', 1, 10),
    item('b', '1.1', 2, 10),
    item('c', '1.2', 2, 20),
    item('d', '第二章', 1, 40),
  ], 100)
  assert(tree.length === 2, 'tree root count 2 (got ' + tree.length + ')')
  assert(tree[0].title === '第一章' && tree[0].startPage === 10 && tree[0].endPage === 39, 'chapter1 range 10-39')
  assert(tree[0].children.length === 2, 'chapter1 has 2 children')
  assert(tree[0].children[0].title === '1.1' && tree[0].children[0].startPage === 10 && tree[0].children[0].endPage === 19, '1.1 range 10-19')
  assert(tree[0].children[1].title === '1.2' && tree[0].children[1].startPage === 20 && tree[0].children[1].endPage === 39, '1.2 range 20-39')
  assert(tree[1].title === '第二章' && tree[1].startPage === 40 && tree[1].endPage === 100, 'chapter2 40-100')
  assert(tree.every(n => n.selectable && n.source === 'manual' && n.children.every(c => c.selectable && c.source === 'manual')), 'all manual nodes selectable + manual')
}
{
  const tree = buildManualChapterTree([
    item('a', 'L1', 1, 10), item('b', 'L2', 2, 10), item('c', 'L3', 3, 12), item('d', 'L2', 2, 20), item('e', 'L1', 1, 30),
  ], 100)
  assert(tree[0].endPage === 29, 'L1 -> 29')
  assert(tree[0].children[0].endPage === 19, 'L2 -> 19')
  assert(tree[0].children[0].children[0].endPage === 19, 'L3 -> 19 (bounded by next L2 at p20)')
  assert(tree[0].children[1].endPage === 29, 'second L2 -> 29')
  assert(tree[1].endPage === 100, 'final L1 -> 100')
}
{
  // build throws on invalid
  let threw = false
  try { buildManualChapterTree([item('a', 'A', 3, 1)], 10) } catch { threw = true }
  assert(threw, 'buildManualChapterTree throws on invalid (first not level 1)')
}

// ===================== FLATTEN (round trip) =====================
{
  const tree: ChapterNode[] = [{
    id: 'root', title: 'Chapter 1', level: 1, startPage: 1, endPage: 5, selectable: true, source: 'manual',
    children: [{ id: 'c11', title: '1.1', level: 2, startPage: 2, endPage: 4, selectable: true, source: 'manual', children: [] }],
  }]
  const flat = flattenManualChapters(tree)
  assert(flat.length === 2 && flat[0].id === 'root' && flat[0].title === 'Chapter 1' && flat[0].level === 1 && flat[0].startPage === 1, 'flatten keeps id/title/level/startPage (root)')
  assert(flat[1].id === 'c11' && flat[1].level === 2 && flat[1].startPage === 2, 'flatten keeps child order + level')
}

// ===================== ID STABILITY =====================
{
  // existing manual tree -> flatten -> change title -> rebuild: ids unchanged
  const tree: ChapterNode[] = [
    { id: 'id-A', title: 'A', level: 1, startPage: 1, endPage: 4, selectable: true, source: 'manual', children: [] },
    { id: 'id-B', title: 'B', level: 1, startPage: 5, endPage: 8, selectable: true, source: 'manual', children: [] },
    { id: 'id-C', title: 'C', level: 1, startPage: 9, endPage: 10, selectable: true, source: 'manual', children: [] },
  ]
  const flat = flattenManualChapters(tree)
  flat[1].title = 'B-edited'
  const rebuilt = buildManualChapterTree(cloneChapterDraft(flat), 10)
  assert(rebuilt.map(n => n.id).join(',') === 'id-A,id-B,id-C', 'ids unchanged after title edit (got ' + rebuilt.map(n => n.id).join(',') + ')')
  assert(rebuilt[1].title === 'B-edited', 'edited title preserved')
  // new node uses a fresh id only
  const added = insertItem(cloneChapterDraft(flat), makeNewChapterItem({ currentPage: 11, pageCount: 10 }), 2)
  const rebuilt2 = buildManualChapterTree(added, 10)
  const newIds = rebuilt2.map(n => n.id)
  const oldIds = ['id-A', 'id-B', 'id-C']
  assert(newIds.filter(id => oldIds.includes(id)).length === 3, 'existing 3 ids kept after add')
  assert(newIds.filter(id => !oldIds.includes(id)).length === 1, 'exactly one new id added')
}

// ===================== makeNewChapterItem =====================
{
  const it = makeNewChapterItem({ currentPage: 7, pageCount: 10, level: 2 })
  assert(it.startPage === 7 && it.level === 2 && it.title === '新章节' && it.id.length > 0, 'makeNewChapterItem from current page + inherit level')
  const clamped = makeNewChapterItem({ currentPage: 999, pageCount: 10 })
  assert(clamped.startPage === 10 && clamped.level === 1, 'makeNewChapterItem clamps current page + default level 1')
}

// ===================== chapterSourceForTree =====================
{
  assert(chapterSourceForTree([]) === 'none', 'empty tree -> none')
  assert(chapterSourceForTree(buildManualChapterTree([item('a', 'A', 1, 1)], 5)) === 'manual', 'non-empty -> manual')
}

// ===================== DELETION =====================
const base: ChapterDraftItem[] = [
  item('a', 'Chapter 1', 1, 1), item('b', '1.1', 2, 2), item('c', '1.2', 2, 3), item('d', 'Chapter 2', 1, 5),
]
{
  const leaf = deleteDraftSubtree(base, 1) // delete 1.1
  assert(leaf.length === 3 && leaf.map(i => i.id).join(',') === 'a,c,d', 'delete leaf removes only that item')
}
{
  const parent = deleteDraftSubtree(base, 0) // delete Chapter 1 (has children)
  assert(parent.length === 1 && parent[0].id === 'd', 'delete parent deletes subtree (all 3 removed)')
}
{
  assert(draftHasChildren(base, 0) && draftHasChildren(base, 1) === false, 'draftHasChildren detection')
  assert(subtreeSize(base, 0) === 3 && subtreeSize(base, 1) === 1, 'subtreeSize')
}

// ===================== MOVE =====================
const moveBase = [
  item('a', 'Chapter 1', 1, 1), item('b', 'A', 2, 2), item('c', 'B', 2, 3), item('d', 'Chapter 2', 1, 5),
]
{
  const up = moveUp(moveBase, 2) // move B (idx2) up before A
  assert(up.map(i => i.id).join(',') === 'a,c,b,d', 'move sibling up (got ' + up.map(i => i.id).join(',') + ')')
}
{
  const down = moveDown(moveBase, 1) // move A (idx1) down after B
  assert(down.map(i => i.id).join(',') === 'a,c,b,d', 'move sibling down (got ' + down.map(i => i.id).join(',') + ')')
}
{
  const firstNoUp = moveUp(moveBase, 0) // Chapter 1 is first -> no move
  assert(firstNoUp.map(i => i.id).join(',') === 'a,b,c,d', 'first sibling cannot move up')
}
{
  const lastNoDown = moveDown(moveBase, 3) // Chapter 2 is last -> no move
  assert(lastNoDown.map(i => i.id).join(',') === 'a,b,c,d', 'last sibling cannot move down')
}

// ===================== INDENT / OUTDENT =====================
{
  const ind = indentSubtree([item('a', 'A', 1, 1), item('b', 'B', 1, 2)], 1) // B -> under A
  assert(ind[1].level === 2 && ind.map(i => i.id).join(',') === 'a,b', 'indent under previous sibling -> level 2')
}
{
  const noIndFirst = indentSubtree([item('a', 'A', 1, 1), item('b', 'B', 1, 2)], 0)
  assert(noIndFirst.map(i => i.level).join(',') === '1,1', 'first item cannot indent')
}
{
  const out = outdentSubtree([item('a', 'A', 1, 1), item('b', 'B', 2, 2)], 1)
  assert(out[1].level === 1, 'outdent level2 -> level1')
}
{
  const noOutL1 = outdentSubtree([item('a', 'A', 1, 1)], 0)
  assert(noOutL1[0].level === 1, 'level1 cannot outdent')
}
{
  // subtree moves/indents together: B is level1 with child C(level2); D is another top-level
  const sg = [item('a', 'A', 1, 1), item('b', 'B', 1, 5), item('c', 'C', 2, 6), item('d', 'D', 1, 9)]
  const indentB = indentSubtree(sg, 1) // indent B subtree under previous sibling A: B->2, C->3, D stays 1
  assert(indentB.map(i => i.level).join(',') === '1,2,3,1', 'indent moves subtree together (B+child C both deeper; got ' + indentB.map(i => i.level).join(',') + ')')
  const moveB = moveUp(sg, 1) // B has previous sibling A -> can move up
  assert(moveB.map(i => i.id).join(',') === 'b,c,a,d', 'move subtree up moves child with it (got ' + moveB.map(i => i.id).join(',') + ')')
}

// ===================== VALIDATION ON OPERATIONS (structural) =====================
{
  // after indent B, the draft must still be structurally valid (no level jump)
  const afterIndent = indentSubtree([item('a', 'A', 1, 1), item('b', 'B', 1, 2)], 1)
  const v = validateChapterDraft(afterIndent, 10)
  assert(v.ok === true, 'indent result is structurally valid')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
