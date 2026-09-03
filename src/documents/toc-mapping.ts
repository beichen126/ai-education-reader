// TOC page mapping domain (Stage 9.4B). PURE — maps the model's printed pageLabel
// to a PDF physical page. PDF.js page labels (getPageLabels) are preferred; when the
// PDF has none we fall back to a human-calibrated numeric offset. Never fabricates
// a page: an unmappable label stays unresolved (kept in the review list) until the
// user confirms it. Individual manual overrides survive a global remap.
import { validateChapterDraft, type ChapterDraftItem } from './chapter-builder'
export type MappedTocItem = {
  title: string
  level: number
  pageLabel: string
  tocPage: number
  /** Physical PDF page once resolved; null = unresolved (needs human confirmation). */
  startPage: number | null
  /** True when the user manually overrode startPage (immune to global remap). */
  manualOverride?: boolean
}

/** Exact label -> physical page (1-based PDF index). Returns 0 if not found. */
export function exactLabelToPage(labels: string[] | null | undefined, pageLabel: string): number {
  if (!labels) return 0
  const target = String(pageLabel).trim()
  for (let i = 0; i < labels.length; i++) if (String(labels[i]).trim() === target) return i + 1
  return 0
}

/** Metric that all page labels look like plain sequential digits (1,2,3…). */
export function labelsArePlainNumeric(labels: string[] | null | undefined): boolean {
  if (!labels || labels.length === 0) return false
  for (let i = 0; i < labels.length; i++) {
    if (!/^\d+$/.test(String(labels[i]).trim())) return false
  }
  return true
}

/**
 * Resolve an item by exact page-label match. Returns the physical page or null.
 */
export function resolveItemByLabels(labels: string[] | null | undefined, item: { pageLabel: string }): number | null {
  const p = exactLabelToPage(labels, item.pageLabel)
  return p > 0 ? p : null
}

/**
 * Build the initial mapped list from raw model entries + optional PDF labels.
 * Items that match exactly get a physical page; the rest stay unresolved.
 */
export function buildInitialMapping(entries: { title: string; level: number; pageLabel: string; tocPage: number }[], labels: string[] | null): MappedTocItem[] {
  return entries.map(e => {
    const p = exactLabelToPage(labels, e.pageLabel)
    return { ...e, startPage: p > 0 ? p : null }
  })
}

/** Is a page label a plain Arabic integer string? */
export function isNumericLabel(label: string): boolean { return /^\d+$/.test(String(label).trim()) }

/**
 * Compute a numeric offset from ONE calibration anchor: printed label N maps to
 * physical page M, so M - N is the constant offset for Arabic labels.
 */
export function numericOffsetFromAnchor(printed: number, physicalPage: number): number {
  return physicalPage - printed
}

/**
 * Recompute Arabic-numeric mapped items using a global offset. Items already tagged
 * manualOverride are preserved (never remapped). Only applies to items whose label is
 * a plain integer and which are currently unresolved or offset-derived.
 */
export function applyGlobalOffset(items: MappedTocItem[], offset: number): MappedTocItem[] {
  return items.map(it => {
    if (it.manualOverride) return it
    if (!isNumericLabel(it.pageLabel)) return it
    const printed = parseInt(it.pageLabel, 10)
    if (!Number.isFinite(printed)) return it
    const page = printed + offset
    return { ...it, startPage: page >= 1 ? page : null }
  })
}

/**
 * Choose a far verification anchor: among mapped items, pick the one whose physical
 * page is farthest from the calibration anchor's physical page (to double-check the
 * offset elsewhere in the book). Returns the item or null.
 */
export function pickVerificationAnchor(items: MappedTocItem[], anchorPhysicalPage: number): MappedTocItem | null {
  let best: MappedTocItem | null = null
  let bestDist = -1
  for (const it of items) {
    if (it.startPage == null || it.manualOverride) continue
    const d = Math.abs(it.startPage - anchorPhysicalPage)
    if (d > bestDist) { bestDist = d; best = it }
  }
  return best
}

/** Set a manual physical page override on an item (marks it manualOverride). */
export function setManualPageOverride(items: MappedTocItem[], index: number, page: number): MappedTocItem[] {
  return items.map((it, i) => (i === index ? { ...it, startPage: page, manualOverride: true } : it))
}

/**
 * Review-level validity (Stage 9.4B.1): a mapped review may be saved ONLY when every
 * row has a real physical page (unresolved is NEVER coerced to 1) AND the derived
 * chapter draft is a valid ChapterDraft. Returns the count of blocking problems.
 */
/** Aggregate review result from the SINGLE review-level domain validator (Stage 9.4C.1). */
export type TocReviewValidation = {
  ok: boolean
  /** Number of rows whose physical page is still unresolved (never coerced to 1). */
  unresolvedCount: number
  /** Row indices that must be fixed before the review may be saved (deduplicated). */
  blockingRowIndices: number[]
  /** Human-readable error text per problematic row (a row with many problems = 1 entry). */
  issuesByRow: Record<number, string[]>
  /** Total count of DISTINCT rows that need correction (not the issue count). */
  errorCount: number
}

/**
 * Review-level validity (Stage 9.4C.1 — SINGLE source of truth for save/build gating).
 * A mapped review may be saved ONLY when every row resolves to a real physical page
 * (unresolved is NEVER coerced to 1) AND the derived ChapterDraft is a valid
 * ChapterDraft. Returns per-row issues + the count of distinct blocking rows.
 */
export function validateMappedTocReview(items: MappedTocItem[], pageCount: number): TocReviewValidation {
  const blocking: number[] = []
  const issuesByRow: Record<number, string[]> = {}
  let unresolvedCount = 0
  items.forEach((it, i) => {
    if (it.startPage == null) { unresolvedCount++; blocking.push(i); (issuesByRow[i] = issuesByRow[i] || []).push('页码待确认'); return }
    if (!Number.isInteger(it.startPage) || it.startPage < 1 || it.startPage > pageCount) { blocking.push(i); (issuesByRow[i] = issuesByRow[i] || []).push('页码超出范围'); return }
    if (!Number.isInteger(it.level) || it.level < 1) { blocking.push(i); (issuesByRow[i] = issuesByRow[i] || []).push('层级非法'); return }
    if (typeof it.title !== 'string' || it.title.trim() === '') { blocking.push(i); (issuesByRow[i] = issuesByRow[i] || []).push('标题为空'); return }
  })
  // Derived draft-level validation (only rows with a valid integer page). Track the
  // draftIndex -> originalRowIndex mapping so ChapterDraft issues map back to the ORIGINAL row
  // (finding 9) — never reuse the filtered draft's index as the original row index.
  const draft: ChapterDraftItem[] = []
  const draftToRow: number[] = []
  items.forEach((it, i) => {
    if (it.startPage != null && Number.isInteger(it.startPage)) {
      draft.push({ id: 'ai' + i, title: it.title, level: it.level, startPage: it.startPage as number })
      draftToRow.push(i)
    }
  })
  const v = validateChapterDraft(draft, pageCount)
  for (const issue of v.issues) {
    if (issue.index < 0 || issue.index >= draftToRow.length) continue
    const orig = draftToRow[issue.index]
    if (!blocking.includes(orig)) {
      blocking.push(orig)
      issuesByRow[orig] = issuesByRow[orig] || []
      if (!issuesByRow[orig].includes(issue.message)) issuesByRow[orig].push(issue.message)
    }
  }
  const errorCount = blocking.length
  return {
    ok: errorCount === 0,
    unresolvedCount,
    blockingRowIndices: blocking,
    issuesByRow,
    errorCount,
  }
}