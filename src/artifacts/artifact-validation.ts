import type { ArtifactKind, ArtifactSourceSnapshot, QuizDocument, QuizQuestion, SourceCitation, StudyArtifact } from './artifact-types'

export class QuizValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'QuizValidationError' }
}

const VALID_KINDS = new Set(['note', 'quiz', 'summary', 'study-guide', 'custom'])
const VALID_STATUS = new Set(['draft', 'generating', 'ready', 'error'])
const VALID_Q_TYPES = new Set(['single-choice', 'multiple-choice', 'true-false', 'short-answer'])
const VALID_SOURCE_ORIGINS = new Set(['pdf-page', 'document', 'image', 'conversation'])

function isStr(v: unknown): v is string { return typeof v === 'string' }
function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) }
function isInt(v: unknown): v is number { return isNum(v) && Number.isInteger(v) }
function isObj(v: unknown): v is Record<string, any> { return typeof v === 'object' && v !== null && !Array.isArray(v) }

/** Validate a source citation; returns it on success, null on any structural problem. */
export function validateSourceCitation(v: unknown): SourceCitation | null {
  if (!isObj(v)) return null
  if (!VALID_SOURCE_ORIGINS.has(v.origin)) return null
  const out: SourceCitation = { origin: v.origin }
  if (v.fileName !== undefined) { if (!isStr(v.fileName)) return null; out.fileName = v.fileName }
  if (v.documentId !== undefined) { if (!isStr(v.documentId)) return null; out.documentId = v.documentId }
  if (v.title !== undefined) { if (!isStr(v.title)) return null; out.title = v.title }
  if (v.chapterTitle !== undefined) { if (!isStr(v.chapterTitle)) return null; out.chapterTitle = v.chapterTitle }
  if (v.pageNumber !== undefined) { if (!isInt(v.pageNumber) || v.pageNumber < 1) return null; out.pageNumber = v.pageNumber }
  if (v.pages !== undefined) { if (!Array.isArray(v.pages) || v.pages.length !== 2 || !isInt(v.pages[0]) || !isInt(v.pages[1]) || v.pages[0] < 1 || v.pages[1] < v.pages[0]) return null; out.pages = [v.pages[0], v.pages[1]] }
  return out
}

function requireString(v: unknown, field: string): string {
  if (!isStr(v) || v.trim() === '') throw new QuizValidationError(field + ' 必须是非空字符串')
  return v
}

// A reasonable upper bound on number of options (A12). Keeps letter labels A..Z safe and
// prevents a stray model from emitting hundreds of options.
const MAX_OPTION_OPTIONS = 26

function validateOptions(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new QuizValidationError('options 必须是非空字符串数组')
  if (v.length > MAX_OPTION_OPTIONS) throw new QuizValidationError('options 数量超过上限（' + MAX_OPTION_OPTIONS + '）')
  for (const o of v) if (!isStr(o) || o.trim() === '') throw new QuizValidationError('options 含非法项')
  return v
}

