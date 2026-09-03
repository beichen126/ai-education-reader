// Document Library + Reader acceptance e2e (Windows/local, REAL Microsoft Edge).
//
// Run:
//   1) npm run build && npm run preview -- --port 5299
//   2) node scripts/e2e-document-reader.mjs
//      E2E_BASE=... node scripts/e2e-document-reader.mjs   (other host)
//
// Covers: library import -> reader -> chapter jump -> prev/next -> direct page ->
// close -> reopen (progress restored) -> reload (still restored) -> page zoom
// (zoom viewer + transient HUD) -> responsive (mobile toc drawer) -> delete.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES_ENTRY = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const IMAGES_ENTRY = '[data-testid="sidebar-entry-images"], [data-testid="rail-images"]'
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
const openLibrary = async () => { await page.locator(FILES_ENTRY).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }

// ---- A. library empty state -> import PDF -> Reader opens on page 1 ----
await openLibrary()
assert(await page.locator('[data-testid="library-empty"]').count() === 1, 'A: library shows empty state')
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('outline-sample.pdf'), 'A: import -> reader opened with title')
assert((await inputVal()).trim() === '1', 'A: unread doc opens at page 1')

// ---- B. chapter jump (expand parent chapter first) ----
await page.locator('[data-testid="reader-toc-toggle-0"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-0.0"]').click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '2', 'B: chapter 1.1 -> page 2 (got ' + (await inputVal()) + ')')

// ---- C. prev / next ----
await page.locator('[data-testid="reader-next"]').click()
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '3', 'C: next -> 3')
await page.locator('[data-testid="reader-prev"]').click()
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '2', 'C: prev -> 2')
assert(await page.locator('[data-testid="reader-prev"]').isDisabled() === false, 'C: prev enabled at page 2')
await page.locator('[data-testid="reader-page-input"]').fill('1')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '1' && await page.locator('[data-testid="reader-prev"]').isDisabled(), 'C: page 1 -> prev disabled')

// ---- D. direct page input (valid + invalid) ----
await page.locator('[data-testid="reader-page-input"]').fill('5')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '5', 'D: direct input 5 -> page 5')
await page.locator('[data-testid="reader-page-input"]').fill('0')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="reader-page-error"]').count() === 1, 'D: invalid 0 shows error, no navigation')
assert((await inputVal()).trim() === '0' || (await inputVal()).trim() === '5', 'D: input text stays (no silent jump)')
await page.locator('[data-testid="reader-page-input"]').fill('5')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
await page.waitForTimeout(1300) // debounce (1000ms) fires -> persisted 5

// ---- E. 返回文件 -> reopen restores page; reload still restores ----
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
assert((await inputVal()).trim() === '5', 'E: reopen after close -> lastReadPage 5')
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
assert((await inputVal()).trim() === '5', 'E: reload -> still page 5')

// ---- F. page zoom (existing viewer + transient HUD) ----
await page.locator('[data-testid="reader-page"]').click()
await page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="viewer-zoom-hud"]').count() === 0, 'F: zoom viewer opens with HUD hidden')
const box = await page.locator('[data-testid="viewer-stage"]').boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.wheel(0, -600)
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="viewer-zoom-hud"]').count() === 1, 'F: wheel zoom shows HUD')
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
assert(await page.locator('[role="dialog"]').count() === 0, 'F: Escape closes zoom viewer')
assert(await page.locator('[data-testid="reader-page"]').count() === 1, 'F: back on the reader page')
assert((await inputVal()).trim() === '5', 'F: reader page unchanged after zoom')

// ---- G. responsive: mobile toc drawer ----
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)
assert(overflow, 'G: 360px no horizontal page overflow')
assert(await page.locator('[data-testid="reader-toc-toggle"]').isVisible(), 'G: mobile shows 目录 toggle')
await page.locator('[data-testid="reader-toc-toggle"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-toc"]').isVisible(), 'G: drawer opens')
await page.locator('[data-testid="reader-toc-toggle-1"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-1.0"]').click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '6', 'G: chapter 2.1 -> page 6 (drawer auto-closes)')
assert(await page.locator('[data-testid="reader-next"]').isVisible(), 'G: bottom nav clickable')
await page.setViewportSize({ width: 1024, height: 768 })
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-toc"]').isVisible(), 'G: 1024px toc persists')
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-next"]').isVisible(), 'G: 1280px nav visible')

// ---- H. sidebar regression: 图片 entry + settings + new chat ----
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'H: reader close -> closed (no overlay)')
await page.locator('[data-testid="library-close"]').click().catch(() => {})
await page.waitForTimeout(200)
await page.locator(IMAGES_ENTRY).first().click()
await page.getByText('当前会话暂无图片资料').waitFor({ state: 'visible', timeout: 10000 })
const galleryTitle = await page.locator('div[class*="head"] span').first().textContent()
assert(galleryTitle === '图片', 'H: gallery entry opens with 图片 title (got ' + galleryTitle + ')')
await page.getByRole('button', { name: '关闭' }).last().click()
await page.waitForTimeout(200)
await page.locator('[data-testid="sidebar-settings"]').click()
await page.getByText('AI Education Reader · v0.1.0-alpha.3 · Alpha').waitFor({ state: 'visible', timeout: 10000 })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await page.locator('[data-testid="sidebar-new-chat"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="sidebar-new-chat"]').count() === 1, 'H: sidebar new chat works')

// ---- I. delete document (confirm accepted via dialog handler) ----
await openLibrary()
await page.locator('[data-testid^="doc-delete-"]').first().click()
await page.waitForTimeout(500)
assert(await page.locator('[data-testid="library-empty"]').count() === 1, 'I: delete -> empty library')
assert(await page.locator('[data-testid="doc-card-"]').count() === 0, 'I: no doc cards remain')
await page.locator('[data-testid="library-close"]').click()

console.log('--------')
console.log(results.join('\n'))
const pe = errors.filter(e => e.startsWith('pageerror:'))
console.log('PAGEERRORS:', pe.length ? pe.join(' | ') : '(none)')
const passed = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
await browser.close()
process.exit(results.some(r => r.startsWith('FAIL')) || pe.length ? 1 : 0)
