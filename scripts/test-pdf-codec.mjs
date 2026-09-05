// PDF codec / non-white content regression (Windows/local, REAL Microsoft Edge).
// Proves REAL-WORLD PDF image decoding works: a PDF using a WASM-decoded image
// codec (JPX / JPEG2000 via OpenJPEG, and the same wasmUrl path that JBIG2 uses)
// must render NON-WHITE content. Without the shared runtime config (wasmUrl etc.)
// these pages render pure white while the render promise still resolves — the
// exact "some pages normal, many pages pure white" symptom.
//
// Run: node scripts/test-pdf-codec.mjs   (preview must be up)
//
// Fixture sources:
//   - test/fixtures/pdf-compat/jpx/jpx-codec.pdf = pdf.js test/pdfs/bug_jpx.pdf (Apache-2.0),
//     a small PDF embedding a JPEG2000 (JPXDecode) image.
//   - test/fixtures/pdf-compat/jpeg/jpeg-image.pdf = generated (a normal DCT/JPEG image), the
//     "plain JPEG should never be blank" control.
//   - test/fixtures/outline-sample.pdf = vector/text-only PDF control.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = []
const errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES_ENTRY = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator(FILES_ENTRY).first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}
const sample = () => page.evaluate(async () => {
  // The Reader正文 is now a visible <canvas> (Agent C) — drawImage works on it and the
  // bitmap dimensions come from its width/height attributes (a canvas has no naturalWidth).
  const el = document.querySelector('[data-testid="reader-page-img"]')
  if (!el) return { err: 'no img' }
  const c = document.createElement('canvas'); c.width = 80; c.height = 80
  const g = c.getContext('2d'); g.drawImage(el, 0, 0, 80, 80)
  const d = g.getImageData(0, 0, 80, 80).data
  let non = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) non++
  return { w: el.width, h: el.height, nonWhite: non / (80 * 80) }
})

// render one page of a fixture and return the non-white ratio
async function renderPage(fixture, pageNumber) {
  await openLibrary()
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
  if (pageNumber && pageNumber !== 1) {
    await page.locator('[data-testid="reader-page-input"]').fill(String(pageNumber))
    await page.locator('[data-testid="reader-page-input"]').press('Enter')
    await page.waitForTimeout(600)
  }
  const s = await sample()
  await page.locator('[data-testid="reader-close"]').click()
  await page.waitForTimeout(300)
  return s
}

// 1. vector/text PDF control -> must have content
const vec = await renderPage('test/fixtures/outline-sample.pdf', 1)
assert(vec && vec.nonWhite > 0.01, 'vector/text PDF renders non-white (got ' + (vec ? vec.nonWhite.toFixed(4) : 'err') + ')')

// 2. normal JPEG (DCT) image PDF control -> must have content
const jpg = await renderPage('test/fixtures/pdf-compat/jpeg/jpeg-image.pdf', 1)
assert(jpg && jpg.nonWhite > 0.01, 'plain JPEG image PDF renders non-white (got ' + (jpg ? jpg.nonWhite.toFixed(4) : 'err') + ')')

// 3. WASM-codec JPEG2000 (JPX) PDF -> THE regression case: must NOT be pure white
const jpx = await renderPage('test/fixtures/pdf-compat/jpx/jpx-codec.pdf', 1)
assert(jpx && jpx.nonWhite > 0.005, 'JPX/JPEG2000 codec PDF renders non-white (got ' + (jpx ? jpx.nonWhite.toFixed(4) : 'err') + ')')
assert(jpx && jpx.err === undefined, 'JPX page sampled successfully (no err)')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
const failCount = results.filter(r => r.startsWith('FAIL')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed' + (failCount ? ' (' + failCount + ' failed)' : ''))
process.exit(failCount === 0 ? 0 : 1)
