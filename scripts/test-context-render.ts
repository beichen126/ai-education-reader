// Stage 9.2B2: shared context render core with a FAKE renderer (no PDF.js).
import { renderPdfContextRanges, PdfContextRenderError } from '../src/pdf/pdf-context-render.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const MB = 1024 * 1024
const fakeRender = (n: number, bytes = 100) => ({ blob: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), width: 10, height: 10, mimeType: 'image/jpeg' })
const noCancel = () => false

// normalize / order / dedupe
const a = await renderPdfContextRanges({ ranges: [{ startPage: 30, endPage: 32 }, { startPage: 100, endPage: 101 }, { startPage: 31, endPage: 35 }], pageCount: 200, renderPage: fakeRender, isCancelled: noCancel })
assert(a.pages.length === 8, 'overlap dedupe -> 6+2 = 8 unique pages (got ' + a.pages.length + ')')
assert(a.pages.map(p => p.pageNumber).join(',') === '30,31,32,33,34,35,100,101', 'page order range-by-range (got ' + a.pages.map(p => p.pageNumber) + ')')
// adjacent merge
const b = await renderPdfContextRanges({ ranges: [{ startPage: 20, endPage: 40 }, { startPage: 41, endPage: 50 }], pageCount: 100, renderPage: fakeRender, isCancelled: noCancel })
assert(b.pages.length === 31, 'adjacent ranges render once (20-50 = 31 pages)')
// 120 exactly allowed / 121 blocked
const one = await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 120 }], pageCount: 500, renderPage: fakeRender, isCancelled: noCancel })
assert(one.pages.length === 120, '120 pages exactly allowed')
let hard = false
try { await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 121 }], pageCount: 500, renderPage: fakeRender, isCancelled: noCancel }) } catch (e) { hard = e instanceof PdfContextRenderError && e.kind === 'hard-limit' }
assert(hard, '121 pages -> hard-limit error')
// 24 MiB exactly allowed / +1 blocked
let ok24 = true
try { await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 2 }], pageCount: 10, renderPage: (n) => fakeRender(n, 12 * MB), isCancelled: noCancel }) } catch { ok24 = false }
assert(ok24, '24 MiB exactly allowed')
let over = false
try { await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 3 }], pageCount: 10, renderPage: (n) => fakeRender(n, 12 * MB + 1024), isCancelled: noCancel }) } catch (e) { over = e instanceof PdfContextRenderError && e.kind === 'byte-budget' }
assert(over, '24 MiB + 1 -> byte-budget error')
// render failure -> all-or-nothing error
let rf = false
try { await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 3 }], pageCount: 10, renderPage: (n) => { if (n === 2) throw new Error('boom'); return fakeRender(n) }, isCancelled: noCancel }) } catch (e) { rf = e instanceof PdfContextRenderError && e.kind === 'render-failed' }
assert(rf, 'page render failure -> render-failed (no partial result)')
// cancel -> stops
let rendered = 0
let cancelled = false
let ce = false
try {
  await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 100 }], pageCount: 100, renderPage: (n) => { rendered++; if (n === 3) cancelled = true; return fakeRender(n) }, isCancelled: () => cancelled })
} catch (e) { ce = e instanceof PdfContextRenderError && e.kind === 'cancelled' }
assert(ce && rendered <= 4, 'cancel stops at next page boundary (' + rendered + ' pages rendered)')
// progress callback + bytes
const events: any[] = []
const c = await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 3 }], pageCount: 10, renderPage: (n) => fakeRender(n, 100), onProgress: p => events.push(p), isCancelled: noCancel })
assert(events.length === 3 && events[2].done === 3 && events[2].total === 3 && events[2].bytes === 300, 'progress count/bytes reported (got ' + JSON.stringify(events[2]) + ')')
// empty + out-of-range
let empty = false
try { await renderPdfContextRanges({ ranges: [], pageCount: 10, renderPage: fakeRender, isCancelled: noCancel }) } catch (e) { empty = e instanceof PdfContextRenderError && e.kind === 'empty' }
assert(empty, 'empty ranges rejected')
let oor = false
try { await renderPdfContextRanges({ ranges: [{ startPage: 5, endPage: 20 }], pageCount: 10, renderPage: fakeRender, isCancelled: noCancel }) } catch (e) { oor = e instanceof PdfContextRenderError && e.kind === 'out-of-range' }
assert(oor, 'out-of-bounds range rejected')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
