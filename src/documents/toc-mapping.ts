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

// ---- page-label canonicalization (v1.1.3) ------------------------------------
// The AI faithfully transcribes the PRINTED label, which may carry typographic
// decoration (e.g. "/1", "／24", "……24", "— 15"). We NEVER rewrite the raw
// pageLabel stored on the item (that faithful transcription is what the UI shows).
// Canonicalization exists only so a decorated label can be read as the single
// Arabic integer it denotes, for (a) matching against PDF PageLabels and (b) numeric
// offset calibration. It is deliberately conservative: an unambiguous single-integer
// reading is required. Anything mixing letters / CJK / ranges / decimals / several
// digit runs returns null. It never "does OCR" — "O1", "I", "l1" all return null.

/** Decorative punctuation/space that may surround a printed page number. Never digits,
 *  letters, or CJK ideographs (those leave the label ambiguous and must be rejected). */
const NUMERIC_DECORATION = /^[\s\u00A0\u3000\u2028\u2029\uFEFF/\\\uFF0F\u00B7\u2022\u2026\u22EF\.\uFF0E,\uFF0C\u3001\u3002;\uFF1B:\uFF1A_\-\u2013\u2014'"“”()\[\]\uFF08\uFF09\u300C\u300D\u300E\u300F]*$/

function isPureDecoration(s: string): boolean { return NUMERIC_DECORATION.test(s) }

/**
 * Interpret 'raw' as a single Arabic integer page number and return its canonical
 * decimal string (leading zeros are not ambiguous, so they are stripped).
 * Returns null when the label is NOT a safe, unambiguous single-integer reading.
 *
 *   "1", " 1 ", "/1", "／1", "1/", "·1", "1·", "……24", "24……", "···31", "— 15" -> digits
 *   "A-1", "S1", "1-2", "1.2", "3a", "iii", "IV", "附1", "O1", "I"              -> null
 */
export function canonicalizeNumericPageLabel(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s === '') return null
  // No digit at all -> not a number (roman numerals, letters, symbols).
  if (!/[0-9]/.test(s)) return null
  // Locate the FIRST contiguous ASCII-digit run.
  let start = -1
  for (let i = 0; i < s.length; i++) { if (s[i] >= '0' && s[i] <= '9') { start = i; break } }
  if (start < 0) return null
  let end = start
  while (end < s.length && s[end] >= '0' && s[end] <= '9') end++
  const core = s.slice(start, end)
  // A digit OUTSIDE this single run means the label is compound (a range "1-2",
  // a decimal "1.2", or a multi-part "3.5/7") -> ambiguous -> reject.
  const outside = s.slice(0, start) + s.slice(end)
  if (/[0-9]/.test(outside)) return null
  // Everything to the left and right of the digits must be pure decoration.
  if (!isPureDecoration(s.slice(0, start))) return null
  if (!isPureDecoration(s.slice(end))) return null
  // Normalize to the integer value (strips leading zeros; "007" -> "7").
  const n = Number(core)
  if (!Number.isSafeInteger(n)) return null
  return String(n)
}

/** Numeric value of a canonicalizable page label, or null when it is not one. */
export function canonicalNumericPageNumber(raw: string): number | null {
  const c = canonicalizeNumericPageLabel(raw)
  if (c == null) return null
  const n = Number(c)
  return Number.isFinite(n) ? n : null
}

/** Exact label -> physical page (1-based PDF index). Returns 0 if not found. */
export function exactLabelToPage(labels: string[] | null | undefined, pageLabel: string): number {
  if (!labels) return 0
  const target = String(pageLabel).trim()
  // Priority 1: the RAW label trims to a PDF label (e.g. the PDF label is itself "/1").
  for (let i = 0; i < labels.length; i++) if (String(labels[i]).trim() === target) return i + 1
  // Priority 2: BOTH sides canonicalize to the SAME single integer (e.g. AI "/24" vs PDF "24").
  // Only performed when BOTH sides are safe numeric labels — never a fuzzy match.
  const targetCanon = canonicalizeNumericPageLabel(target)
  if (targetCanon != null) {
    for (let i = 0; i < labels.length; i++) {
      const labCanon = canonicalizeNumericPageLabel(String(labels[i]).trim())
      if (labCanon != null && labCanon === targetCanon) return i + 1
    }
  }
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

/** Is a page label a single safe Arabic integer (after canonicalization)? */
export function isNumericLabel(label: string): boolean { return canonicalizeNumericPageLabel(label) != null }

/** Whether numeric offset / anchor calibration is available for these items: at least
 *  one item's printed page label can be canonically read as an integer. This is a
 *  CALIBRATION capability and is deliberately independent of whether the PDF provides
 *  native PageLabels (that is the separate AUTO-MAPPING capability). */
export function canUseNumericOffset(items: Pick<MappedTocItem, 'pageLabel'>[]): boolean {
  return items.some(it => canonicalizeNumericPageLabel(it.pageLabel) != null)
}

// ---- page-label families (v1.1.3) -----------------------------------------
// A printed page label falls into exactly one family. Only the ARABIC-NUMERIC family
// is ever offset-calibrated. The ROMAN family is recognised (so exact PDF PageLabels can
// still match and so future work could add a Roman family calibration seam), but it is
// NOT auto-remapped by a numeric offset — that would risk mapping the whole book wrong.
// The OTHER family (S12 / A-3 / 1-2 / 附录1) is NEVER numericized: exact PDF PageLabel first,
// otherwise unresolved (the user confirms it). No fuzzy inference on any family.

export type PageLabelFamily = 'numeric' | 'roman' | 'other'

const ROMAN = /^[IVXLCDM]+$/i

/** Strict Roman numeral parser (case-insensitive). Returns the integer or null for any
 *  non-Roman / out-of-range / non-canonical input (e.g. "IIII", "VX", "O", "iv1" -> null). */
export function romanNumeralValue(raw: string): number | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toUpperCase()
  if (s === '' || !ROMAN.test(s)) return null
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  let total = 0
  let prev = 0
  for (let i = s.length - 1; i >= 0; i--) {
    const v = map[s[i]]
    if (v < prev) total -= v
    else { total += v; prev = v }
  }
  if (total < 1 || total > 3999) return null
  if (encodeRoman(total) !== s) return null
  return total
}

/** Encode 1..3999 as a canonical (subtractive) Roman numeral — used for strict validation. */
function encodeRoman(n: number): string {
  const syms: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let out = ''
  let x = n
  for (const [v, s] of syms) { while (x >= v) { out += s; x -= v } }
  return out
}

/** Classify a printed label into its family. Safe, deterministic, no OCR. */
export function pageLabelFamily(raw: string): PageLabelFamily {
  if (canonicalizeNumericPageLabel(raw) != null) return 'numeric'
  if (romanNumeralValue(raw) != null) return 'roman'
  return 'other'
}

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
 * a safe single Arabic integer (after canonicalization) and which are currently
 * unresolved or offset-derived. The raw pageLabel is NEVER rewritten; a decorated
 * label such as "/24" is canonicalized purely for the arithmetic.
 */
export function applyGlobalOffset(items: MappedTocItem[], offset: number): MappedTocItem[] {
  return items.map(it => {
    if (it.manualOverride) return it
    const printed = canonicalNumericPageNumber(it.pageLabel)
    if (printed == null) return it
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