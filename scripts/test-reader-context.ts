// Stage 9.2B2: Reader selection semantics (pure).
import { findCurrentChapter, buildCurrentPageSelection, buildChapterSelection, buildManualRangeSelection } from '../src/documents/reader-context.ts'
import type { ChapterNode } from '../src/documents/document-types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const ch = (id: string, title: string, level: number, startPage: number | null, endPage: number | null, children: ChapterNode[] = [], selectable = true, source: ChapterNode['source'] = 'native'): ChapterNode => ({ id, title, level, startPage, endPage, selectable, source, children })

const book: ChapterNode[] = [ch('c4', '第四章', 1, 100, 180, [
  ch('c4.2', '4.2 TCP 拥塞控制', 2, 120, 150, [
    ch('c4.2.3', '4.2.3 快速重传', 3, 126, 132),
  ]),
  ch('c4.8', '4.8 应用层', 2, 160, 180),
]), ch('c5', '第五章', 1, 200, 260)]

// deepest containing node wins
assert(findCurrentChapter(book, 128)?.id === 'c4.2.3', 'deepest containing chapter (128 -> 4.2.3, got ' + findCurrentChapter(book, 128)?.id + ')')
assert(findCurrentChapter(book, 121)?.id === 'c4.2', 'parent+child overlap -> child (121 -> 4.2)')
assert(findCurrentChapter(book, 110)?.id === 'c4', 'chapter only (110 -> 第四章)')
// same depth -> narrower
const overlap: ChapterNode[] = [ch('a', 'A', 1, 100, 180), ch('b', 'B', 1, 120, 150), ch('c', 'C', 1, 130, 140)]
assert(findCurrentChapter(overlap, 135)?.id === 'c', 'same depth -> narrowest span (c)')
// same depth + same span -> TOC first
const same1: ChapterNode[] = [ch('x', 'X', 1, 100, 140), ch('y', 'Y', 1, 100, 140)]
assert(findCurrentChapter(same1, 120)?.id === 'x', 'same depth+span -> TOC first (x)')
// no containing chapter -> null
assert(findCurrentChapter(book, 50) === null, 'cover page (50) -> null')
assert(findCurrentChapter(book, 190) === null, 'gap page (190) -> null')
// null-range/unselectable ignored
const weird: ChapterNode[] = [ch('n', 'No-range', 1, null, null), ch('s', 'Sel', 1, 10, 20, [], false)]
assert(findCurrentChapter(weird, 15) === null, 'unselectable / null-range chapters ignored')
// source-agnostic
const aiToc: ChapterNode[] = [ch('t', 'AI 章', 1, 1, 5, [], true, 'ai-toc')]
assert(findCurrentChapter(aiToc, 3)?.id === 't', 'ai-toc chapter resolvable too')
const manualSrc: ChapterNode[] = [ch('m', '手动章', 1, 7, 9, [], true, 'manual')]
assert(findCurrentChapter(manualSrc, 8)?.id === 'm', 'manual-source chapter resolvable too')

// selection builders
const cp = buildCurrentPageSelection(126)
assert(cp.kind === 'manual' && cp.ranges.length === 1 && cp.ranges[0].startPage === 126 && cp.ranges[0].endPage === 126, 'current page -> manual single page')
const cch = buildChapterSelection(findCurrentChapter(book, 128)!)
assert(cch.kind === 'outline' && cch.title === '4.2.3 快速重传' && cch.ranges[0].startPage === 126 && cch.ranges[0].endPage === 132 && cch.selectedChapterIds?.[0] === 'c4.2.3', 'chapter selection metadata (title/ranges/selectedChapterIds)')
const mr = buildManualRangeSelection(120, 135)
assert(mr.kind === 'manual' && mr.ranges[0].startPage === 120 && mr.ranges[0].endPage === 135, 'manual range selection')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
