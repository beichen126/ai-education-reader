// Stage 9.4A.2: native outline -> editable draft adapter domain tests (PURE).
import { chaptersToEditableDraft, validateChapterDraft } from '../src/documents/chapter-builder.ts'
import type { ChapterNode } from '../src/documents/document-types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const node = (id: string, title: string, level: number, startPage: number | null, selectable = true, children: ChapterNode[] = []): ChapterNode => ({ id, title, level, startPage, endPage: startPage != null ? startPage + 3 : null, selectable, source: 'native', children })

// 1. all-resolved native tree -> draft preserves id/title/level/startPage/preorder
{
  const tree = [
    node('1', '绪论', 1, 1, true, [node('1a', '一、自然地理学', 2, 5)]),
    node('2', '第二章', 1, 20),
  ]
  const { items, skippedUnresolved } = chaptersToEditableDraft(tree)
  assert(skippedUnresolved === 0, 'no unresolved nodes -> skipped 0')
  assert(items.length === 3, '3 items imported (got ' + items.length + ')')
  assert(items[0].id === '1' && items[0].title === '绪论' && items[0].level === 1 && items[0].startPage === 1, 'root id/title/level/page preserved')
  assert(items[1].id === '1a' && items[1].title === '一、自然地理学' && items[1].level === 2 && items[1].startPage === 5, 'child id/title/level/page preserved')
  assert(items[2].id === '2' && items[2].level === 1 && items[2].startPage === 20, 'second root preserved')
  assert(validateChapterDraft(items, 100).ok, 'resulting draft valid')
}

// 2. unresolved node (null startPage) skipped + counted; descendants re-leveled to valid
{
  const tree = [
    node('1', 'Part I', 1, null, false, [   // unresolved container label
      node('1a', '第一章', 2, 5, true),
      node('1b', '第二章', 2, 20, true),
    ]),
  ]
  const { items, skippedUnresolved } = chaptersToEditableDraft(tree)
  assert(skippedUnresolved === 1, 'unresolved node counted (got ' + skippedUnresolved + ')')
  assert(items.length === 2, 'children of unresolved imported (got ' + items.length + ')')
  // children re-leveled under the kept ancestor (level 0) -> become level 1
  assert(items[0].id === '1a' && items[0].level === 1 && items[0].startPage === 5, 'child re-leveled to level 1')
  assert(items[1].id === '1b' && items[1].level === 1 && items[1].startPage === 20, 'second child re-leveled to level 1')
  assert(validateChapterDraft(items, 100).ok, 're-leveled draft is valid (no orphan level jump)')
}

// 3. non-selectable node with a page also skipped (cannot be an editable chapter)
{
  const tree = [node('x', '链接', 2, 5, false), node('2', '真实章节', 1, 20)]
  const { items, skippedUnresolved } = chaptersToEditableDraft(tree)
  assert(skippedUnresolved === 1, 'non-selectable counted')
  assert(items.length === 1 && items[0].id === '2', 'only real chapter imported')
}

// 4. preorder preserved across nested resolved nodes
{
  const tree = [
    node('1', 'C1', 1, 1, true, [
      node('1a', 'C1.1', 2, 2, true, [node('1a1', 'C1.1.1', 3, 3)]),
      node('1b', 'C1.2', 2, 10, true),
    ]),
    node('2', 'C2', 1, 20, true),
  ]
  const { items } = chaptersToEditableDraft(tree)
  assert(items.map(i => i.id).join(',') === '1,1a,1a1,1b,2', 'preorder preserved (got ' + items.map(i => i.id).join(',') + ')')
  assert(items.map(i => i.level).join(',') === '1,2,3,2,1', 'levels preserved for fully-resolved tree')
}

// 5. input tree not mutated
{
  const tree = [node('1', 'A', 1, 1, true, [node('1a', 'A.1', 2, null, false)])]
  const before = JSON.stringify(tree)
  chaptersToEditableDraft(tree)
  assert(JSON.stringify(tree) === before, 'native input tree NOT mutated')
}

// 6. empty tree -> empty draft
{
  const { items, skippedUnresolved } = chaptersToEditableDraft([])
  assert(items.length === 0 && skippedUnresolved === 0, 'empty tree -> empty draft')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
