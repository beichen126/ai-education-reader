import { math } from 'micromark-extension-math'
import { codes } from 'micromark-util-symbol'
import type { Construct, Extension } from 'micromark-util-types'

export function isCurrencyMathCandidate(raw: string, followingCode: number | null): boolean {
  if (!raw.startsWith('$') || raw.startsWith('$$')) return false
  const body = raw.slice(1, -1)
  const amount = body.match(/^\s*[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/)
  if (!amount) return false
  const suffix = body.slice(amount[0].length)
  return (followingCode !== null && followingCode >= codes.digit0 && followingCode <= codes.digit9)
    || /^[.,;:]?\s+(?:of|and|or|for|to|in|per|with|from|worth|dollars?|USD|million|billion|trillion|each|is|was|were|costs?|at)\b/i.test(suffix)
    || /^[.,;:]?\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/.test(suffix)
    || /^\s*[|–—-]\s*$/.test(suffix)
}

/** Keep ordinary dollar amounts from consuming prose up to the next amount or
 * formula. Wrap the native tokenizer so source offsets and all TeX tokens stay
 * unchanged; numeric formulas such as $100$ and $100 + 20$ remain supported.
 */
export function currencyAwareMath(): Extension {
  const extension = math()
  const original = extension.text![codes.dollarSign] as Construct
  extension.text![codes.dollarSign] = {
    ...original,
    tokenize(effects, ok, nok) {
      return original.tokenize.call(this, effects, code => {
        const token = this.events.at(-1)?.[1]
        if (token?.type === 'mathText') {
          const raw = this.sliceSerialize(token, true)
          if (isCurrencyMathCandidate(raw, code)) return nok(code)
        }
        return ok(code)
      }, nok)
    },
  }
  return extension
}
