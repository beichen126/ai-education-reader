// AI TOC domain (Stage 9.4C.1). PURE — no React / network / IndexedDB. Owns the
// canonical pipeline for the model's UNTRUSTED structured output:
//
//   flat transcription (JSONL, NO levels) -> local ids -> GLOBAL structure pass
//   -> mapped draft (human review) -> user save.
//
// PROVENANCE RULES (P0):
//   - The vision model returns ONLY what is printed: title + pageLabel +
//     sourceImageIndex (which image in the current request the row came from).
//     The physical PDF page (tocPage) is ALWAYS derived locally from the page
//     batch by the app — it is NEVER taken from the model.
//   - Transcription and structure are STRICT JSONL: any malformed non-blank line
//     makes the whole result invalid (no partial rows, no silent data loss).
//   - AI is never the persistence authority: this module only produces a draft
//     that a human reviews before saving.
import { newStableId } from '../engine/types'

/** One flat, faithful (verbatim) transcription row as OUTPUT by the vision model.
 *  NO final level. sourceImageIndex is 1-based within the current image request;
 *  it is the ONLY model-supplied locator. The app maps it to a physical page. */
export type TocTranscriptionLine = {
  title: string
  pageLabel: string
  /** 1-based index into the current request's image batch (NOT a PDF page). */
  sourceImageIndex: number
  /** Observed visual indentation (0..N), optional. */
  visualIndent?: number
  /** Raw numbering prefix as printed (e.g. 第一编 / 第一章 / 一、 / （一） / 1.), optional. */
  numbering?: string
}

/** A transcription row with local id + order but BEFORE the physical page is resolved. */
export type TocLocalRow = TocTranscriptionLine & { id: string; rowOrder: number }

/** A transcription row AFTER the app has resolved the physical PDF page locally. */
export type TocTranscriptionRow = {
  id: string
  title: string
  pageLabel: string
  /** Physical PDF page (local provenance — never from the model). */
  tocPage: number
  sourceImageIndex: number
  /** Absolute reading order (0-based) across the merged set. */
  rowOrder: number
  visualIndent?: number
  numbering?: string
}

export type TocJsonlParseResult =
  | { ok: true; rows: TocTranscriptionLine[] }
  | { ok: false; line: number; diagnostics: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Normalize a raw title string: trim runs of whitespace to single spaces. */
export function normalizeTitle(raw: string): string {
  return String(raw).replace(/[\s\u3000]+/g, ' ').trim()
}

function normalizePageLabel(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t }
  return null
}

/**
 * STRICT JSONL transcription parse. Blank lines are allowed; a whole response
 * wrapped in a single ```jsonl fence is accepted; EVERY malformed non-blank line
 * produces a precise diagnostic and the WHOLE result is invalid (never silently
 * drops a row). sourceImageIndex is REQUIRED: missing/non-integer/<1 => invalid.
 * No "scraping" from prose. Never partially persists.
 */
export function parseTocJsonl(text: string): TocJsonlParseResult {
  let body = String(text ?? '').trim()
  const fence = /^```(?:jsonl)?\s*([\s\S]*?)\s*```$/i.exec(body)
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
    if (!isRecord(json)) { diagnostics.push('第 ' + (idx + 1) + ' 行不是对象'); continue }
    if (typeof json.title !== 'string' || json.title.trim() === '') { diagnostics.push('第 ' + (idx + 1) + ' 行缺少有效 title'); continue }
    const pl = normalizePageLabel(json.pageLabel)
    if (pl === null) { diagnostics.push('第 ' + (idx + 1) + ' 行缺少 pageLabel'); continue }
    const sii = json.sourceImageIndex
    if (!Number.isInteger(sii) || (sii as number) < 1) { diagnostics.push('第 ' + (idx + 1) + ' 行缺少合法的 sourceImageIndex'); continue }
    rows.push({
      title: normalizeTitle(json.title),
      pageLabel: pl,
      sourceImageIndex: sii as number,
      ...(typeof json.visualIndent === 'number' && json.visualIndent >= 0 ? { visualIndent: json.visualIndent } : {}),
      ...(typeof json.numbering === 'string' ? { numbering: json.numbering } : {}),
    })
  }
  if (diagnostics.length > 0) return { ok: false, line: 0, diagnostics }
  if (rows.length === 0) return { ok: false, line: 0, diagnostics: ['未识别到目录条目'] }
  return { ok: true, rows }
}

