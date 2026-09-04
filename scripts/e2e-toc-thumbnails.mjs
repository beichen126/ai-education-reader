// Stage 9.4D.1: TOC thumbnail no-duplicate-render / no URL leak e2e. Opens the picker, waits
// for a thumbnail to render, records its object URL, loads more pages, then asserts the
// already-rendered page's URL is unchanged (no re-render) and that no duplicate is created.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-tricky.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })

// Reset the render-count instrumentation at test start.
await page.evaluate(() => { (globalThis as any).__dshThumbRenderCounts = undefined })

// Wait for the first few thumbnails to render (IO-driven).
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 30000 })
const src1 = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(!!src1 && src1.startsWith('blob:'), 'A: thumbnail rendered with an object URL');
const count1 = await page.evaluate(() => ((globalThis as any).__dshThumbRenderCounts || {})['1'] || 0)
assert(count1 === 1, 'precondition: page 1 rendered exactly once (count=' + count1 + ')');

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
await grid.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight })
await page.waitForTimeout(500)
const scrolledBottom = await grid.evaluate((el: HTMLElement) => el.scrollTop > 0)
assert(scrolledBottom, 'grid actually scrolled to the bottom (real scroll)')
// page 1 should now be out of view; IO disconnect/refire needs a real crossing.
await grid.evaluate((el: HTMLElement) => { el.scrollTop = 0 })
await page.waitForTimeout(900)
// Give IO a chance to re-observe thumb-1 and (if buggy) re-enqueue it.
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 10000 })
await page.waitForTimeout(600)
const count1b = await page.evaluate(() => ((globalThis as any).__dshThumbRenderCounts || {})['1'] || 0)
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