/**
 * The right boundary of a bookmark range is derived once, before the user's
 * end-mode preference is applied. It is always an exclusive PDF page boundary:
 * [startPage, exclusiveEndPage).
 */
export type BookmarkRangeEndMode = 'exclusive' | 'inclusive'

export type BookmarkPdfRange = {
  startPage: number
  endPage: number
  pages: number[]
}

export type ResolveBookmarkPdfRangeInput = {
  startPage: number
  exclusiveEndPage: number
  pageCount: number
  endMode: BookmarkRangeEndMode
}

/**
 * Resolve the physical pages selected by one bookmark.
 *
 * `exclusiveEndPage` is the canonical right boundary derived from the chapter
 * tree. An inclusive preference includes that boundary too, while the final
 * page is always capped at `pageCount` for the last bookmark.
 */
export function resolveBookmarkPdfRange({
  startPage,
  exclusiveEndPage,
  pageCount,
  endMode,
}: ResolveBookmarkPdfRangeInput): BookmarkPdfRange {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new RangeError('pageCount must be a positive integer')
  }
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > pageCount) {
    throw new RangeError('startPage must be an integer within the PDF page count')
  }
  if (!Number.isInteger(exclusiveEndPage) || exclusiveEndPage <= startPage || exclusiveEndPage > pageCount + 1) {
    throw new RangeError('exclusiveEndPage must be an integer after startPage and at most pageCount + 1')
  }
  if (endMode !== 'exclusive' && endMode !== 'inclusive') {
    throw new RangeError('endMode must be exclusive or inclusive')
  }

  const endPage = endMode === 'exclusive'
    ? exclusiveEndPage - 1
    : Math.min(exclusiveEndPage, pageCount)
  if (endPage < startPage || endPage > pageCount) {
    throw new RangeError('resolved bookmark range is outside the PDF page count')
  }

  const pages = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index)
  return { startPage, endPage, pages }
}
