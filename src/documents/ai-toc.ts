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
