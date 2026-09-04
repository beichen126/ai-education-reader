
import { PDFHexString } from 'pdf-lib'
export function unicodePdfString(text: string): import('pdf-lib').PDFHexString {
  // UTF-16BE with BOM, encoded as a PDFHexString so any Unicode (Chinese) is preserved.
  let s = 'FEFF'
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    // surrogate pair handling for astral chars
    let u = cp
    if (cp > 0xFFFF) {
      const t = cp - 0x10000
      const hi = 0xD800 + (t >> 10), lo = 0xDC00 + (t & 0x3FF)
      s += hi.toString(16).toUpperCase().padStart(4, '0')
      s += lo.toString(16).toUpperCase().padStart(4, '0')
      continue
    }
    s += u.toString(16).toUpperCase().padStart(4, '0')
  }
  return PDFHexString.of(s)
}