/** Validate one question; returns the normalized question, or throws QuizValidationError. */
export function validateQuizQuestion(v: unknown): QuizQuestion {
  if (!isObj(v)) throw new QuizValidationError('question 必须是对象')
  if (!isStr(v.id) || v.id.trim() === '') throw new QuizValidationError('question.id 非法')
  const id = v.id
  if (!VALID_Q_TYPES.has(v.type)) throw new QuizValidationError('question.type 不在支持集合')
  const question = requireString(v.question, 'question.question')
  const explanation = v.explanation !== undefined ? (isStr(v.explanation) ? v.explanation : undefined) : undefined
  let source: SourceCitation | undefined
  if (v.source !== undefined) { const s = validateSourceCitation(v.source); if (!s) throw new QuizValidationError('question.source 非法'); source = s }
  switch (v.type) {
    case 'single-choice': {
      const options = validateOptions(v.options)
      if (v.answers !== undefined || v.answer === undefined || !isInt(v.answer)) throw new QuizValidationError('single-choice.answer 必须是整数')
      if (v.answer < 0 || v.answer >= options.length) throw new QuizValidationError('single-choice.answer 索引越界')
      return { id, type: 'single-choice', question, options, answer: v.answer, ...(explanation !== undefined ? { explanation } : {}), ...(source ? { source } : {}) }
    }
    case 'multiple-choice': {
      const options = validateOptions(v.options)
      if (v.answer !== undefined || v.answers === undefined || !Array.isArray(v.answers) || v.answers.length === 0) throw new QuizValidationError('multiple-choice.answers 必须是非空整数数组')
      for (const a of v.answers) { if (!isInt(a) || a < 0 || a >= options.length) throw new QuizValidationError('multiple-choice.answers 含越界索引') }
      const answers = [...new Set(v.answers as number[])].sort((a, b) => a - b)
      return { id, type: 'multiple-choice', question, options, answers, ...(explanation !== undefined ? { explanation } : {}), ...(source ? { source } : {}) }
    }
    case 'true-false': {
      if (typeof v.answer !== 'boolean') throw new QuizValidationError('true-false.answer 必须是布尔值')
      return { id, type: 'true-false', question, answer: v.answer, ...(explanation !== undefined ? { explanation } : {}), ...(source ? { source } : {}) }
    }
    case 'short-answer': {
      if (!isStr(v.answer)) throw new QuizValidationError('short-answer.answer 必须是字符串')
      return { id, type: 'short-answer', question, answer: v.answer, ...(explanation !== undefined ? { explanation } : {}), ...(source ? { source } : {}) }
    }
    default: throw new QuizValidationError('question.type 非法')
  }
}

/** Validate a whole quiz document; throws QuizValidationError on any malformed part. */
export function validateQuizDocument(v: unknown): QuizDocument {
  if (!isObj(v) || !Array.isArray(v.questions) || v.questions.length === 0) throw new QuizValidationError('quiz 必须是含非空 questions 数组的对象')
  const ids = new Set<string>()
  const questions = v.questions.map((q: unknown, qi: number) => {
    try {
      const parsed = validateQuizQuestion(q)
      if (ids.has(parsed.id)) throw new QuizValidationError('question.id 重复')
      ids.add(parsed.id)
      return parsed
    } catch (e) {
      // A5: surface the SPECIFIC failing question for a helpful recovery message.
      if (e instanceof QuizValidationError) throw new QuizValidationError('第 ' + (qi + 1) + ' 题：' + e.message)
      throw e
    }
  })
  return { questions }
}

/**
 * Extract the raw JSON value from the model output. Model output is UNTRUSTED: strip code
 * fences, locate the JSON object, then return the parsed value. Throws QuizValidationError
 * when no parseable object is found.
 */
export function extractQuizJson(rawText: string): unknown {
  const text = stripFences(String(rawText ?? '').trim())
  if (!text) throw new QuizValidationError('模型输出为空')
  try { return JSON.parse(text) }
  catch {
    const start = text.indexOf('{')
    if (start < 0) throw new QuizValidationError('输出中未找到 JSON 对象')
    return tryParseBalanced(text, start)
  }
}

/** Convert an option letter ('B') to its 0-based index (1). Returns null when ambiguous. */
function letterToIndex(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const t = s.trim().toUpperCase()
  if (t.length === 1 && t >= 'A' && t <= 'Z') return t.charCodeAt(0) - 65
  return null
}

/**
 * A4 normalization layer. Only ever makes UNAMBIGUOUS fixes to common model output:
 *   - `option` -> `options`
 *   - single-choice `answer: "B"` -> `1` (only when it maps cleanly to a letter)
 *   - multiple-choice `answers: ["A","C"]` -> `[0,2]`
 *   - true-false `answer: "true"/"false"` (and explicit Chinese 正确/错误/对/错/是/否) -> boolean
 * NEVER guesses ambiguous answers, NEVER drops malformed questions, NEVER fabricates data.
 * Anything it can't fix cleanly is left for strict validation to reject.
 */
