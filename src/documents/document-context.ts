
// Document -> Context selection domain (Stage 9.5 / v1.0.0, Part 0.7). PURE — no React,
// no storage, no PdfSession. One source of truth for turning a persisted ChapterNode
// tree into a multi-chapter PdfSelection (normalized, deduped, TOC-order titles) and for
// resolving the deterministic current-chapter ancestry path.
import type { ChapterNode } from './document-types'
import type { PdfRange, PdfSelection } from '../pdf/pdf-types'
import { normalizePdfRanges, pdfSelectionTitle, countPdfRangePages } from '../pdf/pdf-types'
import { findCurrentChapter } from './reader-context'

/** Find the node with the given id, or null. */
export function findChapterById(chapters: ChapterNode[], id: string): ChapterNode | null {
  for (const n of chapters) { if (n.id === id) return n; const f = findChapterById(n.children, id); if (f) return f }
  return null
}

/** Ancestor path (root -> ... -> node) for a node id, or null if absent. */
export function findChapterPathById(chapters: ChapterNode[], id: string): ChapterNode[] | null {
  const walk = (nodes: ChapterNode[], path: ChapterNode[]): ChapterNode[] | null => {
    for (const n of nodes) {
      const next = [...path, n]
      if (n.id === id) return next
      const f = walk(n.children, next); if (f) return f
    }
    return null
  }
  return walk(chapters, [])
}

/** Ancestry [root -> ... -> deepest] for a page, or [] if in no chapter. */
export function findCurrentChapterPath(chapters: ChapterNode[], page: number): ChapterNode[] {
  const deepest = findCurrentChapter(chapters, page)
  if (!deepest) return []
  return findChapterPathById(chapters, deepest.id) || []
}

function selectable(node: ChapterNode): boolean {
  return node.selectable && node.startPage != null && node.endPage != null
}

/** The valid physical range of a single selectable chapter, or null if unresolvable. */
export function selectableChapterRange(node: ChapterNode): PdfRange | null {
  if (!selectable(node)) return null
  return { startPage: node.startPage as number, endPage: node.endPage as number }
}

/** Build a multi-chapter PdfSelection from an arbitrary set of persisted chapters.
 *  - merged into ONE selection with normalized, deduped ranges
 *  - parent+child overlap deduped to the union (never double-renders a page)
 *  - titles kept in TOC (tree) order, not click order
 *  - selectedChapterIds keeps the user's original choices as provenance. */
export function buildChapterNodesSelection(nodes: ChapterNode[]): PdfSelection {
  // `nodes` arrive in TOC (tree) order from the picker; they are the SELECTED chapters
  // (a parent and/or its children may both be chosen). Keep that order, drop unresolvable.
  const ordered = nodes.filter(selectable)
  const ranges = normalizePdfRanges(ordered.map(n => ({ startPage: n.startPage as number, endPage: n.endPage as number })))
  const titles = ordered.map(n => n.title)
  const out: PdfSelection = { kind: 'outline', ranges }
  if (titles.length) out.title = pdfSelectionTitle(titles)
  if (ordered.length) out.selectedChapterIds = ordered.map(n => n.id)
  return out
}

export { countPdfRangePages }
