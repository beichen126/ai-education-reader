/** Formatting-only tolerance. Never evaluates JS, invents missing values, or
 * accepts a valid prefix of a truncated response. Quoted title text is untouched. */
export function normalizeTocJsonText(text: string): string {
  let body = String(text ?? '').trim()
  const fences = [...body.matchAll(/```(?:jsonl?|javascript)?[ \t]*\r?\n([\s\S]*?)```/gi)]
  if (fences.length === 1) {
    const fence = fences[0]
    const outside = body.slice(0, fence.index) + body.slice(fence.index! + fence[0].length)
    // Allow a short explanatory wrapper around exactly one complete code block,
    // but never discard another object/array or another fenced payload.
    if (!/[{}\[\]`]/.test(outside)) body = fence[1].trim()
  }
  let normalized = '', quoted = false, escaped = false
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (quoted) {
      normalized += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else {
      if (char === '"') quoted = true
      if (char === ',' && /^\s*[}\]]/.test(body.slice(index + 1))) continue
      normalized += char
    }
  }
  return normalized
}

/** Models sometimes pretty-print each JSONL object over several lines. Parse a
 * complete sequence of balanced objects, requiring all non-whitespace input to
 * belong to the sequence. Any malformed/truncated row rejects the whole batch. */
export function parseTocObjectSequence(body: string): unknown[] | null {
  const values: unknown[] = []
  let cursor = 0
  while (cursor < body.length) {
    while (/\s/.test(body[cursor] || '') && cursor < body.length) cursor++
    if (cursor === body.length) break
    if (body[cursor] !== '{') return null
    const start = cursor
    let depth = 0, quoted = false, escaped = false
    for (; cursor < body.length; cursor++) {
      const char = body[cursor]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') { if (--depth === 0) { cursor++; break } }
    }
    if (depth !== 0 || quoted) return null
    try { values.push(JSON.parse(body.slice(start, cursor))) } catch { return null }
  }
  return values.length ? values : null
}
