// PDF Outline parser (pure data layer, no UI, no storage, no AI).
// Reads pdfjs getOutline() tree, resolves each node's destination to a physical
// 1-based PDF page, builds a stable chapter tree with depth/path, and computes
// selectable start/end page ranges. One bad bookmark never derails the rest.
//
// Stage 3 scope: parser + tests only. NOT wired to PdfPanel/Conversation yet
// (Stage 4), and never mutates the document / IndexedDB / attachment-service.

export type PdfOutlinePath = number[]
export type PdfOutlineResolution = 'direct' | 'derived-from-child' | 'external' | 'unresolved'
export type PdfOutlineDiagnosticCode =
  | 'unresolved-destination'
  | 'invalid-page-ref'
  | 'page-out-of-range'
  | 'non-monotonic-outline'

export type PdfOutlineItem = {
  id: string
  title: string
  depth: number
  path: PdfOutlinePath
  children: PdfOutlineItem[]
  /** The page this bookmark's OWN destination points to, or null (never derived). */
  directStartPage: number | null
  /** The page range actually usable for chapter selection (may be derived). */
  startPage: number | null
  endPage: number | null
  selectable: boolean
  resolution: PdfOutlineResolution
}

export type PdfOutlineDiagnostic = {
  path: PdfOutlinePath
  title: string
  code: PdfOutlineDiagnosticCode
}

export type PdfOutlineResult = {
  /** Top-level outline items (the tree roots). */
  items: PdfOutlineItem[]
  diagnostics: PdfOutlineDiagnostic[]
}

export class PdfOutlineError extends Error {
  constructor(message: string) { super(message); this.name = 'PdfOutlineError' }
}

/** Minimal structural type so the parser is trivially mock-testable. PDFDocumentProxy
 * satisfies this interface structurally. */
export interface PdfOutlineDocument {
  numPages: number
  getOutline(): Promise<Array<Record<string, any>> | null>
  getDestination(name: string): Promise<Array<any> | null>
  getPageIndex(ref: any): Promise<number>
}

const VALID = /[^\s]/ // used to detect non-blank title below

/**
 * Resolve a destination's first element (a page ref) to a 1-based physical page.
 * @returns the 1-based page, or null when the ref is invalid/unresolvable. Never clamps.
 */
async function refToPage(
  doc: PdfOutlineDocument,
  ref: any,
  path: PdfOutlinePath,
  title: string,
  diagnostics: PdfOutlineDiagnostic[],
): Promise<number | null> {
  // Historic / edge PDFs may expose a bare integer as dest[0] (0-based page index).
  if (typeof ref === 'number') {
    if (Number.isInteger(ref) && ref >= 0 && ref < doc.numPages) return ref + 1
    diagnostics.push({ path, title, code: ref >= 0 ? 'page-out-of-range' : 'invalid-page-ref' })
    return null
  }
  // RefProxy { num, gen }
  if (ref && typeof ref === 'object' && Number.isFinite(ref.num) && Number.isFinite(ref.gen)) {
    try {
      const idx = await doc.getPageIndex(ref)
      if (Number.isInteger(idx) && idx >= 0 && idx < doc.numPages) return idx + 1
      diagnostics.push({ path, title, code: 'page-out-of-range' })
      return null
    } catch {
      diagnostics.push({ path, title, code: 'invalid-page-ref' })
      return null
    }
  }
  diagnostics.push({ path, title, code: 'invalid-page-ref' })
  return null
}

/** Resolve one node's own destination to a 1-based page (named or explicit), or null. */
async function resolveDirectPage(
  doc: PdfOutlineDocument,
  dest: string | any[] | null,
  path: PdfOutlinePath,
  title: string,
  diagnostics: PdfOutlineDiagnostic[],
): Promise<number | null> {
  if (dest == null) return null
  let explicit: Array<any> | null
  if (typeof dest === 'string') {
    try { explicit = await doc.getDestination(dest) } catch { explicit = null }
    if (explicit == null) {
      diagnostics.push({ path, title, code: 'unresolved-destination' })
      return null
    }
  } else if (Array.isArray(dest)) {
    explicit = dest
  } else {
    diagnostics.push({ path, title, code: 'unresolved-destination' })
    return null
  }
  if (!Array.isArray(explicit) || explicit.length < 1) {
    diagnostics.push({ path, title, code: 'unresolved-destination' })
    return null
  }
  return refToPage(doc, explicit[0], path, title, diagnostics)
}

