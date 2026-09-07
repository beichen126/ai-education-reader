import type { BookmarkRangeEndMode } from '../pdf/bookmark-range'
import type { ChapterNode } from './document-types'

export type BookmarkRangePreferences = Record<string, BookmarkRangeEndMode>

export const DEFAULT_BOOKMARK_RANGE_END_MODE: BookmarkRangeEndMode = 'exclusive'

export function isBookmarkRangeEndMode(value: unknown): value is BookmarkRangeEndMode {
  return value === 'exclusive' || value === 'inclusive'
}

function chapterIds(chapters: ChapterNode[]): Set<string> {
  const ids = new Set<string>()
  const walk = (nodes: ChapterNode[]) => {
    for (const node of nodes) {
      ids.add(node.id)
      walk(node.children)
    }
  }
  walk(chapters)
  return ids
}

/**
 * Keep only preferences belonging to the current stable chapter tree. This is
 * deliberately tolerant: old/corrupt rows are readable, but never allowed to
 * attach a stale preference to a later chapter with a reused title or index.
 */
export function sanitizeBookmarkRangePreferences(
  chapters: ChapterNode[],
  value: unknown,
): BookmarkRangePreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const ids = chapterIds(chapters)
  const out: BookmarkRangePreferences = {}
  for (const [id, mode] of Object.entries(value as Record<string, unknown>)) {
    if (ids.has(id) && isBookmarkRangeEndMode(mode)) out[id] = mode
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function bookmarkRangeEndModeOf(
  preferences: BookmarkRangePreferences | undefined,
  chapterId: string,
): BookmarkRangeEndMode {
  return preferences?.[chapterId] ?? DEFAULT_BOOKMARK_RANGE_END_MODE
}

export function hasChapterId(chapters: ChapterNode[], chapterId: string): boolean {
  return chapterIds(chapters).has(chapterId)
}
