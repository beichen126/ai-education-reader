// Stage 2: bounds/presentation paths must stay bounded for long chapter trees.
import { buildChapterNodesSelection } from '../src/documents/document-context.ts'
import { bookmarkRangePresentation, resolveBookmarkChapterPdfRangeBounds } from '../src/pdf/bookmark-range.ts'
import type { ChapterNode } from '../src/documents/document-types.ts'

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
  console.log('  ok: ' + message)
}

const node = (id: string): ChapterNode => ({
  id,
  title: 'Long chapter ' + id,
  level: 1,
  startPage: 1,
  endPage: 10000,
  selectable: true,
  source: 'manual',
  children: [],
})

const nodes = Array.from({ length: 2000 }, (_, index) => node(String(index)))
const started = performance.now()
const presentations = nodes.map(chapter => bookmarkRangePresentation({ startPage: chapter.startPage!, endPage: chapter.endPage!, pageCount: 10000 }))
const selection = buildChapterNodesSelection(nodes, { pageCount: 10000 })
const elapsed = performance.now() - started

assert(presentations.length === 2000, 'presentation helper handles 2,000 nodes')
assert(presentations.every(item => !Object.prototype.hasOwnProperty.call(item.exclusive, 'pages') && !Object.prototype.hasOwnProperty.call(item.inclusive, 'pages')), 'presentation helper does not allocate page arrays')
assert(selection.ranges.length === 1 && selection.ranges[0].startPage === 1 && selection.ranges[0].endPage === 10000, 'selection bounds normalize without page expansion')
assert(selection.ranges.every(range => !Object.prototype.hasOwnProperty.call(range, 'pages')), 'selection output contains PdfRange bounds only')
const bounds = resolveBookmarkChapterPdfRangeBounds({ startPage: 1, endPage: 10000, pageCount: 10000, endMode: 'exclusive' })
assert(!Object.prototype.hasOwnProperty.call(bounds, 'pages'), 'bounds resolver has no pages property')
assert(elapsed < 1000, '2,000-node bounds/presentation regression stays under 1 second (' + Math.round(elapsed) + ' ms)')

console.log('RESULT pass=6 fail=0')
