// AI TOC domain (Stage 9.4C.1). PURE — no React / network / IndexedDB. Owns the
// canonical pipeline for the model's UNTRUSTED structured output:
//
//   flat transcription (JSONL, NO levels) -> local row order -> compact GLOBAL structure pass
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

/** Stable, non-sensitive reason codes for an untrusted structure response. These
 * are intentionally separate from the Chinese message: code drives retry/UI
 * behaviour while message is only useful for local development diagnostics. */
export type TocStructureDiagnosticCode =
  | 'EMPTY_OUTPUT'
  | 'MALFORMED_OUTPUT'
  | 'LEVEL_COUNT_MISMATCH'
  | 'INVALID_LEVEL'
  | 'LEVEL_JUMP'
  | 'API_ERROR'
  | 'ABORTED'

export type TocStructureDiagnostic = {
  code: TocStructureDiagnosticCode
  message: string
  line?: number
  rowIndex?: number
  expectedRows?: number
  actualLevels?: number
}

export type TocStructureParseResult =
  | { ok: true; levels: number[] }
  | { ok: false; line: number; diagnostics: TocStructureDiagnostic[] }

/** STRICT parse of the compact GLOBAL structure pass output ({levels:[...]}).
 *  Row identity is local input order, so the model never copies ids. */
export function parseTocStructure(text: string): TocStructureParseResult {
  let body = String(text ?? '').trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  if (body === '') return { ok: false, line: 0, diagnostics: [{ code: 'EMPTY_OUTPUT', message: '结构分析无输出' }] }
  let json: unknown
  try { json = JSON.parse(body) } catch {
    return { ok: false, line: 0, diagnostics: [{ code: 'MALFORMED_OUTPUT', message: '结构分析结果不是合法 JSON' }] }
  }
  if (!isRecord(json) || !Array.isArray(json.levels)) {
    return { ok: false, line: 0, diagnostics: [{ code: 'MALFORMED_OUTPUT', message: '结构分析结果必须是 {levels:[...]} 对象' }] }
  }
  const diagnostics: TocStructureDiagnostic[] = []
  const levels: number[] = []
  for (let i = 0; i < json.levels.length; i++) {
    const level = json.levels[i]
    if (!Number.isInteger(level) || (level as number) < 1) {
      diagnostics.push({ code: 'INVALID_LEVEL', message: '第 ' + (i + 1) + ' 项 level 必须是正整数', rowIndex: i })
    } else {
      levels.push(level as number)
    }
  }
  if (diagnostics.length > 0) return { ok: false, line: 0, diagnostics }
  return { ok: true, levels }
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
  diagnostics: TocStructureDiagnostic[]
  /** Proposed levels normalized to start at 1, in row order. */
  levels: number[]
}

/**
 * Validate a compact global structure pass against transcription row order:
 *   - exactly one level is returned for each input row,
 *   - every level is an integer >= 1,
 *   - normalize the minimum observed level to 1 without requiring the selected
 *     slice's first row to be a global root,
 *   - no level transition jumps a parent (next <= prev + 1).
 * Returns normalized levels aligned to rows, or issues. Never partially persists.
 */
export function validateTocStructure(rows: TocTranscriptionRow[], proposedLevels: number[]): TocStructureValidation {
  const diagnostics: TocStructureDiagnostic[] = []
  if (proposedLevels.length !== rows.length) {
    diagnostics.push({
      code: 'LEVEL_COUNT_MISMATCH',
      message: '目录条目数 ' + rows.length + '，实际层级数 ' + proposedLevels.length,
      expectedRows: rows.length,
      actualLevels: proposedLevels.length,
    })
  }
  for (let i = 0; i < proposedLevels.length; i++) {
    const level = proposedLevels[i]
    if (!Number.isInteger(level) || level < 1) diagnostics.push({ code: 'INVALID_LEVEL', message: '第 ' + (i + 1) + ' 项 level 必须是正整数', rowIndex: i })
  }
  if (diagnostics.length > 0) return { ok: false, issues: diagnostics.map(d => d.message), diagnostics, levels: [] }
  const levels = normalizeTocLevels(proposedLevels)
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) { diagnostics.push({ code: 'LEVEL_JUMP', message: '第 ' + (i + 1) + ' 项层级跳变', rowIndex: i }); break }
  }
  return { ok: diagnostics.length === 0, issues: diagnostics.map(d => d.message), diagnostics, levels }
}

