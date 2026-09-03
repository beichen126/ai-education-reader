// Pure Reader page logic (Stage 9.2B1) — no React/CSS so it is node-testable.
export function clampReaderPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || page < 1) return 1
  if (page > pageCount) return pageCount
  return Math.floor(page)
}

export type PageInputResult = { ok: true; page: number } | { ok: false; error: string }

/** Direct page input: only integer 1..pageCount navigates; anything else errors. */
export function parsePageInput(text: string, pageCount: number): PageInputResult {
  const v = text.trim()
  if (v === '') return { ok: false, error: '请输入页码。' }
  const n = Number(v)
  if (!Number.isInteger(n)) return { ok: false, error: '页码必须是整数。' }
  if (n < 1 || n > pageCount) return { ok: false, error: '页码超出范围（1–' + pageCount + '）。' }
  return { ok: true, page: n }
}
