// Real-PDF integration test: load the fixture via PDF.js getDocument() and run the
// actual parser against getOutline()/getDestination()/getPageIndex(). This is NOT a
// mock — it exercises the true pdfjs destination resolution paths.
import { readFileSync } from 'node:fs'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs' // legacy avoids the Node build warning
import { parsePdfOutline, type PdfOutlineItem } from '../src/pdf/pdf-outline.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const data = new Uint8Array(readFileSync('test/fixtures/outline-sample.pdf'))
const task = pdfjsLib.getDocument({ data })
const doc = await task.promise

const res = await parsePdfOutline(doc)
assert(res.items.length === 2, 'fixture has 2 top-level bookmarks (chapters)')
assert(res.diagnostics.length === 0, 'no diagnostics for a clean fixture')

function byTitle(items: PdfOutlineItem[], t: string): PdfOutlineItem | undefined {
  for (const it of items) { if (it.title === t) return it; const d = byTitle(it.children, t); if (d) return d }
  return undefined
}

const ch1 = byTitle(res.items, 'Computer Organization')!
const s11 = byTitle(res.items, '1.1 History')!
const ch2 = byTitle(res.items, 'Data Representation')!
const s22 = byTitle(res.items, '2.2 Encodings')!

// Chapter 1 (explicit dest -> physical page 1)
assert(ch1.depth === 0, 'ch1 depth 0')
assert(ch1.startPage === 1, 'ch1 startPage = 1 (got ' + ch1.startPage + ')')
assert(ch1.endPage === 4, 'ch1 endPage = 4 (next chapter at page 5 -> 4) (got ' + ch1.endPage + ')')
assert(ch1.resolution === 'direct' && ch1.selectable, 'ch1 direct + selectable')
assert(ch1.children.length === 3, 'ch1 has 3 sub-sections')

// Named destination sub-section (sec11 -> physical page 2)
assert(s11.startPage === 2, '1.1 named-dest startPage = 2 (got ' + s11.startPage + ')')
assert(s11.endPage === 2, '1.1 endPage = 2 (got ' + s11.endPage + ')')
assert(s11.depth === 1 && s11.resolution === 'direct', '1.1 depth1 + direct')

// Next chapter (explicit -> page 5), last section (-> page 7)
assert(ch2.startPage === 5, 'ch2 startPage = 5 (got ' + ch2.startPage + ')')
assert(ch2.endPage === 8, 'last chapter endPage = doc.numPages 8 (got ' + ch2.endPage + ')')
assert(s22.startPage === 7 && s22.endPage === 8, 'last section start 7 end 8 (got ' + s22.startPage + '-' + s22.endPage + ')')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
