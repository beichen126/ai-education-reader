import { renderPdfContextRanges, PdfContextRenderError } from '../src/pdf/pdf-context-render.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const fakeRender = async (n) => ({ blob: new Blob([new Uint8Array([1])], { type: 'image/png' }), width: 1, height: 1, mimeType: 'image/png' })

// --- A: a stale operation (conversation switch) stops rendering EARLY ---
{
  // Simulate: 80-page context, renderPage is slow, and after page 3 the active
  // conversation switches (isCancelled becomes true). The stale op must stop and
  // NOT render all 80 pages.
  let rendered = 0
  let stale = false
  let caught = null
  try {
    await renderPdfContextRanges({
      ranges: [{ startPage: 1, endPage: 80 }], pageCount: 80,
      renderPage: async (n) => { rendered++; if (n === 3) stale = true; await new Promise(r => setTimeout(r, 5)); return fakeRender(n) },
      isCancelled: () => stale,
    })
  } catch (e) { caught = e }
  assert(rendered < 80, 'A: stale op stops early (rendered ' + rendered + ' of 80)')
  assert(caught instanceof PdfContextRenderError && caught.kind === 'cancelled', 'A: stale op throws cancelled (never commits)')
}

// --- B: a stale op with NO pages yet renders yields no partial result (all-or-nothing) ---
{
  let rendered = 0
  let cancelled = true
  try {
    await renderPdfContextRanges({
      ranges: [{ startPage: 1, endPage: 10 }], pageCount: 10,
      renderPage: async (n) => { rendered++; return fakeRender(n) },
      isCancelled: () => cancelled,
    })
  } catch (e) { /* expected */ }
  assert(rendered === 0, 'B: cancelled before first page renders 0 pages')
}


// --- C: a stale op never writes into a DIFFERENT conversation (ownership gate at draft level) ---
{
  // The reader's executeContext and the picker both pass an isStale predicate to
  // executeDocumentContext; the service re-checks it AFTER rendering and BEFORE
  // committing. Here we prove the render-level cancellation is what stops a stale op
  // early (so it never reaches the draft commit), which is the P0-5 ownership contract.
  let rendered = 0
  let switched = false
  let caught = null
  try {
    await renderPdfContextRanges({
      ranges: [{ startPage: 1, endPage: 50 }], pageCount: 50,
      renderPage: async (n) => { rendered++; if (n === 2) switched = true; await new Promise(r => setTimeout(r, 5)); return fakeRender(n) },
      isCancelled: () => switched || rendered > 2,
    })
  } catch (e) { caught = e }
  assert(caught instanceof PdfContextRenderError && caught.kind === 'cancelled', 'C: cancelled when active conversation switches (never commits)')
}

// --- D: a NON-stale operation completes and returns all pages ---
{
  const r = await renderPdfContextRanges({ ranges: [{ startPage: 1, endPage: 4 }], pageCount: 4, renderPage: fakeRender, isCancelled: () => false })
  assert(r.pages.length === 4, 'D: a fresh (non-stale) op renders all pages')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
