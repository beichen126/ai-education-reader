// capture-readme-assets.mjs — generate deterministic docs/assets/readme/*.webp screenshots
// from the PRODUCTION build (vite preview). Docs utility, NOT npm test. Seeds deterministic
// demo state (fixture PDFs + mocked AI TOC), captures 1440x900 desktop and 390x844 mobile.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'fs'
import { openChapterBuilderForSource } from './chapter-entry.mjs'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const OUT = 'docs/assets/readme'
const PREFIX = 'v200-'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async (page) => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
const shot = async (page, name) => { const file = PREFIX + name; await page.screenshot({ path: OUT + '/' + file, type: 'webp' }); console.log('shot ' + file) }

// Import two fixture PDFs so the library has real, deterministic content.
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await page.waitForTimeout(500)
await shot(page, '00-app-shell.webp')
await page.locator('[data-testid="sidebar-entry-prompts"]').first().click()
await page.locator('[data-testid="prompt-manager"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(500)
await shot(page, '11-prompt-manager.webp')
await page.locator('[data-testid="prompt-manager-close"]').click()
await page.waitForTimeout(400)
await openLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(400)
await openLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-tricky.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(400)
await openLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/no-outline.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(400)

// 01 — Reader (TOC sidebar + page). The desktop TOC sidebar is always visible.
await openLibrary(page)
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.waitForTimeout(500)
await shot(page, '01-reader-context.webp')

// 03 — Document Context Picker (scoped to the outline-sample doc).
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary(page)
const contextCards = await page.locator('[data-testid^="doc-card-"]').all()
let contextCard = null
for (const card of contextCards) {
  if ((await card.textContent()).toLowerCase().includes('outline-sample.pdf')) { contextCard = card; break }
}
if (!contextCard) throw new Error('README capture: outline-sample.pdf card not found')
await contextCard.locator('[data-testid^="doc-context-"]').click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="doc-context-tree"]').waitFor({ state: 'visible', timeout: 5000 })
const firstCheck = page.locator('[data-testid^="doc-context-check-"]:not([disabled])').first()
if (await firstCheck.count()) await firstCheck.click()
await page.waitForTimeout(400)
await shot(page, '03-document-context-picker.webp')
await page.locator('[data-testid="doc-context-cancel"]').click()
await page.waitForTimeout(300)

// 02 — Document Library.
await openLibrary(page)
await page.waitForTimeout(500)
await shot(page, '02-document-library.webp')

// 04 — AI TOC review (mock seam, no paid API).
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.evaluate(() => { (globalThis).__dshMockAiToc = (req) => {
  if (req.phase === 'structure') return '{"levels":[1,1,2]}'
  return '{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n' +
    '{"title":"第二章 自然地理","pageLabel":"3","sourceImageIndex":2,"visualIndent":0,"numbering":"第二章"}\n' +
    '{"title":"2.1 地形","pageLabel":"3","sourceImageIndex":2,"visualIndent":1,"numbering":"2.1"}'
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
// Select a deterministic page range (so 开始识别 is enabled).
await page.locator('[data-testid="toc-picker-range-start"]').fill('1')
await page.locator('[data-testid="toc-picker-range-end"]').fill('2')
await page.locator('[data-testid="toc-picker-range-apply"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(400)
await shot(page, '04-ai-toc-review.webp')
await page.locator('[data-testid="toc-review-close"]').click()
await page.waitForTimeout(300)

// 05 — Chapter Editor. Open a doc WITHOUT a native outline and use its empty-TOC entry.
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary(page)
// Find the no-outline card by name to open it deterministically.
const docs = await page.locator('[data-testid^="doc-card-"]').all()
let opened = false
for (const card of docs) {
  const txt = (await card.textContent()).toLowerCase()
  if (txt.indexOf('no-outline') >= 0) {
    await card.locator('[data-testid^="doc-open-"]').click()
    opened = true
    break
  }
}
if (!opened) await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await openChapterBuilderForSource(page, 'none')
for (let index = 0; index < 8; index++) {
  await page.locator('[data-testid="cb-add"]').click()
  await page.locator('[data-testid="cb-title-' + index + '"]').fill('章节 ' + String(index + 1).padStart(2, '0'))
}
await page.locator('[data-testid="cb-select-1"]').check()
await page.keyboard.down('Shift')
await page.locator('[data-testid="cb-select-4"]').click()
await page.keyboard.up('Shift')
await page.locator('[data-testid="cb-bulk-set-2"]').click()
await page.waitForTimeout(300)
await shot(page, '05-chapter-editor.webp')
await page.locator('[data-testid="cb-cancel"]').click()
await page.waitForTimeout(200)
// Cancelling an edited builder shows the discard-confirm dialog.
if (await page.locator('[data-testid="cb-discard-confirm"]').count()) {
  await page.locator('[data-testid="cb-discard-yes"]').click()
  await page.waitForTimeout(200)
}
await page.waitForTimeout(300)

// 06 — Settings / BYOK.
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="sidebar-settings"]').first().click()
await page.locator('[data-testid="settings-byok"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(500)
await shot(page, '06-settings-byok.webp')
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(400)

// 08 — Dark mode (reader in dark, TOC visible).
await page.locator('[data-testid="sidebar-settings"]').first().click()
await page.locator('[data-testid="settings-appearance"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="appearance-dark"]').click()
await page.waitForTimeout(600)
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(400)
await openLibrary(page)
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.waitForTimeout(500)
await shot(page, '08-dark-mode.webp')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// reset to light for the mobile shot.
await page.locator('[data-testid="sidebar-settings"]').first().click()
await page.locator('[data-testid="settings-appearance"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="appearance-light"]').click()
await page.waitForTimeout(400)
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(300)

// 07 — Mobile reader (390x844).
const mpage = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
await mpage.goto(BASE, { waitUntil: 'networkidle' })
await mpage.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await mpage.waitForTimeout(500)
await mpage.locator('[data-testid="rail-history"]').click()
await mpage.locator('[data-testid="mobile-history-drawer"]').waitFor({ state: 'visible', timeout: 10000 })
await mpage.waitForTimeout(300)
await shot(mpage, '09-mobile-history-drawer.webp')
await mpage.locator('[data-testid="mobile-history-drawer"] [data-testid="sidebar-collapse"]').click()
await mpage.waitForTimeout(300)
await shot(mpage, '10-mobile-rail.webp')
await openLibrary(mpage)
// Mobile has its own empty store; import a doc so the reader has content.
await mpage.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
await mpage.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await mpage.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await mpage.waitForTimeout(500)
await shot(mpage, '07-mobile.webp')

await browser.close()
console.log('DONE');
