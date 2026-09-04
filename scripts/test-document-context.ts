
// Document -> Context domain tests (Stage 9.5 / v1.0.0, Part 0.7).
import { findCurrentChapterPath, findChapterPathById, buildChapterNodesSelection, selectableChapterRange } from '../src/documents/document-context.ts'
import { findCurrentChapter } from '../src/documents/reader-context.ts'
import { countPdfRangePages, MAX_PDF_CONTEXT_PAGES } from '../src/pdf/pdf-types.ts'

let pass = 0, fail = 0
const assert = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const ch = (id: string, title: string, level: number, startPage: number, endPage: number, children: any[] = [], selectable = true): any => ({ id, title, level, startPage, endPage, children, selectable, source: 'manual' })

const tree = [
  ch('A', '第一章', 1, 1, 100, [
    ch('A1', '第一节', 2, 10, 50, [
      ch('A1a', '三、与其他学科的关系', 3, 20, 30),
    ]),
  ]),
  ch('B', '第二章', 1, 1, 100, []),
  ch('C', '第三章', 1, 100, 120, []),
]

// findCurrentChapterPath: page 25 -> [A, A1, A1a] (deepest)
const p = findCurrentChapterPath(tree as any, 25)
assert(p.map(n => n.id).join(',') === 'A,A1,A1a', 'findCurrentChapterPath page25 -> A,A1,A1a (got ' + p.map(n => n.id).join(',') + ')')
assert(findCurrentChapter(tree as any, 25).id === 'A1a', 'findCurrentChapter deepest = A1a')

// parent context: select A1 -> range 10-50
const selA1 = buildChapterNodesSelection([(tree as any)[0].children[0]])
assert(selA1.ranges.length === 1 && selA1.ranges[0].startPage === 10 && selA1.ranges[0].endPage === 50, 'parent A1 -> PDF 10-50')
assert(selA1.title === '第一节', 'A1 title kept')

// multi chapter: A + C -> ranges 10-100? No, A is 1-100, C is 100-120 -> normalized merge 1-120
const selAC = buildChapterNodesSelection([(tree as any)[0], (tree as any)[2]])
assert(selAC.ranges.length === 1 && selAC.ranges[0].startPage === 1 && selAC.ranges[0].endPage === 120, 'A(1-100)+C(100-120) -> normalized 1-120')
assert(selAC.selectedChapterIds?.join(',') === 'A,C', 'selectedChapterIds TOC order A,C')
assert(selAC.title === '第一章、第三章', 'multi title join')

// overlap: parent A1 (10-50) + child A1a (20-30) -> normalized 10-50, count 41
const selOverlap = buildChapterNodesSelection([(tree as any)[0].children[0], (tree as any)[0].children[0].children[0]])
assert(countPdfRangePages(selOverlap.ranges) === 41, 'parent+child overlap deduped -> 41 pages (got ' + countPdfRangePages(selOverlap.ranges) + ')')
assert(selOverlap.selectedChapterIds?.join(',') === 'A1,A1a', 'overlap keeps both provenance ids')

// non-contiguous: A1(10-50) + C(100-120) -> 2 ranges, count 62
const selNC = buildChapterNodesSelection([(tree as any)[0].children[0], (tree as any)[2]])
assert(selNC.ranges.length === 2, 'non-contiguous -> 2 ranges')
assert(countPdfRangePages(selNC.ranges) === 41 + 21, 'non-contiguous count = 62')

// selectableChapterRange: unresolvable node -> null
assert(selectableChapterRange({ ...(tree as any)[0], startPage: null }) === null, 'unresolvable node -> null range')

assert(MAX_PDF_CONTEXT_PAGES === 120, 'MAX_PDF_CONTEXT_PAGES = 120')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
