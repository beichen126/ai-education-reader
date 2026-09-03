// Stage 9.1: pure multi-range PDF selection logic (no React / no PDF.js).
import {
  normalizePdfRanges, countPdfRangePages, expandPdfRangePages, pdfRangesText, pdfSelectionTitle,
  exceedsPdfContextHardLimit, needsPdfContextSoftConfirm, MAX_PDF_CONTEXT_PAGES,
  type PdfRange,
} from '../src/pdf/pdf-types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const r = (startPage: number, endPage: number): PdfRange => ({ startPage, endPage })
const eq = (a: PdfRange[], b: PdfRange[]) => a.length === b.length && a.every((x, i) => x.startPage === b[i].startPage && x.endPage === b[i].endPage)

// ---- Case A: plain non-contiguous ranges ----
const a = normalizePdfRanges([r(30, 48), r(100, 118)])
assert(eq(a, [r(30, 48), r(100, 118)]), 'A: keeps two non-contiguous ranges')
assert(countPdfRangePages(a) === 38, 'A: 19 + 19 = 38 pages (got ' + countPdfRangePages(a) + ')')

// ---- Case B: out-of-order input ----
const b = normalizePdfRanges([r(100, 118), r(30, 48)])
assert(eq(b, [r(30, 48), r(100, 118)]), 'B: out-of-order input sorted ascending')

// ---- Case C: full overlap ----
const c = normalizePdfRanges([r(20, 60), r(30, 40)])
assert(eq(c, [r(20, 60)]), 'C: nested overlap merges to one range')
assert(countPdfRangePages(c) === 41, 'C: count 41 (got ' + countPdfRangePages(c) + ')')

// ---- Case D: partial overlap ----
const d = normalizePdfRanges([r(20, 40), r(35, 60)])
assert(eq(d, [r(20, 60)]), 'D: partial overlap merges to 20-60')

// ---- Case E: adjacent ----
const e = normalizePdfRanges([r(20, 40), r(41, 60)])
assert(eq(e, [r(20, 60)]), 'E: adjacent ranges merge (identical page set)')

// ---- Case F: parent + child ----
const f = normalizePdfRanges([r(1, 100), r(20, 40)])
assert(eq(f, [r(1, 100)]), 'F: parent + child -> one range 1-100')
assert(countPdfRangePages(f) === 100, 'F: count = 100, not 121 (got ' + countPdfRangePages(f) + ')')

// ---- Case G: 120-page boundary ----
assert(exceedsPdfContextHardLimit(countPdfRangePages([r(1, 120)])) === false, 'G: 120 pages allowed')
assert(exceedsPdfContextHardLimit(countPdfRangePages([r(1, 121)])) === true, 'G: 121 pages rejected')
assert(exceedsPdfContextHardLimit(countPdfRangePages([r(1, 100), r(101, 120)])) === false, 'G: 100+20 merged ranges = 120 allowed')
assert(needsPdfContextSoftConfirm(countPdfRangePages([r(1, 31)])) === true, 'G: 31 pages -> soft confirm')
assert(needsPdfContextSoftConfirm(countPdfRangePages([r(1, 30)])) === false, 'G: 30 pages -> no confirm')

// ---- Case H: render order is range-by-range, not a fake span ----
const h = expandPdfRangePages([r(30, 32), r(100, 101)])
assert(eq(h.map((n, i) => r(n, n)), [r(30, 30), r(31, 31), r(32, 32), r(100, 100), r(101, 101)]), 'H: order 30,31,32,100,101')
assert(h.length === 5, 'H: 5 pages rendered (got ' + h.length + ')')
assert(!h.some(n => n >= 33 && n <= 99), 'H: pages 33-99 NOT rendered (no fake 30-118 span)')

// ---- extra: display text ----
assert(pdfRangesText([r(7, 8)]) === 'PDF 7–8', 'text: single range -> PDF 7–8')
assert(pdfRangesText([r(30, 48), r(100, 118)]) === 'PDF 30–48, 100–118', 'text: two ranges joined')
assert(pdfRangesText([r(3, 3)]) === 'PDF 第 3 页', 'text: single page')

// ---- title: single vs multi chapter (outline order, not click order) ----
assert(pdfSelectionTitle(['第二章 数据表示']) === '第二章 数据表示', 'title: single chapter keeps its own title')
assert(pdfSelectionTitle(['第二章 数据表示', '第五章 存储系统']) === '第二章 数据表示、第五章 存储系统', 'title: multi chapter joins ALL names')
assert(pdfSelectionTitle(['第二章 数据表示', '第五章 存储系统', '第七章 接口']) === '第二章 数据表示、第五章 存储系统、第七章 接口', 'title: three chapters joined')
assert(pdfSelectionTitle([]) === '', 'title: empty -> empty')
assert(pdfSelectionTitle(['  ']) === '', 'title: blank-only -> empty')

// ---- extra: invalid / empty input ----
assert(eq(normalizePdfRanges([]), []), 'empty input -> empty output')
assert(eq(normalizePdfRanges([r(5, 2)]), []), 'reversed range dropped')
assert(eq(normalizePdfRanges([r(0, 5)]), []), 'page < 1 dropped')
assert(countPdfRangePages([]) === 0, 'empty count = 0')
assert(exceedsPdfContextHardLimit(countPdfRangePages([r(1, 100), r(20, 40)])) === false, 'parent+child dedup never trips the hard limit')
assert(countPdfRangePages([r(1, 100), r(20, 40)]) <= MAX_PDF_CONTEXT_PAGES, 'deduped count <= 120 for the overlap example')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
