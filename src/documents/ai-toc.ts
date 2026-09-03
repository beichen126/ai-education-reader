// AI TOC domain (Stage 9.4B). PURE — no React / network / IndexedDB. Owns the
// parse -> schema-validate -> normalize -> chunk-merge pipeline for the model's
// UNTRUSTED structured output. AI is never the persistence authority: this module
// only produces a draft that a human reviews before saving.
export type AiTocEntry = { title: string; level: number; pageLabel: string; tocPage: number }

/** Per-chunk prompt constant: how many TOC page IMAGES per vision request. */
export const TOC_VISION_PAGES_PER_CHUNK = 4

export type AiTocParseResult =
  | { ok: true; entries: AiTocEntry[] }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Normalize a raw title string: trim runs of whitespace to single spaces. */
export function normalizeTitle(raw: string): string {
  return String(raw).replace(/[\s\u3000]+/g, ' ').trim()
}

/** Normalize a page label to a string (must be string; numbers accepted as stringified). */
export function normalizePageLabel(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t }
  return null
}

/** Validate one AiTocEntry shape; returns the normalized entry or a reason. */
function validateEntry(raw: unknown): { entry: AiTocEntry } | { error: string } {
  if (!isRecord(raw)) return { error: '目录条目必须是对象' }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return { error: '目录条目缺少有效标题' }
  const title = normalizeTitle(raw.title)
  if (title === '') return { error: '目录条目标题为空' }
  if (!Number.isInteger(raw.level) || (raw.level as number) < 1) return { error: '目录条目层级必须是 >=1 的整数' }
  const pageLabel = normalizePageLabel(raw.pageLabel)
  if (pageLabel === null) return { error: '目录条目缺少页码标签' }
  if (!Number.isInteger(raw.tocPage) || (raw.tocPage as number) < 1) return { error: '目录条目 tocPage 必须是 >=1 的整数' }
  return { entry: { title, level: raw.level as number, pageLabel, tocPage: raw.tocPage as number } }
}

/**
 * Parse a model response into validated AiTocEntry[]. Only strict JSON is accepted;
 * a markdown fence or any prose/non-array top-level is rejected (the prompt forbids
 * fences, and we never silently scrape). Never writes any Document.
 */
export function parseAiToc(rawText: string): AiTocParseResult {
  // Strip legacy markdown fences defensively for robustness, but only if the whole
  // trimmed body is a fenced block (never scrape a fenced block out of prose).
  let body = rawText.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: '目录识别结果格式异常，请重试。' }
  }
  if (!Array.isArray(json)) return { ok: false, error: '目录识别结果格式异常，请重试。' }
  const entries: AiTocEntry[] = []
  for (const item of json) {
    const r = validateEntry(item)
    if ('error' in r) return { ok: false, error: r.error }
    entries.push(r.entry)
  }
  return { ok: true, entries }
}

/** Normalized identity used only for EXACT duplicate detection (title+pageLabel+level). */
function dedupeKey(e: AiTocEntry): string {
  return e.title + '|' + e.pageLabel + '|' + e.level
}

/**
 * Deterministically merge multiple chunk outputs, keeping chunk/page/order. Only
 * drops an entry that is an EXACT adjacent duplicate (same normalized title +
 * pageLabel + level). Never does semantic/fuzzy merge — better one extra row in the
 * Builder than auto-deleting a correct chapter. chunks are applied in order.
 */
export function mergeAiTocChunks(chunks: AiTocEntry[][]): AiTocEntry[] {
  const out: AiTocEntry[] = []
  for (const chunk of chunks) {
    for (const e of chunk) {
      const last = out[out.length - 1]
      if (last && dedupeKey(last) === dedupeKey(e)) continue
      out.push(e)
    }
  }
  return out
}

/**
 * Split a list of selected TOC physical pages into sequential chunks of at most
 * TOC_VISION_PAGES_PER_CHUNK pages for the vision requests.
 */
export function chunkTocPages(pages: number[], perChunk: number = TOC_VISION_PAGES_PER_CHUNK): number[][] {
  const out: number[][] = []
  for (let i = 0; i < pages.length; i += perChunk) out.push(pages.slice(i, i + perChunk))
  return out
}
// ===================== Flat transcription architecture (Stage 9.4C) =====================
// Vision transcription outputs FLAT rows (no final level). A separate GLOBAL structure
// pass assigns levels across the whole row set. Community test intent: transcription
// batches are NOT tree batches; only the global pass proposes level.

/** One flat, faithful (verbatim) transcription row. NO final level — the model only
 *  records what is printed. */
export type TocTranscriptionRow = {
  id: string
  title: string
  pageLabel: string
  tocPage: number
  /** Absolute reading order (0-based) across the merged set. */
  rowOrder: number
  /** Observed visual indentation (0..N), optional. */
  visualIndent?: number
  /** Raw numbering prefix as printed (e.g. 第一编 / 第一章 / 一、 / （一） / 1.), optional. */
  numbering?: string
}

export type TocTranscriptionLine = {
  title: string
  pageLabel: string
  tocPage: number
  visualIndent?: number
  numbering?: string
}

export type TocJsonlParseResult =
  | { ok: true; rows: TocTranscriptionLine[] }
  | { ok: false; line: number; diagnostics: string[] }

