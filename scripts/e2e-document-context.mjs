// Document -> Context e2e (Stage 9.5, Part 0.7): library card "加入对话" -> picker -> parent
// chapter -> added to the active conversation draft. Uses a real doc with a native outline.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }

// import a doc with a native outline
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// library card has 加入对话
await openLibrary()
const card = page.locator('[data-testid^="doc-card-"]').first()
assert(await card.count() === 1, 'library shows the imported doc card')
const joinBtn = page.locator('[data-testid^="doc-context-"]').first()
assert(await joinBtn.count() === 1, 'library card exposes 加入对话')

// open picker scoped to the doc (no document-pick stage)
await joinBtn.click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="doc-context-doclist"]').count() === 0, 'picker scoped to the selected doc (no document list)')

// select the first selectable chapter node and add
const f = page.locator('[data-testid^="doc-context-check-"]:not([disabled])').first()
assert(await f.count() >= 1, 'picker tree exposes selectable chapters')
await f.click()
await page.locator('[data-testid="doc-context-add"]').click()
// may hit a soft confirm for >30 pages
if (await page.locator('[data-testid="doc-context-confirm"]').count()) {
  // click continue
  await page.locator('[data-testid="doc-context-confirm-yes"]').click()
}
await page.waitForTimeout(1500)
// a success or progress message should appear
const msg = await page.locator('[data-testid="library-ctx-msg"], [data-testid="library-ctx-progress"]').count()
assert(msg >= 1, 'context addition produced a message/overlay')

// Back in library after add (no duplicate document count change)
await page.waitForTimeout(500)
await openLibrary()
assert(await page.locator('[data-testid^="doc-card-"]').count() === 1, 'Document count unchanged (no duplicate)')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