export function normalizeQuizJson(v: unknown): unknown {
  if (!isObj(v)) return v
  const out: Record<string, any> = { ...v }
  if (!Array.isArray(out.options) && Array.isArray(out.option)) out.options = out.option
  if (out.type === 'multi-choice' || out.type === 'multiple' || out.type === 'multi') out.type = 'multiple-choice'
  if (out.type === 'single-choice' && typeof out.answer === 'string') {
    const idx = letterToIndex(out.answer)
    if (idx !== null) out.answer = idx
  }
  if (out.type === 'multiple-choice' && Array.isArray(out.answers)) {
    if (out.answers.every((x: unknown) => typeof x === 'string')) {
      const idxs = out.answers.map((x: unknown) => letterToIndex(x))
      if (idxs.every((i: number | null) => i !== null)) out.answers = idxs as number[]
    }
  }
  if (out.type === 'true-false' && typeof out.answer === 'string') {
    const t = out.answer.trim().toLowerCase()
    if (t === 'true' || t === '正确' || t === '对' || t === '是') out.answer = true
    else if (t === 'false' || t === '错误' || t === '错' || t === '否') out.answer = false
  }
  if (Array.isArray(out.questions)) out.questions = out.questions.map((q: unknown) => normalizeQuizJson(q))
  return out
}

/**
 * Parse + normalize + strictly validate a model response into a QuizDocument.
 * Model output is UNTRUSTED. Normalization happens before strict validation so the
 * persisted schema stays strict. Throws QuizValidationError on any shape that cannot
 * be normalized to a valid document (never saved as 'ready').
 */
export function parseQuizDocument(rawText: string): QuizDocument {
  const parsed = extractQuizJson(rawText)
  return validateQuizDocument(normalizeQuizJson(parsed))
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

function tryParseBalanced(text: string, start: number): unknown {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { const candidate = text.slice(start, i + 1); try { return JSON.parse(candidate) } catch { throw new QuizValidationError('无法解析 JSON 对象') } } }
  }
  throw new QuizValidationError('JSON 对象不完整')
}

/** Validate the immutable source snapshot shape (used by backup import). */
export function validateSourceSnapshot(v: unknown): ArtifactSourceSnapshot | null {
  if (!isObj(v)) return null
  if (!isStr(v.conversationId) || !isStr(v.throughMessageId)) return null
  if (!isNum(v.createdAt)) return null
  if (!Array.isArray(v.messages)) return null
  for (const m of v.messages) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || !isStr(m.text)) return null
    if (!Array.isArray(m.imageIds) || m.imageIds.some((x: unknown) => !isStr(x))) return null
  }
  if (!Array.isArray(v.provenance)) return null
  for (const p of v.provenance) { if (!validateSourceCitation(p)) return null }
  if (!isStr(v.sourceLabel) || typeof v.sourceDeleted !== 'boolean') return null
  return v as ArtifactSourceSnapshot
}

export function isArtifactKind(k: unknown): k is ArtifactKind { return typeof k === 'string' && VALID_KINDS.has(k) }

/** Validate a full StudyArtifact record shape (used by backup import + boot sanity). */
export function validateArtifact(v: unknown): StudyArtifact | null {
  if (!isObj(v)) return null
  if (!isStr(v.id) || !isArtifactKind(v.kind) || !isStr(v.title) || !isStr(v.prompt)) return null
  if (!isNum(v.createdAt) || !isNum(v.updatedAt) || !VALID_STATUS.has(v.status)) return null
  if (!isObj(v.source) || !isStr(v.source.conversationId) || !isStr(v.source.throughMessageId)) return null
  if (!validateSourceSnapshot(v.source.snapshot)) return null
  if (v.presetId !== undefined && !isStr(v.presetId)) return null
  if (v.content !== undefined && !isStr(v.content)) return null
  if (v.error !== undefined && !isStr(v.error)) return null
  if (v.generatedContent !== undefined && !isStr(v.generatedContent)) return null
  if (v.kind === 'quiz') { try { if (!validateQuizDocument(v.quiz)) return null } catch { return null } }
  else if (v.quiz !== undefined) return null
  return v as StudyArtifact
}
