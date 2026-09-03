// Manual Chapter Builder domain (Stage 9.4A). PURE — no React / CSS / IndexedDB /
// PDF.js / API. The builder UI edits a FLAT preorder draft and this module owns
// the single normalize / validate / derive-ranges / build-tree pipeline so that
// any future AI TOC output converts into the SAME draft layer.
//
// Key invariants (see Stage 9.4A brief):
//   - ChapterDraftItem :: flat preorder list the user edits.
//   - levels integer >= 1; first item must be level 1; each next item may go
//     at most ONE level deeper than its predecessor (no jumping parents).
//   - startPage integer in [1, pageCount]; global preorder non-decreasing.
//   - Same parent's siblings must have STRICTLY increasing startPage (else you
//     could not derive two non-empty sibling ranges).
//   - endPage is auto-derived (never hand-filled): a node's range ends just
//     before the next node with level <= its own, or at pageCount.
//   - all valid manual nodes selectable = true, source = 'manual'.
//   - editing metadata never changes id (PdfSelection.selectedChapterIds may
//     reference these ids); only genuinely new nodes get a fresh newStableId().
import { newStableId } from '../engine/types'
import type { ChapterNode, DocumentChapterSource } from './document-types'

export type ChapterDraftItem = {
  id: string
  title: string
  level: number
  /** Physical page at which this chapter begins (1-based). */
  startPage: number
}

/** Max UI depth (deliberately NOT Backup's 24-level safety cap). */
export const MAX_CHAPTER_LEVEL = 8

export type ChapterDraftIssue =
  | { index: number; code: 'blank-title'; message: string }
  | { index: number; code: 'level-not-int'; message: string }
  | { index: number; code: 'level-zero'; message: string }
  | { index: number; code: 'level-too-deep'; message: string }
  | { index: number; code: 'first-not-level-1'; message: string }
  | { index: number; code: 'level-jump'; message: string }
  | { index: number; code: 'page-not-int'; message: string }
  | { index: number; code: 'page-out-of-range'; message: string }
  | { index: number; code: 'page-decreases'; message: string }
  | { index: number; code: 'sibling-same-page'; message: string }
  | { index: number; code: 'duplicate-id'; message: string }

export type ChapterDraftValidation = {
  ok: boolean
  issues: ChapterDraftIssue[]
}

/** True when a parent/child relationship (deeper level) is allowed at index i
 *  given the previous item. Used by both validation and the derivations. */
function isLevelTransitionAllowed(prevLevel: number, nextLevel: number): boolean {
  // 1->2 ok, 2->3 ok, 3->1 ok, 3->2 ok; 1->3 forbidden, 2->4 forbidden, ...
  return nextLevel <= prevLevel + 1
}

/**
 * Validate a flat preorder draft against the level / page / sibling rules.
 * Pure, deterministic, never mutates `items`. An empty draft is valid (the
 * canonical empty state is chapterSource 'none' after save).
 */
export function validateChapterDraft(items: ChapterDraftItem[], pageCount: number): ChapterDraftValidation {
  const issues: ChapterDraftIssue[] = []
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const label = it.title || '第 ' + (i + 1) + ' 项'

    if (it.title.trim() === '') {
      issues.push({ index: i, code: 'blank-title', message: '第 ' + (i + 1) + ' 项标题不能为空。' })
    }
    if (!Number.isInteger(it.level)) {
      issues.push({ index: i, code: 'level-not-int', message: '「' + label + '」的层级必须是整数。' })
    } else if (it.level < 1) {
      issues.push({ index: i, code: 'level-zero', message: '「' + label + '」的层级不能小于 1。' })
    } else if (it.level > MAX_CHAPTER_LEVEL) {
      issues.push({ index: i, code: 'level-too-deep', message: '「' + label + '」的层级不能超过 ' + MAX_CHAPTER_LEVEL + '。' })
    }
    if (i === 0 && it.level !== 1) {
      issues.push({ index: 0, code: 'first-not-level-1', message: '第 1 项必须是第 1 级（最顶层）。' })
    }
    if (i > 0 && Number.isInteger(items[i - 1].level) && Number.isInteger(it.level) && items[i - 1].level >= 1 && it.level >= 1) {
      if (!isLevelTransitionAllowed(items[i - 1].level, it.level)) {
        issues.push({ index: i, code: 'level-jump', message: '「' + label + '」不能从第 ' + items[i - 1].level + ' 级直接跳到第 ' + it.level + ' 级。' })
      }
    }

    if (!Number.isInteger(it.startPage)) {
      issues.push({ index: i, code: 'page-not-int', message: '「' + label + '」的起始页必须是整数。' })
    } else if (it.startPage < 1 || it.startPage > pageCount) {
      issues.push({ index: i, code: 'page-out-of-range', message: '「' + label + '」的起始页超出范围（1–' + pageCount + '）。' })
    }
    if (i > 0 && Number.isInteger(items[i - 1].startPage) && Number.isInteger(it.startPage)) {
      if (it.startPage < items[i - 1].startPage) {
        issues.push({ index: i, code: 'page-decreases', message: '「' + label + '」的起始页不能小于上一章节。' })
      }
    }
    if (seen.has(it.id)) {
      issues.push({ index: i, code: 'duplicate-id', message: '存在重复的章节标识。' })
    }
    seen.add(it.id)
  }
  return { ok: issues.length === 0, issues }
}

