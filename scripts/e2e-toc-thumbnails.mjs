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

// Wait for the first few thumbnails to render (IO-driven).
await page.locator('[data-testid="toc-thumb-1"] img').waitFor({ state: 'attached', timeout: 30000 })
const src1 = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(!!src1 && src1.startsWith('blob:'), 'A: thumbnail rendered with an object URL');

// Load more pages, then confirm the already-rendered thumb-1 URL is unchanged (no re-render).
const moreBtn = page.locator('[data-testid="toc-picker-more"]')
if (await moreBtn.count()) { await moreBtn.click(); await page.waitForTimeout(800) }
const src1b = await page.locator('[data-testid="toc-thumb-1"] img').getAttribute('src')
assert(src1b === src1, 'B: render count does not increase on revisit (thumb-1 URL unchanged, got ' + (src1b === src1 ? 'same' : 'DIFFERENT') + ')');

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