/** Convert structured diagnostics into a concise, actionable user message. Never
 * include raw API responses, prompts, PDF text, or secret-bearing error details. */
export function describeTocStructureFailure(diagnostics: TocStructureDiagnostic[]): string {
  const codes = new Set(diagnostics.map(d => d.code))
  if (codes.has('ABORTED')) return '已取消目录识别。'
  if (codes.has('API_ERROR')) return '目录结构分析失败：AI 服务请求失败。你可以重新识别或进入手动编辑。'
  if (codes.has('EMPTY_OUTPUT')) return '目录结构分析失败：AI 未返回目录层级。你可以重新识别或进入手动编辑。'
  if (codes.has('MALFORMED_OUTPUT')) return '目录结构分析失败：AI 返回的结构格式不正确。你可以重新识别或进入手动编辑。'
  if (codes.has('LEVEL_COUNT_MISMATCH')) return '目录结构分析失败：AI 返回的层级数量与目录条目不一致。你可以重新识别或进入手动编辑。'
  if (codes.has('INVALID_LEVEL') || codes.has('LEVEL_JUMP')) return '目录结构分析失败：AI 返回的目录层级无效。你可以重新识别或进入手动编辑。'
  return '目录结构分析失败，请重试或进入手动编辑。'
}

/** Build the single repair instruction used after the first structure pass
 * fails local validation. Only stable local diagnostics are included; the raw
 * model response and PDF text never enter the retry prompt. */
export function buildTocStructureRepairPrompt(rowsCount: number, diagnostics: TocStructureDiagnostic[]): string {
  const details = diagnostics.map((d) => {
    if (d.code === 'LEVEL_COUNT_MISMATCH') {
      return '层级数量不匹配：需要 ' + d.expectedRows + ' 项，实际返回 ' + d.actualLevels + ' 项。'
    }
    if (d.code === 'INVALID_LEVEL') {
      return '第 ' + ((d.rowIndex ?? 0) + 1) + ' 项不是正整数。'
    }
    if (d.code === 'LEVEL_JUMP') {
      return '第 ' + ((d.rowIndex ?? 0) + 1) + ' 项发生非法层级跳变。'
    }
    if (d.code === 'EMPTY_OUTPUT') return '上一次没有返回层级。'
    if (d.code === 'MALFORMED_OUTPUT') return '上一次输出不是合法的紧凑 JSON 对象。'
    if (d.code === 'API_ERROR') return '上一次结构分析请求失败。'
    return '上一次结构分析未通过校验。'
  }).join('\n')
  return '上一次目录结构输出未通过校验。\n' + details + '\n' +
    '请基于同一份输入重新输出完整结构。只输出一个 JSON 对象：{"levels":[...]}。\n' +
    '必须正好包含 ' + rowsCount + ' 个正整数，严格按输入顺序对应每一行。不要返回 id、title、pageLabel 或任何解释。'
}

/** Normalized identity used ONLY for EXACT boundary-duplicate detection
 *  (same normalized title + same pageLabel + same physical tocPage). */
export function boundaryDedupeKey(r: { title: string; pageLabel: string; tocPage: number }): string {
  return r.title + '|' + r.pageLabel + '|' + r.tocPage
}