/** Assign stable LOCAL ids (r0001…) in row order; never trusts model ids. The physical
 *  page (tocPage) is NOT assigned here — it is resolved later from the page batch. */
export function assignLocalRowIds(rows: TocTranscriptionLine[]): TocLocalRow[] {
  return rows.map((r, i) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }))
}

export type TocPageMapFailure =
  | { ok: true; rows: TocTranscriptionRow[] }
  | { ok: false; line: number; diagnostics: string[] }

/**
 * LOCAL provenance: map each transcription row's sourceImageIndex to a physical
 * PDF page using the request's page batch (1-based index into `pageBatch`).
 * A sourceImageIndex outside [1, pageBatch.length] invalidates the WHOLE batch —
 * the app NEVER guesses/coerces a page. Returns NEW rows with tocPage resolved.
 */
export function mapTocSourcePages(rows: TocLocalRow[], pageBatch: number[]): TocPageMapFailure {
  const diagnostics: string[] = []
  const out: TocTranscriptionRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const idx = r.sourceImageIndex
    if (!Number.isInteger(idx) || idx < 1 || idx > pageBatch.length) {
      diagnostics.push('第 ' + (i + 1) + ' 行 sourceImageIndex 超出当前请求图片范围');
      continue
    }
    const page = pageBatch[idx - 1]
    if (!Number.isInteger(page) || page < 1) {
      diagnostics.push('第 ' + (i + 1) + ' 行映射到非法物理页');
      continue
    }
    out.push({ ...r, tocPage: page })
  }
  if (diagnostics.length > 0) return { ok: false, line: 0, diagnostics }
  return { ok: true, rows: out }
}

export type TocStructureProposal = { id: string; level: number }

export type TocStructureParseResult =
  | { ok: true; proposals: TocStructureProposal[] }
  | { ok: false; line: number; diagnostics: string[] }

/** STRICT parse of the GLOBAL structure pass output (JSONL of {id, level}).
 *  Any malformed non-blank line invalidates the whole result (no partial). */
