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
//   - Common JSON wrappers are normalized, then every row is validated: one malformed
//     row makes the whole result invalid (no partial rows, no silent data loss).
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

/** Translate stable parser/map diagnostics into safe English retry context. Raw
 * model output is deliberately never echoed back into a subsequent request. */
export function tocTranscriptionDiagnosticEnglish(diagnostic: string): string {
  if (diagnostic === '空响应') return 'The response was empty.'
  if (diagnostic === '未识别到目录条目') return 'No outline rows were detected.'
  let match = /^第 (\d+) 行不是合法 JSON$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' was not valid JSON.'
  match = /^第 (\d+) 行不是对象$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' was not a JSON object.'
  match = /^第 (\d+) 行缺少有效 title$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' was missing a non-empty title.'
  match = /^第 (\d+) 行缺少合法的 sourceImageIndex$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' was missing a valid sourceImageIndex.'
  match = /^第 (\d+) 行 sourceImageIndex 超出当前请求图片范围$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' used a sourceImageIndex outside the current image batch.'
  match = /^第 (\d+) 行映射到非法物理页$/.exec(diagnostic)
  if (match) return 'Row ' + match[1] + ' could not be mapped to a valid PDF page.'
  return 'The response did not match the required outline JSONL schema.'
}

export function buildTocTranscriptionRepairPrompt(diagnostics: string[]): string {
  const details = [...new Set(diagnostics)].slice(0, 8).map(item => '- ' + tocTranscriptionDiagnosticEnglish(item)).join('\n')
  return 'The previous response failed local validation:\n' + (details || '- The response did not match the required outline JSONL schema.') + '\n' +
    'Correct every listed issue and transcribe the same images again. Return JSONL only. Every row must include title, pageLabel, and sourceImageIndex. Use pageLabel:"" when no printed destination-page label is visible; never omit the key. Return no explanation.'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Normalize a raw title string: trim runs of whitespace to single spaces. */
export function normalizeTitle(raw: string): string {
  return String(raw).replace(/[\s\u3000]+/g, ' ').trim()
}

function normalizePageLabel(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') return v.trim()
  return null
}

/**
 * Strict transcription parse with compatibility for common model wrappers. Blank
 * lines are allowed; JSON/JSONL fences, a JSON array, and {rows/items/entries:[...]}
 * are accepted. EVERY malformed row
 * produces a precise diagnostic and the WHOLE result is invalid (never silently
 * drops a row). sourceImageIndex is REQUIRED: missing/non-integer/<1 => invalid.
 * No "scraping" from prose. Never partially persists.
 */
export function parseTocJsonl(text: string, options: { defaultSourceImageIndex?: number } = {}): TocJsonlParseResult {
  let body = String(text ?? '').trim()
  const fence = /^```(?:jsonl?|javascript)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  if (body === '') return { ok: false, line: 0, diagnostics: ['空响应'] }
  let candidates: unknown[] | null = null
  try {
    const whole = JSON.parse(body)
    if (Array.isArray(whole)) candidates = whole
    else if (isRecord(whole)) {
      const wrapped = whole.rows ?? whole.items ?? whole.entries
      candidates = Array.isArray(wrapped) ? wrapped : [whole]
    }
  } catch { /* genuine JSONL is parsed line by line below */ }
  const lines = candidates ? candidates.map((value) => JSON.stringify(value)) : body.split(/\r?\n/)
  const rows: TocTranscriptionLine[] = []
  const diagnostics: string[] = []
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx].trim()
    if (raw === '') continue // blank line allowed
    let json: unknown
    try { json = JSON.parse(raw) } catch { diagnostics.push('第 ' + (idx + 1) + ' 行不是合法 JSON'); continue }
    if (!isRecord(json)) { diagnostics.push('第 ' + (idx + 1) + ' 行不是对象'); continue }
    if (typeof json.title !== 'string' || json.title.trim() === '') { diagnostics.push('第 ' + (idx + 1) + ' 行缺少有效 title'); continue }
    // Compatible vision models sometimes use a conventional page-number alias,
    // or omit the field entirely when a printed TOC row has no readable page
    // number. Keep that otherwise useful row and send it to review as unresolved
    // instead of rejecting the whole batch forever. The raw label is never guessed.
    const suppliedPageLabel = json.pageLabel ?? json.page_label ?? json.pageNumber ?? json.page_number ?? json.printedPage ?? json.page
    const pl = normalizePageLabel(suppliedPageLabel) ?? ''
    const suppliedIndex = json.sourceImageIndex ?? json.source_image_index ?? json.imageIndex ?? json.image_index ?? json.sourcePageIndex ?? json.physicalPage ?? json.pdfPage
    const numericIndex = typeof suppliedIndex === 'string' && /^\d+$/.test(suppliedIndex.trim()) ? Number(suppliedIndex) : suppliedIndex
    const sii = numericIndex == null ? options.defaultSourceImageIndex : numericIndex
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
 * A model occasionally echoes the explicitly shown physical PDF page instead of
 * the requested image index. That value is accepted only when it exactly matches
 * one page in this batch; ambiguous/out-of-range values still invalidate the batch.
 */
export function mapTocSourcePages(rows: TocLocalRow[], pageBatch: number[]): TocPageMapFailure {
  const diagnostics: string[] = []
  const out: TocTranscriptionRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const supplied = r.sourceImageIndex
    const exactPhysicalIndex = pageBatch.indexOf(supplied)
    const idx = supplied >= 1 && supplied <= pageBatch.length ? supplied : exactPhysicalIndex + 1
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
  const rawLevels = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.levels)
      ? json.levels
      : isRecord(json) && isRecord(json.result) && Array.isArray(json.result.levels)
        ? json.result.levels
        : null
  if (!rawLevels) {
    return { ok: false, line: 0, diagnostics: [{ code: 'MALFORMED_OUTPUT', message: '结构分析结果必须是 {levels:[...]} 对象' }] }
  }
  const diagnostics: TocStructureDiagnostic[] = []
  const levels: number[] = []
  for (let i = 0; i < rawLevels.length; i++) {
    const rawLevel = rawLevels[i]
    const level = typeof rawLevel === 'string' && /^\d+$/.test(rawLevel.trim()) ? Number(rawLevel) : rawLevel
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

/** Build a reviewable local hierarchy when the optional AI structure pass fails.
 * Visual indentation is model-observed but row-aligned; ranks are normalized and
 * illegal jumps are clamped. With no useful indentation, a flat outline is safest. */
export function inferFallbackTocLevels(rows: TocTranscriptionRow[]): number[] {
  const observed = rows
    .map(row => row.visualIndent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  const ranks = [...new Set(observed)].sort((a, b) => a - b)
  if (ranks.length < 2) return rows.map(() => 1)
  const levels: number[] = []
  let previous = 1
  for (const row of rows) {
    const rank = typeof row.visualIndent === 'number' ? ranks.indexOf(row.visualIndent) + 1 : previous
    const next = Math.max(1, Math.min(rank > 0 ? rank : previous, previous + 1))
    levels.push(next)
    previous = next
  }
  return normalizeTocLevels(levels)
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
      return 'Level count mismatch: expected ' + d.expectedRows + ', received ' + d.actualLevels + '.'
    }
    if (d.code === 'INVALID_LEVEL') {
      return 'Item ' + ((d.rowIndex ?? 0) + 1) + ' is not a positive integer.'
    }
    if (d.code === 'LEVEL_JUMP') {
      return 'Item ' + ((d.rowIndex ?? 0) + 1) + ' has an invalid hierarchy jump.'
    }
    if (d.code === 'EMPTY_OUTPUT') return 'The previous response contained no levels.'
    if (d.code === 'MALFORMED_OUTPUT') return 'The previous response was not a valid compact JSON object.'
    if (d.code === 'API_ERROR') return 'The previous structure request failed.'
    return 'The previous structure response failed validation.'
  }).join('\n')
  return 'The previous outline-structure response failed validation.\n' + details + '\n' +
    'Return the complete structure again for the same input. Output exactly one JSON object: {"levels":[...]}.\n' +
    'It must contain exactly ' + rowsCount + ' positive integers in input-row order. Do not return id, title, pageLabel, or any explanation.'
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

/**
 * Serialize the stable, local structure input once per extraction.
 * The optional repair request reuses this exact string instead of rebuilding
 * the same row representation, while all provenance-only fields remain local.
 */
export function buildTocStructureInput(rows: TocTranscriptionRow[]): string {
  return rows.map((r, i) => 'row ' + (i + 1) + ' | ' + r.title + ' | indent ' + (r.visualIndent ?? '-') + ' | ' + (r.numbering ?? '-') + ' | p' + r.pageLabel).join('\n');
}

export { newStableId }

// ---- production prompt constants (Stage 9.4C.1) ----
// Kept in the PURE domain module so a node regression test can assert the exact
// production prompt contract without pulling the PDF renderer / Vite ?url assets.
export const TOC_TRANSCRIPTION_SYSTEM_PROMPT =
  'You are a visual transcription assistant for PDF table-of-contents pages. Faithfully copy only printed outline rows.\n' +
  'Never infer the final hierarchy, return child objects or an array, add chapters, summarize, translate, normalize, or rewrite titles.\n' +
  'Preserve every language and character exactly as printed, including Simplified or Traditional Chinese, capitalization, numbering, and punctuation.\n' +
  'Output JSONL: exactly one JSON object per printed outline row. Do not use a Markdown fence.\n' +
  'Every row MUST contain title, pageLabel, and sourceImageIndex. title is the complete printed title. pageLabel is only the printed destination-page label, without decorative leader dots or slashes. If no destination-page label is printed or it is unreadable, set pageLabel to the empty string ""; never omit the key. sourceImageIndex is the 1-based index of the current request image. visualIndent and numbering are optional.\n' +
  'Example: {"title":"Chapter 1 Introduction","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"Chapter 1"}\n' +
  'Copy rows in reading order. Omit nothing, invent nothing, and return no explanation. If the user message includes previous-batch tail rows for continuity, transcribe only new rows visible in the current images and do not repeat the tail rows.'

export const TOC_STRUCTURE_PROMPT =
  'You analyze the hierarchy of transcribed PDF outline rows. The input is text in reading order with indentation and numbering cues.\n' +
  'Infer only the absolute level of each row. Input row 1 maps to levels[0], row 2 to levels[1], and so on.\n' +
  'Output exactly one compact JSON object: {"levels":[1,2,3]}. levels must contain exactly one positive integer per input row in the same order.\n' +
  'Do not return or modify title, pageLabel, tocPage, rowOrder, numbering, visualIndent, ids, or any other field. Do not return JSONL or an explanation.'