/**
 * Derive the endPage for every node in a validated flat preorder draft.
 * A node's range ends just before the next node whose level <= its own; if
 * none exists it extends to pageCount. Returns a parallel array of endPages.
 */
export function deriveChapterEndPages(items: ChapterDraftItem[], pageCount: number): number[] {
  const ends: number[] = new Array(items.length).fill(pageCount)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const level = it.level
    let end = pageCount
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].level <= level) {
        // Same-page siblings may legitimately share a physical start page (the PDF
        // page-level model cannot express a half-page boundary). In that case the
        // node's range collapses to its own start page rather than to start-1 (which
        // would be < startPage). Only when the next node is strictly LATER does the
        // range end just before it.
        end = items[j].startPage > it.startPage ? items[j].startPage - 1 : it.startPage
        break
      }
    }
    // Invariant: endPage >= startPage always holds for a validated (non-decreasing) draft.
    ends[i] = Math.max(it.startPage, end)
  }
  return ends
}

/**
 * Build the persistent ChapterNode tree from a VALIDATED flat preorder draft.
 * All manual nodes are selectable=true, source='manual'. Throws on any invalid
 * input (callers validate first; this is the safety backstop).
 */
export function buildManualChapterTree(items: ChapterDraftItem[], pageCount: number): ChapterNode[] {
  return buildChapterTreeFromDraft(items, pageCount, 'manual')
}

/**
 * General core: build a persistent ChapterNode tree from a VALIDATED flat preorder
 * draft, with an explicit source ('manual' or 'ai-toc'). Same validation / range
 * derivation for every source — never fork a second builder. Throws on invalid input.
 */