async function buildNode(
  doc: PdfOutlineDocument,
  raw: Record<string, any>,
  path: PdfOutlinePath,
  depth: number,
  diagnostics: PdfOutlineDiagnostic[],
): Promise<PdfOutlineItem> {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const item: PdfOutlineItem = {
    id: path.join('.'),
    title,
    depth,
    path,
    children: [],
    directStartPage: null,
    startPage: null,
    endPage: null,
    selectable: false,
    resolution: 'unresolved',
  }
  const dest = (raw.dest ?? null) as string | any[] | null
  const url = raw.url ?? null

  if (dest == null && typeof url === 'string' && url.length > 0) {
    // External URL bookmark -> never a chapter, but its children still parse.
    item.resolution = 'external'
    item.selectable = false
  } else {
    const page = await resolveDirectPage(doc, dest, path, title, diagnostics)
    item.directStartPage = page
  }

  const rawChildren = Array.isArray(raw.items) ? raw.items : []
  for (let i = 0; i < rawChildren.length; i++) {
    const c = await buildNode(doc, rawChildren[i], [...path, i], depth + 1, diagnostics)
    item.children.push(c)
  }
  return item
}

/** Post-order pass: derive startPage from the first valid descendant for nodes that
 * have no direct page, and finalize resolution/selectable. */
function deriveStartPages(items: PdfOutlineItem[]): void {
  for (const item of items) {
    deriveStartPages(item.children)
    if (item.resolution === 'external') { item.startPage = null; item.selectable = false; continue }
    if (item.directStartPage != null) {
      item.startPage = item.directStartPage
      item.resolution = 'direct'
    } else {
      const first = item.children.find(c => c.startPage != null)
      if (first) {
        item.startPage = first.startPage
        item.resolution = 'derived-from-child'
      } else {
        item.startPage = null
        item.resolution = 'unresolved'
      }
    }
    item.selectable = item.startPage != null && VALID.test(item.title)
  }
}

function preorder(items: PdfOutlineItem[]): PdfOutlineItem[] {
  const out: PdfOutlineItem[] = []
  for (const it of items) { out.push(it); out.push(...preorder(it.children)) }
  return out
}

/** Preorder pass: compute each node's endPage from the next boundary at depth <= own. */
function computeRanges(items: PdfOutlineItem[], numPages: number, diagnostics: PdfOutlineDiagnostic[]): void {
  const flat = preorder(items)
  for (let i = 0; i < flat.length; i++) {
    const cur = flat[i]
    if (cur.startPage == null) { cur.endPage = null; continue }
    let boundary: number | null = null
    for (let j = i + 1; j < flat.length; j++) {
      const succ = flat[j]
      if (succ.depth <= cur.depth && succ.startPage != null) { boundary = succ.startPage; break }
    }
    if (boundary == null) {
      cur.endPage = numPages // last node -> to the document end
    } else if (boundary === cur.startPage) {
      cur.endPage = cur.startPage // same-page bookmarks must not produce empty ranges
    } else if (boundary > cur.startPage) {
      cur.endPage = boundary - 1
    } else {
      // non-monotonic outline: never emit a negative/inverted range.
      cur.endPage = cur.startPage
      diagnostics.push({ path: cur.path, title: cur.title, code: 'non-monotonic-outline' })
    }
  }
}

/**
 * Parse a PDF document's outline into a stable chapter tree with resolved page ranges.
 * @param doc - an open PDFDocumentProxy (structurally a PdfOutlineDocument).
 * @returns {PdfOutlineResult} with tree + diagnostics. Returns an empty result when the
 *   document has no outline (null / []). Throws PdfOutlineError only if getOutline()
 *   itself rejects — the caller may then fall back to manual page selection.
 */
export async function parsePdfOutline(doc: PdfOutlineDocument): Promise<PdfOutlineResult> {
  const diagnostics: PdfOutlineDiagnostic[] = []
  let raw: Array<Record<string, any>> | null
  try {
    raw = await doc.getOutline()
  } catch (e) {
    throw new PdfOutlineError('无法读取该书签（Outlines 解析失败）。' + ((e as any)?.message ? ' ' + (e as any).message : ''))
  }
  if (!raw || raw.length === 0) return { items: [], diagnostics: [] }
  const items: PdfOutlineItem[] = []
  for (let i = 0; i < raw.length; i++) items.push(await buildNode(doc, raw[i], [i], 0, diagnostics))
  deriveStartPages(items)
  computeRanges(items, doc.numPages, diagnostics)
  return { items, diagnostics }
}
