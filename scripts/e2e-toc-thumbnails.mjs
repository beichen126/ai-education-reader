// Stage 9.4D.1: TOC thumbnail no-duplicate-render / no URL leak e2e. Opens the picker, waits
// for a thumbnail to render, records its object URL, loads more pages, then asserts the
// already-rendered page's URL is unchanged (no re-render) and that no duplicate is created.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const guide = page.locator('[data-testid="product-guide"]')
if (await guide.isVisible().catch(() => false)) {
  await page.locator('[data-testid="product-guide-later"]').click()
  await guide.waitFor({ state: 'hidden', timeout: 10000 })
}

const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.evaluate(() => { (globalThis).__dshThumbRenderCounts = undefined })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })

// Wait for the first few thumbnails to render (IO-driven).
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 30000 })
const src1 = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(!!src1 && src1.startsWith('blob:'), 'A: thumbnail rendered with an object URL');
const count1 = await page.evaluate(() => ((globalThis).__dshThumbRenderCounts || {})['1'] || 0)
assert(count1 === 1, 'precondition: page 1 rendered exactly once (count=' + count1 + ')');

// Dragging across thumbnails emits a click on the release target after pointerup.
// That synthetic click must not invert the range endpoint.
const thumb1 = page.locator('[data-testid="toc-thumb-1"]')
const thumb3 = page.locator('[data-testid="toc-thumb-3"]')
const box1 = await thumb1.boundingBox()
const box3 = await thumb3.boundingBox()
if (box1 && box3) {
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2)
  await page.mouse.down()
  await page.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2, { steps: 12 })
  await page.mouse.up()
}
const dragSelection = await Promise.all([1, 2, 3].map(n => page.locator('[data-testid="toc-thumb-' + n + '"]').getAttribute('data-selected')))
assert(!!box1 && !!box3 && dragSelection.every(value => value === '1'), 'drag selection keeps both endpoints selected')
await page.locator('[data-testid="toc-picker-clear"]').click()

// Load ALL pages so the grid is genuinely scrollable (real scroll-away / scroll-back,
// not a "click more, src unchanged" proxy).
const grid = page.locator('[data-testid="toc-picker-grid"]')
let loadGuard = 0
while (await page.locator('[data-testid="toc-picker-more"]').count() && loadGuard < 12) {
  await page.locator('[data-testid="toc-picker-more"]').click()
  loadGuard++
  await page.waitForTimeout(150)
}
await page.waitForTimeout(900)

// Scroll page 1 FULLY out of the viewport (grid to the very bottom), then scroll back to the
// top so the IntersectionObserver re-fires on page 1.
await grid.evaluate((el) => { el.scrollTop = el.scrollHeight })
await page.waitForTimeout(500)
const scrolledBottom = await grid.evaluate((el) => el.scrollTop > 0)
assert(scrolledBottom, 'grid actually scrolled to the bottom (real scroll)')
// page 1 should now be out of view; IO disconnect/refire needs a real crossing.
await grid.evaluate((el) => { el.scrollTop = 0 })
await page.waitForTimeout(900)
// Give IO a chance to re-observe thumb-1 and (if buggy) re-enqueue it.
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 10000 })
await page.waitForTimeout(600)
const count1b = await page.evaluate(() => ((globalThis).__dshThumbRenderCounts || {})['1'] || 0)
assert(count1b === 1, 'B: renderCount(page 1) still 1 after scroll-away/scroll-back (got ' + count1b + ')');
const src1b = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(src1b === src1, 'B2: thumb-1 object URL unchanged after revisit');

// Close the picker and assert the object URL is revoked (no leak): re-open and it must not
// reuse a pre-existing Object URL for a fresh thumbnail.
await page.locator('[data-testid="toc-picker-cancel"]').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 30000 })
const src2 = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(src2 !== src1, 'C: re-open creates a FRESH object URL (old one revoked, no leak)');

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
