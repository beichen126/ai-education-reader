// Reader -> Context selection semantics (Stage 9.2B2). Pure, no React/CSS — the
// DocumentReader only orchestrates; these helpers own the rules.
import type { ChapterNode } from './document-types'
import type { PdfRange, PdfSelection } from '../pdf/pdf-types'

/**
 * Deepest containing selectable chapter for a page — deterministic:
 *   1. candidate = selectable with startPage/endPage covering the page
 *   2. deepest level wins (4.2.3 beats 4.2 beats 第四章)
 *   3. same depth -> narrower span wins
 *   4. same depth + span -> first in TOC order (tree order)
 * Source-agnostic (native / ai-toc / manual) so Stage 9.4 chapters work as-is.
 */
export function findCurrentChapter(chapters: ChapterNode[], page: number): ChapterNode | null {
  let best: ChapterNode | null = null
  let bestSpan = Number.POSITIVE_INFINITY
  let bestOrder = Number.POSITIVE_INFINITY
  let order = 0
  const walk = (nodes: ChapterNode[]) => {
    for (const n of nodes) {
      const myOrder = order++
      if (n.selectable && n.startPage != null && n.endPage != null && n.startPage <= page && page <= n.endPage) {
        const span = n.endPage - n.startPage + 1
        const level = n.level
        if (!best) { best = n; bestSpan = span; bestOrder = myOrder }
        else if (level > best.level) { best = n; bestSpan = span; bestOrder = myOrder }
        else if (level === best.level) {
          if (span < bestSpan) { best = n; bestSpan = span; bestOrder = myOrder }
          else if (span === bestSpan && myOrder < bestOrder) { best = n; bestOrder = myOrder }
        }
      }
      walk(n.children)
    }
  }
  walk(chapters)
  return best
}

export function buildCurrentPageSelection(page: number): PdfSelection {
  return { kind: 'manual', ranges: [{ startPage: page, endPage: page }] }
}

export function buildChapterSelection(chapter: ChapterNode): PdfSelection {
  return {
    kind: 'outline',
    title: chapter.title,
    ranges: [{ startPage: chapter.startPage!, endPage: chapter.endPage! }],
    selectedChapterIds: [chapter.id],
  }
}

export function buildManualRangeSelection(start: number, end: number): PdfSelection {
  return { kind: 'manual', ranges: [{ startPage: start, endPage: end }] }
}

export function selectionRangesOf(selection: PdfSelection): PdfRange[] {
  return selection.ranges
}
