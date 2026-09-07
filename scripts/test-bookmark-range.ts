// Stage A: bookmark end-mode range semantics (PURE, no React/storage/UI).
import { exclusiveEndPageOfChapter, resolveBookmarkChapterPdfRange, resolveBookmarkPdfRange, type BookmarkRangeEndMode } from '../src/pdf/bookmark-range.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
const pages = (startPage: number, endPage: number) => Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index)
const resolve = (endMode: BookmarkRangeEndMode, startPage = 10, exclusiveEndPage = 20, pageCount = 40) =>
  resolveBookmarkPdfRange({ startPage, exclusiveEndPage, pageCount, endMode })

// Ordinary range: [10, 20) excludes page 20, while [10, 20] includes it.
{
  const exclusive = resolve('exclusive')
  assert(exclusive.endPage === 19, 'exclusive mode resolves the last included page to 19')
  assert(JSON.stringify(exclusive.pages) === JSON.stringify(pages(10, 19)), 'exclusive mode selects pages 10-19')
}
{
  const inclusive = resolve('inclusive')
  assert(inclusive.endPage === 20, 'inclusive mode resolves the last included page to 20')
  assert(JSON.stringify(inclusive.pages) === JSON.stringify(pages(10, 20)), 'inclusive mode selects pages 10-20')
}

// A single-page chapter has two equivalent user-visible representations.
for (const mode of ['exclusive', 'inclusive'] as const) {
  const one = resolve(mode, 10, 11, 10)
  assert(one.endPage === 10, mode + ' single-page range ends at page 10')
  assert(JSON.stringify(one.pages) === JSON.stringify([10]), mode + ' single-page range selects exactly one page')
}

// The final bookmark's exclusive boundary is pageCount + 1; inclusive mode is capped.
{
  const exclusive = resolve('exclusive', 7, 11, 10)
  const inclusive = resolve('inclusive', 7, 11, 10)
  assert(exclusive.endPage === 10, 'last bookmark exclusive range ends at pageCount')
  assert(inclusive.endPage === 10, 'last bookmark inclusive range is capped at pageCount')
  assert(inclusive.pages.every(page => page >= 1 && page <= 10), 'last bookmark inclusive pages stay within document bounds')
}

// A boundary equal to pageCount still distinguishes the two modes.
{
  const exclusive = resolve('exclusive', 9, 10, 10)
  const inclusive = resolve('inclusive', 9, 10, 10)
  assert(JSON.stringify(exclusive.pages) === JSON.stringify([9]), 'boundary at pageCount excludes the boundary in exclusive mode')
  assert(JSON.stringify(inclusive.pages) === JSON.stringify([9, 10]), 'boundary at pageCount includes the boundary in inclusive mode')
}

{
  const exclusive = resolveBookmarkChapterPdfRange({ startPage: 10, endPage: 19, pageCount: 30, endMode: 'exclusive' })
  const inclusive = resolveBookmarkChapterPdfRange({ startPage: 10, endPage: 19, pageCount: 30, endMode: 'inclusive' })
  assert(exclusive.endPage === 19 && exclusive.pages.length === 10, 'ChapterNode endPage 19 -> exclusive sends pages 10-19')
  assert(inclusive.endPage === 20 && inclusive.pages.length === 11, 'ChapterNode endPage 19 -> inclusive extends to page 20')
  assert(exclusiveEndPageOfChapter(30, 30) === 31, 'last chapter boundary is pageCount + 1')
}

const throws = (input: Parameters<typeof resolveBookmarkPdfRange>[0]) => {
  try { resolveBookmarkPdfRange(input); return false }
  catch (error) { return error instanceof RangeError }
}
assert(throws({ startPage: 0, exclusiveEndPage: 2, pageCount: 10, endMode: 'exclusive' }), 'start page 0 is rejected')
assert(throws({ startPage: 10, exclusiveEndPage: 10, pageCount: 10, endMode: 'exclusive' }), 'empty range boundary is rejected')
assert(throws({ startPage: 10, exclusiveEndPage: 12, pageCount: 10, endMode: 'exclusive' }), 'boundary beyond pageCount + 1 is rejected')
assert(throws({ startPage: 1, exclusiveEndPage: 2, pageCount: 0, endMode: 'exclusive' }), 'non-positive pageCount is rejected')
assert(throws({ startPage: 1, exclusiveEndPage: 2, pageCount: 10, endMode: 'invalid' as BookmarkRangeEndMode }), 'unknown end mode is rejected')
assert(throws({ startPage: 1.5, exclusiveEndPage: 2, pageCount: 10, endMode: 'exclusive' }), 'fractional start page is rejected')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
