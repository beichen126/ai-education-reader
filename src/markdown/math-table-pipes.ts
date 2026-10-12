/** Protect TeX bars from GFM's table splitting before inline math is parsed.
 * A one-code-unit placeholder preserves every original source offset.
 */
export function protectMathTablePipes(source: string, tableRanges: { start: number; end: number }[]): { content: string; placeholder: string } | null {
  if (!tableRanges.length || !source.includes('|')) return null
  let placeholder = ''
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const candidate = String.fromCharCode(code)
    if (!source.includes(candidate)) { placeholder = candidate; break }
  }
  if (!placeholder) return null
  const chars = source.split('')
  let changed = false
  const escaped = (index: number) => {
    let count = 0
    while (index > 0 && source[--index] === '\\') count++
    return count % 2 === 1
  }
  const ranges = tableRanges.slice().sort((a, b) => a.start - b.start)
  let rangeIndex = 0
  for (let start = 0; start < source.length; start++) {
    while (ranges[rangeIndex] && start >= ranges[rangeIndex].end) rangeIndex++
    const range = ranges[rangeIndex]
    if (!range) break
    if (start < range.start) start = range.start
    const lineEnd = source.indexOf('\n', start)
    const limit = Math.min(range.end, lineEnd < 0 ? source.length : lineEnd)
    if (escaped(start)) continue
    // Code spans are not math. Leave their table escaping rules unchanged.
    if (source[start] === '`') {
      let end = start
      while (source[end] === '`') end++
      const close = source.indexOf(source.slice(start, end), end)
      if (close >= 0 && close < limit) start = close + end - start - 1
      else start = end - 1
      continue
    }
    let opening = '', closing = ''
    if (source.startsWith('\\(', start)) { opening = '\\('; closing = '\\)' }
    else if (source[start] === '$') {
      let end = start + 1
      while (source[end] === '$') end++
      opening = closing = source.slice(start, end)
    }
    if (!opening) continue
    let close = source.indexOf(closing, start + opening.length)
    while (close >= 0 && close < limit && (escaped(close) || (closing[0] === '$' && (source[close - 1] === '$' || source[close + closing.length] === '$')))) {
      close = source.indexOf(closing, close + closing.length)
    }
    if (close < 0 || close >= limit) { start += opening.length - 1; continue }
    for (let index = start + opening.length; index < close; index++) {
      if (source[index] === '|' && !escaped(index)) { chars[index] = placeholder; changed = true }
    }
    start = close + closing.length - 1
  }
  return changed ? { content: chars.join(''), placeholder } : null
}
