// TOC page mapping domain (Stage 9.4B). PURE — maps the model's printed pageLabel
// to a PDF physical page. PDF.js page labels (getPageLabels) are preferred; when the
// PDF has none we fall back to a human-calibrated numeric offset. Never fabricates
// a page: an unmappable label stays unresolved (kept in the review list) until the
// user confirms it. Individual manual overrides survive a global remap.
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
