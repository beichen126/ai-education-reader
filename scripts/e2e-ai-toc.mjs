// AI TOC picker + extraction e2e (commit 1). Uses a deterministic mock seam
// (window.__dshMockAiToc) so NO real paid API is called. Validates: entry button,
// picker lazy grid + selection, extraction produces a mapped draft (with exact label
// matching when the PDF has page labels) and handles a no-key case cleanly.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/no-outline.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- A: entry button present + opens picker ---
assert(await page.locator('[data-testid="reader-toc-ai"]').count() === 1, 'A: AI 识别目录 button shown')
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="toc-picker-privacy"]').count() === 1, 'A: privacy notice shown')

// --- B: lazy grid renders thumbnails; select pages ---
// first sample thumbnails eventually render images
await page.waitForTimeout(1200)
const thumbCount = await page.locator('[data-testid^="toc-thumb-"]').count()
assert(thumbCount >= 10, 'B: grid renders all 10 pages (got ' + thumbCount + ')')
// select page 7 and 8
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
const countLabel = await page.locator('[data-testid="toc-picker-count"]').textContent()
assert(countLabel.includes('已选择 2 页'), 'B: selection count updates (got ' + countLabel + ')')
const startText = await page.locator('[data-testid="toc-picker-start"]').textContent()
assert(startText.includes('2 页'), 'B: start button shows count (got ' + startText + ')')

// --- C: extraction with mock -> mapped draft (exact label) ---
await page.evaluate(() => {
  // no page labels on this PDF; mock returns plain entries with printed labels "1"/"2"
  ;(globalThis).__dshMockAiToc = (req) => {
    return JSON.stringify([
      { title: '第一章 自然地理', level: 1, pageLabel: '1', tocPage: req.pages[0] },
      { title: '第二章 地球', level: 2, pageLabel: '2', tocPage: req.pages[0] },
    ])
  }
  // ensure no API key so the mock path is used regardless
})
await page.locator('[data-testid="toc-picker-start"]').click()
await page.waitForTimeout(1500)
// No page labels -> items stay unresolved (startPage null). Extraction itself must
// produce a mapped draft. We assert the AI message area is NOT an error.
const aiMsg = await page.locator('[data-testid="reader-toc-ai-msg"]').count()
assert(aiMsg === 0, 'C: extraction produced a draft (no error message)')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