const isRecord2 = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Parse a TOC-page transcription response as JSON Lines. Blank lines are allowed; a
 *  whole response wrapped in a single ```jsonl fence is accepted; every malformed line
 *  produces a precise diagnostic (never silently dropped). No "scraping" from prose. */
export function parseTocJsonl(text: string): TocJsonlParseResult {
  let body = text.trim()
  const fence = /^\`\`\`(?:jsonl)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(body)
  if (fence) body = fence[1].trim()
  if (body === '') return { ok: false, line: 0, diagnostics: ['空响应'] }
  const lines = body.split(/\r?\n/)
  const rows: TocTranscriptionLine[] = []
  const diagnostics: string[] = []
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx].trim()
    if (raw === '') continue // blank line allowed
    let json: unknown
    try { json = JSON.parse(raw) } catch { diagnostics.push('第 ' + (idx + 1) + ' 行不是合法 JSON'); continue }
    if (!isRecord2(json)) { diagnostics.push('第 ' + (idx + 1) + ' 行不是对象'); continue }
    if (typeof json.title !== 'string' || json.title.trim() === '') { diagnostics.push('第 ' + (idx + 1) + ' 行缺少有效 title'); continue }
    let pl = ''
    if (typeof json.pageLabel === 'string') pl = json.pageLabel.trim()
    else if (typeof json.pageLabel === 'number' && Number.isFinite(json.pageLabel)) pl = String(json.pageLabel)
    if (pl === '') { diagnostics.push('第 ' + (idx + 1) + ' 行缺少 pageLabel'); continue }
    const tocPage = Number.isInteger(json.tocPage) && (json.tocPage as number) >= 1 ? (json.tocPage as number) : 1
    rows.push({
      title: normalizeTitle(json.title),
      pageLabel: pl,
      tocPage,
      ...(typeof json.visualIndent === 'number' && json.visualIndent >= 0 ? { visualIndent: json.visualIndent } : {}),
      ...(typeof json.numbering === 'string' ? { numbering: json.numbering } : {}),
    })
  }
  if (rows.length === 0) return { ok: false, line: 0, diagnostics }
  return { ok: true, rows }
}

/** Assign stable LOCAL ids (r0001…) in row order; never trusts model ids. */
export function assignLocalRowIds(rows: TocTranscriptionLine[]): TocTranscriptionRow[] {
  return rows.map((r, i) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }))
}

export type TocStructureProposal = { id: string; level: number }

export type TocStructureParseResult =
  | { ok: true; proposals: TocStructureProposal[] }
  | { ok: false; line: number; diagnostics: string[] }

/** Parse the GLOBAL structure pass output (JSONL of {id, level}). */
export function parseTocStructure(text: string): TocStructureParseResult {
  let body = text.trim()
  const fence = /^\`\`\`(?:jsonl)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(body)
  if (fence) body = fence[1].trim()
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  const proposals: TocStructureProposal[] = []
  const diags: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let json: unknown
    try { json = JSON.parse(lines[i]) } catch { diags.push('第 ' + (i + 1) + ' 行非 JSON'); continue }
    if (!isRecord2(json) || typeof json.id !== 'string' || !Number.isInteger(json.level) || (json.level as number) < 1) { diags.push('第 ' + (i + 1) + ' 行缺少合法 id/level'); continue }
    proposals.push({ id: json.id, level: json.level as number })
  }
  if (proposals.length === 0) return { ok: false, line: 0, diagnostics: diags }
  return { ok: true, proposals }
}

/**
 * Deterministic level normalization: shift the observed minimum/root level to 1 while
 * preserving relative depth. Only a pure shift — never re-orders or re-semantics.
 */
export function normalizeTocLevels(levels: number[]): number[] {
  const min = Math.min(...levels)
  return levels.map(l => l - min + 1)
}

export type TocStructureValidation = {
  ok: boolean
  issues: string[]
  /** Proposed levels normalized to start at 1, in row order. */
  levels: number[]
}

/**
 * Validate a global structure pass against the transcription rows: every input id
 * appears exactly once, no unknown/duplicate id, level integer >=1, the FIRST row's
 * normalized level = 1, and no level transition jumps a parent. Returns the normalized
 * levels aligned to rows, or issues. Never partially persists.
 */
export function validateTocStructure(rows: TocTranscriptionRow[], proposals: TocStructureProposal[]): TocStructureValidation {
  const issues: string[] = []
  const byId = new Map(proposals.map(p => [p.id, p.level]))
  if (byId.size !== proposals.length) issues.push('重复 id')
  for (const r of rows) {
    if (!byId.has(r.id)) { issues.push('缺少 id ' + r.id); continue }
    const lvl = byId.get(r.id) as number
    if (!Number.isInteger(lvl) || lvl < 1) issues.push('非法 level for ' + r.id)
  }
  for (const p of proposals) { if (!rows.some(r => r.id === p.id)) issues.push('未知 id ' + p.id) }
  const orderedLevels = rows.map(r => byId.get(r.id))
  if (orderedLevels.some(l => l === undefined)) {
    // some rows missing a proposal: report but attempt no levels
    return { ok: false, issues: issues.length ? issues : ['结构不完整'], levels: [] }
  }
  const levels = normalizeTocLevels(orderedLevels as number[])
  if (levels[0] !== 1) issues.push('首项归一化后不是层级 1')
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) { issues.push('第 ' + (i + 1) + ' 项层级跳变'); break }
  }
  return { ok: issues.length === 0, issues, levels }
}