/**
 * Strict longest-suffix-overlap boundary dedupe (Stage 9.4D.2). Finds the LARGEST k
 * such that suffix(prev, k) EXACTLY equals prefix(cur, k) using the canonical identity
 * (normalized title + pageLabel + physical tocPage), then drops those k rows from the
 * head of cur. This handles a window that re-extends the previous window's tail
 * (prev=[X,A,B], cur=[A,B,C] -> [C]) while NEVER fuzzy-merging similar titles
 * (第一章 研究对象 vs 第一章 研究方法 must never merge) and NEVER deduping two
 * identical rows inside the same window (prev empty -> [A,A] preserved). Pure.
 */
export function dedupeWindowBoundary(prev: TocTranscriptionRow[], cur: TocTranscriptionRow[]): TocTranscriptionRow[] {
  const maxK = Math.min(prev.length, cur.length)
  let k = 0
  for (let cand = maxK; cand >= 1; cand--) {
    const suf = prev.slice(prev.length - cand)
    const pre = cur.slice(0, cand)
    let eq = true
    for (let j = 0; j < cand; j++) { if (boundaryDedupeKey(suf[j]) !== boundaryDedupeKey(pre[j])) { eq = false; break } }
    if (eq) { k = cand; break }
  }
  return k > 0 ? cur.slice(k) : cur
}

/** Deduplicate consecutive copy runs, then RE-INDEX to a stable contiguous r0001….
 *  Order preserved, ids re-based (local provenance — structure only references ids). */
export function reindexRows(rows: TocTranscriptionRow[]): TocTranscriptionRow[] {
  return rows.map((r, i) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }))
}

export { newStableId }

// ---- production prompt constants (Stage 9.4C.1) ----
// Kept in the PURE domain module so a node regression test can assert the exact
// production prompt contract without pulling the PDF renderer / Vite ?url assets.
export const TOC_TRANSCRIPTION_SYSTEM_PROMPT =
  '你是 PDF 目录页的视觉转录助手。你只负责忠实抄录目录中印刷的章节行。\n' +
  '你绝不能：构建层级结构、判断整本最终层级、输出子节点、输出数组格式、添加不存在的章节、概括或改写标题。\n' +
  '中文字符必须严格保持图片中的简体/繁体形式：不得进行简繁转换、同义改写或文字规范化。若图片是繁体，就输出繁体；若图片是简体，就输出简体；绝不允许统一改成简体或繁体。\n' +
  '输出必须是 JSONL（每行一个 JSON 对象，一行 = 一条目录行）。\n' +
  '每条只包含：title（原样完整标题，忠实保留标题字符、编号和真实标点）、pageLabel（只表示真正印刷的页码内容；版面中用于连接标题与页码的视觉装饰、点线、斜杠等，如果明显不是页码本体，不要混入 pageLabel）、sourceImageIndex（本条来自当前请求的第几张图片，从 1 开始）、visualIndent（看到的缩进层级，可选）、numbering（原样编号前缀如 第一章/一、/（一）/1.，可选）。\n' +
  '示例（仅一条）：{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n' +
  '请按阅读顺序逐条抄录，不遗漏、不概括、不编造、不改写标题。若输入提示中有“上一批最后几条目录转录…”，请只转录当前图片中新出现的目录行，不要重复输出以上内容。只输出 JSONL，不要任何解释。'

export const TOC_STRUCTURE_PROMPT =
  '你是 PDF 目录结构分析助手。输入是逐行目录转录（含阅读顺序、缩进、编号），仅文本。\n' +
  '你只负责整体判断每条目录的绝对层级。输入第 1 行对应 levels[0]，输入第 2 行对应 levels[1]，依此类推。\n' +
  '输出必须是一个紧凑 JSON 对象：{"levels":[1,2,3]}。levels 必须严格按输入行顺序，且正好包含与输入行数相同的正整数。\n' +
  '你不可以返回或修改 title、pageLabel、tocPage、rowOrder、numbering、visualIndent 等任何其他字段；这些全部由本地转录和页码映射保留。不要返回 id，不要返回 JSONL，不要解释。'