export function parseTocStructure(text: string): TocStructureParseResult {
  let body = String(text ?? '').trim()
  const fence = /^```(?:jsonl)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  if (body === '') return { ok: false, line: 0, diagnostics: ['空响应'] }
  const lines = body.split(/\r?\n/)
  const proposals: TocStructureProposal[] = []
  const diags: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (raw === '') continue
    let json: unknown
    try { json = JSON.parse(raw) } catch { diags.push('第 ' + (i + 1) + ' 行非 JSON'); continue }
    if (!isRecord(json) || typeof json.id !== 'string' || json.id === '' || !Number.isInteger(json.level) || (json.level as number) < 1) {
      diags.push('第 ' + (i + 1) + ' 行缺少合法 id/level'); continue
    }
    proposals.push({ id: json.id, level: json.level as number })
  }
  if (diags.length > 0) return { ok: false, line: 0, diagnostics: diags }
  if (proposals.length === 0) return { ok: false, line: 0, diagnostics: ['结构分析无输出'] }
  return { ok: true, proposals }
}

/** Deterministic level normalization: shift the observed minimum/root level to 1
 *  while preserving relative depth. Only a pure shift — never re-orders or
 *  re-semantics. Runs AFTER id-integrity validation. */
export function normalizeTocLevels(levels: number[]): number[] {
  if (levels.length === 0) return []
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
 * Validate a global structure pass against the transcription rows:
 *   - every input id appears EXACTLY once (no missing / unknown / duplicate),
 *   - level integer >= 1,
 *   - after pure min->1 normalization, the first row = 1,
 *   - no level transition jumps a parent (next <= prev + 1).
 * Returns normalized levels aligned to rows, or issues. Never partially persists.
 */
export function validateTocStructure(rows: TocTranscriptionRow[], proposals: TocStructureProposal[]): TocStructureValidation {
  const issues: string[] = []
  const byId = new Map<string, number>()
  for (const p of proposals) {
    if (byId.has(p.id)) { issues.push('重复 id ' + p.id) } else { byId.set(p.id, p.level) }
  }
  for (const r of rows) {
    if (!byId.has(r.id)) { issues.push('缺少 id ' + r.id); continue }
    const lvl = byId.get(r.id) as number
    if (!Number.isInteger(lvl) || lvl < 1) issues.push('非法 level for ' + r.id)
  }
  for (const p of proposals) { if (!rows.some(r => r.id === p.id)) issues.push('未知 id ' + p.id) }
  if (issues.length > 0) return { ok: false, issues, levels: [] }
  const orderedLevels = rows.map(r => byId.get(r.id) as number)
  const levels = normalizeTocLevels(orderedLevels)
  if (levels[0] !== 1) issues.push('首项归一化后不是层级 1')
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) { issues.push('第 ' + (i + 1) + ' 项层级跳变'); break }
  }
  return { ok: issues.length === 0, issues, levels }
}

/** Normalized identity used ONLY for EXACT boundary-duplicate detection
 *  (same normalized title + same pageLabel + same physical tocPage). */
function boundaryDedupeKey(r: { title: string; pageLabel: string; tocPage: number }): string {
  return r.title + '|' + r.pageLabel + '|' + r.tocPage
}

/**
 * Strict adjacent-window boundary dedupe (Stage 9.4C.1). Only removes a row that
 * is an EXACT duplicate (same normalized title + pageLabel + physical tocPage) of
 * the immediately preceding row AND sits at a window boundary. NEVER fuzzy-merges
 * (第一章 研究对象 vs 第一章 研究方法 must never merge). Pure.
 */
export function dedupeBoundaryRows(rows: TocTranscriptionRow[]): TocTranscriptionRow[] {
  const out: TocTranscriptionRow[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && boundaryDedupeKey(last) === boundaryDedupeKey(r)) continue
    out.push(r)
  }
  return out
}

/** Deduplicate consecutive copy runs, then RE-INDEX to a stable contiguous r0001….
 *  Order preserved, ids re-based (local provenance — structure only references ids). */
export function reindexRows(rows: TocTranscriptionRow[]): TocTranscriptionRow[] {
  const deduped = dedupeBoundaryRows(rows)
  return deduped.map((r, i) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }))
}

export { newStableId }

// ---- production prompt constants (Stage 9.4C.1) ----
// Kept in the PURE domain module so a node regression test can assert the exact
// production prompt contract without pulling the PDF renderer / Vite ?url assets.
export const TOC_TRANSCRIPTION_SYSTEM_PROMPT =
  '你是 PDF 目录页的视觉转录助手。你只负责忠实抄录目录中印刷的章节行。\n' +
  '你绝不能：构建层级结构、判断整本最终层级、输出子节点、输出数组格式、添加不存在的章节、概括或改写标题。\n' +
  '输出必须是 JSONL（每行一个 JSON 对象，一行 = 一条目录行）。\n' +
  '每条只包含：title（原样完整标题）、pageLabel（印刷页码原样字符串）、sourceImageIndex（本条来自当前请求的第几张图片，从 1 开始）、visualIndent（看到的缩进层级，可选）、numbering（原样编号前缀如 第一章/一、/（一）/1.，可选）。\n' +
  '示例（仅一条）：{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n' +
  '请按阅读顺序逐条抄录，不遗漏、不概括、不编造、不改写标题。若输入提示中有“上一批最后几条目录转录…”，请只转录当前图片中新出现的目录行，不要重复输出以上内容。只输出 JSONL，不要任何解释。'

export const TOC_STRUCTURE_PROMPT =
  '你是 PDF 目录结构分析助手。输入是逐行目录转录（含阅读顺序、缩进、编号），仅文本。\n' +
  '你只负责整体判断每条目录的绝对层级。输出必须是 JSONL：每一行{"id":"行id","level":绝对层级数字}。\n' +
  '你不可以返回或修改 title、pageLabel、tocPage、rowOrder、numbering、visualIndent 等任何其他字段；即使模型输出额外字段也会被忽略，绝不能用它们覆盖转录来源数据。\n' +
  '你必须为输入中每个 id 恰好输出一行 level，按输入顺序，缺少、重复、未知 id 都算失败。只输出 JSONL，不要解释。'