export function buildChapterTreeFromDraft(items: ChapterDraftItem[], pageCount: number, source: 'manual' | 'ai-toc'): ChapterNode[] {
  const v = validateChapterDraft(items, pageCount)
  if (!v.ok) throw new Error('invalid chapter draft: ' + v.issues.map(i => i.message).join('；'))
  const ends = deriveChapterEndPages(items, pageCount)

  const roots: ChapterNode[] = []
  const stack: ChapterNode[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const node: ChapterNode = {
      id: it.id,
      title: it.title.trim(),
      level: it.level,
      startPage: it.startPage,
      endPage: ends[i],
      selectable: true,
      source,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= it.level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/**
 * Flatten a persisted ChapterNode tree back to the flat preorder draft,
 * preserving id / title / level / startPage / order. Node.endPage is NOT kept
 * (it is always re-derived on save). Throws if a selectable manual node has a
 * null startPage (should not happen for manual trees).
 */
export function flattenManualChapters(chapters: ChapterNode[]): ChapterDraftItem[] {
  const out: ChapterDraftItem[] = []
  const walk = (nodes: ChapterNode[]) => {
    for (const n of nodes) {
      if (n.startPage == null) throw new Error('manual chapter without startPage: ' + n.id)
      out.push({ id: n.id, title: n.title, level: n.level, startPage: n.startPage })
      walk(n.children)
    }
  }
  walk(chapters)
  return out
}

/**
 * Convert an arbitrary ChapterNode tree (native / manual / ai-toc) into an
 * EDITABLE flat preorder draft. Unlike flattenManualChapters this tolerates the
 * unresolved nodes a native outline may carry (startPage === null or not
 * selectable) WITHOUT fabricating a page number: those nodes are SKIPPED and
 * counted, and their resolved descendants are re-leveled to a valid contiguous
 * hierarchy (kept-depth + 1) so the resulting draft always passes the validator.
 * id / title / startPage / preorder are preserved; never mutates `chapters`.
 */
export function chaptersToEditableDraft(chapters: ChapterNode[]): { items: ChapterDraftItem[]; skippedUnresolved: number } {
  const items: ChapterDraftItem[] = []
  let skippedUnresolved = 0
  const walk = (nodes: ChapterNode[], parentLevel: number) => {
    for (const n of nodes) {
      if (n.selectable && n.startPage != null) {
        const level = parentLevel + 1
        items.push({ id: n.id, title: n.title, level, startPage: n.startPage })
        walk(n.children, level)
      } else {
        skippedUnresolved++
        // Descendants of an unresolved node re-level under the nearest kept ancestor.
        walk(n.children, parentLevel)
      }
    }
  }
  walk(chapters, 0)
  return { items, skippedUnresolved }
}

/** Deep clone a draft so editing never mutates the persisted tree source. */
export function cloneChapterDraft(items: ChapterDraftItem[]): ChapterDraftItem[] {
  return items.map(it => ({ ...it }))
}

/**
 * Build a single new draft item. `currentPage` is clamped to [1, pageCount].
 * level defaults to 1, or the selected item's level when `inheritLevel` is a
 * valid level >= 1. Title defaults to "新章节".
 */
export function makeNewChapterItem(opts: { currentPage: number; pageCount: number; level?: number }): ChapterDraftItem {
  const page = Math.min(Math.max(1, Math.floor(opts.currentPage || 1)), Math.max(1, opts.pageCount))
  const level = opts.level && Number.isInteger(opts.level) && opts.level >= 1 && opts.level <= MAX_CHAPTER_LEVEL ? opts.level : 1
  return { id: newStableId(), title: '新章节', level, startPage: page }
}

/** Canonical source for a built tree: empty tree -> 'none', else 'manual'. */
export function chapterSourceForTree(tree: ChapterNode[]): DocumentChapterSource {
  return tree.length === 0 ? 'none' : 'manual'
}

// ---- editing operations (pure; return NEW arrays, never mutate input) ----

/** Delete the item at `index` together with its ENTIRE subtree. */
export function deleteDraftSubtree(items: ChapterDraftItem[], index: number): ChapterDraftItem[] {
  if (index < 0 || index >= items.length) return items
  const level = items[index].level
  let end = index + 1
  while (end < items.length && items[end].level > level) end++
  return [...items.slice(0, index), ...items.slice(end)]
}

/** Does the item at `index` have any descendants? */
export function draftHasChildren(items: ChapterDraftItem[], index: number): boolean {
  if (index < 0 || index >= items.length) return false
  const level = items[index].level
  return index + 1 < items.length && items[index + 1].level > level
}

/** Number of items in the subtree rooted at `index`. */
export function subtreeSize(items: ChapterDraftItem[], index: number): number {
  if (index < 0 || index >= items.length || items[index].level < 1) return 0
  const level = items[index].level
  let size = 1
  let k = index + 1
  while (k < items.length && items[k].level > level) { size++; k++ }
  return size
}

/** Indent a subtree under its previous sibling, when one exists. */
export function indentSubtree(items: ChapterDraftItem[], index: number): ChapterDraftItem[] {
  const prev = previousSiblingIndex(items, index)
  if (prev < 0) return items
  const size = subtreeSize(items, index)
  return items.map((it, i) => (i >= index && i < index + size ? { ...it, level: it.level + 1 } : { ...it }))
}

/** Outdent a subtree by one level. Cannot go below level 1. */
export function outdentSubtree(items: ChapterDraftItem[], index: number): ChapterDraftItem[] {
  if (index < 0 || index >= items.length || items[index].level <= 1) return items
  const size = subtreeSize(items, index)
  return items.map((it, i) => (i >= index && i < index + size ? { ...it, level: it.level - 1 } : { ...it }))
}

/** Index of the nearest strictly-shallower-or-equal level item before index. */
function previousSiblingIndex(items: ChapterDraftItem[], index: number): number {
  if (index < 1) return -1
  const level = items[index].level
  let k = index - 1
  while (k >= 0 && items[k].level > level) k--
  if (k < 0) return -1
  if (items[k].level < level) return -1 // parent is not a sibling
  return k
}

/**
 * Page-aware top-level insertion for a NEW chapter (Stage 9.4B.1). The chapter
 * order in a manual draft derives from physical page order (non-decreasing), so a
 * new top-level chapter (level 1, startPage P) is inserted after every item with
 * startPage < P, after the existing run of SAME-PAGE level-1 siblings (stable
 * append-within-same-page), and before the first item with startPage > P. Siblings
 * may legitimately share a start page; users can reorder same-page siblings with a
 * zone-validated move. Never returns a conflict. Returns a NEW array (input never
 * mutated).
 */
export type InsertChapterByPageResult =
  | { ok: true; items: ChapterDraftItem[] }

export function insertChapterByPage(items: ChapterDraftItem[], newItem: ChapterDraftItem): InsertChapterByPageResult {
  // This helper is deliberately top-level-only for now (Stage 9.4A.1 semantics).
  if (newItem.level !== 1) return { ok: true, items: insertItem(items, newItem) }
  const P = newItem.startPage
  let insertAt = items.length
  for (let i = 0; i < items.length; i++) {
    // Skip items strictly before P and the same-page run; land before the first > P.
    const sp = items[i].startPage
    if (sp > P) { insertAt = i; break }
  }
  return { ok: true, items: [...items.slice(0, insertAt), newItem, ...items.slice(insertAt)] }
}

/**
 * Whether applying a structural editing operation to the draft at `index`
 * leaves a VALID draft. Stage 9.4A.1 principle: an operation the Builder exposes
 * must never produce an unsavable structure; candidacy = structure valid a
 * posteriori, not just a structural level check. Cheap for the small drafts the
 * builder edits; pure, deterministic, never mutates input.
 */
export function canApplyChapterDraftOperation(
  items: ChapterDraftItem[],
  pageCount: number,
  operation: (items: ChapterDraftItem[], index: number) => ChapterDraftItem[],
  index: number,
): boolean {
  const candidate = operation(cloneChapterDraft(items), index)
  // A no-op (e.g. first item cannot indent) is not a meaningful operation -> disabled.
  if (sameDraftSequence(candidate, items)) return false
  return validateChapterDraft(candidate, pageCount).ok
}

function sameDraftSequence(a: ChapterDraftItem[], b: ChapterDraftItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.id !== y.id || x.title !== y.title || x.level !== y.level || x.startPage !== y.startPage) return false
  }
  return true
}

/** Index of the nearest same-parent sibling immediately after `index`, or -1. */
function nextSiblingIndex(items: ChapterDraftItem[], index: number): number {
  const level = items[index].level
  let k = index + 1
  while (k < items.length && items[k].level > level) k++
  if (k >= items.length) return -1
  return items[k].level === level ? k : -1
}

/**
 * Move a subtree (node + its descendants) UP by one same-parent sibling position.
 * The subtree stays under the SAME parent; never crosses a parent. Returns a NEW
 * array. Callers must gate this with canApplyChapterDraftOperation (a move that would
 * make the draft invalid — e.g. different physical pages swapping -> page decreases —
 * is disabled at the UI).
 */
export function moveUp(items: ChapterDraftItem[], index: number): ChapterDraftItem[] {
  const prev = previousSiblingIndex(items, index)
  if (prev < 0) return items
  const size = subtreeSize(items, index)
  const prevSize = subtreeSize(items, prev)
  const block = items.slice(index, index + size)
  const before = items.slice(0, prev)
  const prevBlock = items.slice(prev, prev + prevSize)
  const after = items.slice(index + size)
  return [...before, ...block, ...prevBlock, ...after]
}

/**
 * Move a subtree DOWN by one same-parent sibling position. The subtree stays under
 * the SAME parent. Returns a NEW array. Gate with canApplyChapterDraftOperation.
 */
export function moveDown(items: ChapterDraftItem[], index: number): ChapterDraftItem[] {
  const next = nextSiblingIndex(items, index)
  if (next < 0) return items
  const size = subtreeSize(items, index)
  const nextSize = subtreeSize(items, next)
  const block = items.slice(index, index + size)
  const before = items.slice(0, index)
  const nextBlock = items.slice(next, next + nextSize)
  const after = items.slice(next + nextSize)
  return [...before, ...nextBlock, ...block, ...after]
}

/** Insert a new item AFTER `index` (or at the start when index < 0). Low-level. */
export function insertItem(items: ChapterDraftItem[], item: ChapterDraftItem, after?: number): ChapterDraftItem[] {
  if (after == null || after < 0) return [item, ...items]
  const at = Math.min(after + 1, items.length)
  return [...items.slice(0, at), item, ...items.slice(at)]
}
