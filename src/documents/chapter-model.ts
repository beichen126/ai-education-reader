// Pure mapping: parsed PDF outline -> persistent ChapterNode tree (Stage 9.2A).
// - Keeps the original PdfOutlineItem.id (Stage 9.1 saved selectedChapterIds
//   therefore keep matching the document's native chapter ids identically).
// - Keeps tree order, depth (level = depth+1), page ranges and selectability
//   EXACTLY as the PdfPanel consumes them — no re-derivation, no id fabrication.
// - Drops the same "noise" nodes the outline UI already hides: external URL
//   leaves without children and blank-title leaves without children.
// - readPdfOutline() itself is untouched (parse artifact remains in src/pdf).
import type { PdfOutlineItem } from '../pdf/pdf-outline'
import type { ChapterNode } from './document-types'

export function chapterNodesFromPdfOutline(items: PdfOutlineItem[]): ChapterNode[] {
  return items
    .filter(it => !(it.resolution === 'external' && it.children.length === 0) && !(it.title.trim() === '' && it.children.length === 0))
    .map(it => ({
      id: it.id,
      title: it.title,
      level: it.depth + 1,
      startPage: it.startPage,
      endPage: it.endPage,
      selectable: it.selectable,
      source: 'native' as const,
      children: chapterNodesFromPdfOutline(it.children),
    }))
}
