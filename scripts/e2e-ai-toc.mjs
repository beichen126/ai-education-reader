// AI TOC picker + review + save e2e (commit 1+2). Uses a deterministic mock seam
// (window.__dshMockAiToc) so NO real paid API is called. Validates the full chain:
// picker -> extraction -> review (jump/continue/adjust) -> save to 'ai-toc' -> TOC.
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
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- A: entry + picker + select pages ---
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(1000)
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
assert((await page.locator('[data-testid="toc-picker-start"]').textContent()).includes('2 页'), 'A: picker shows selected count')

// --- B: extraction (mock) -> review opens ---
await page.evaluate(() => { (globalThis).__dshMockAiToc = (req) => JSON.stringify([
  { title: '第一章 自然地理', level: 1, pageLabel: '1', tocPage: req.pages[0] },
  { title: '第二章 地球', level: 1, pageLabel: '2', tocPage: req.pages[0] },
]) })
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
assert(await page.locator('[data-testid="toc-review-progress"]').count() === 1, 'B: review opens with progress')
const itemCount = await page.locator('[data-testid^="toc-review-item-"]').count()
assert(itemCount === 2, 'B: review lists 2 items (got ' + itemCount + ')')

// --- C: click first item -> jump (unresolved -> stays; assign page then jump) ---
await page.locator('[data-testid="toc-review-title"]').fill('第一章 自然地理')
await page.locator('[data-testid="toc-review-page"]').fill('5')
await page.locator('[data-testid="toc-review-ok-0"]').click()
// advance to item 1, set its page too
await page.locator('[data-testid="toc-review-next"]').click()
await page.locator('[data-testid="toc-review-title"]').fill('第二章 地球')
await page.locator('[data-testid="toc-review-page"]').fill('8')
await page.locator('[data-testid="toc-review-ok-1"]').click()

// --- D: save (all resolved + valid) ---
await page.locator('[data-testid="toc-review-save"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'detached', timeout: 10000 })
await page.waitForTimeout(600)
const toc = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(toc.join('|').includes('第一章 自然地理') && toc.join('|').includes('第二章 地球'), 'D: TOC shows ai-toc chapters (got ' + toc.join('|') + ')')
// current page preserved (was 1 before save)
assert((await inputVal()).trim() === '1', 'D: reader page unchanged after ai-toc save (got ' + await inputVal() + ')')

// --- E: context uses the new ai-toc tree (no special branch) ---
assert(await page.locator('[data-testid="reader-toc-edit"]').count() === 1, 'E: ai-toc tree shows 编辑目录')
const restoreBtn = await page.locator('[data-testid="reader-toc-restore"]').count()
// no-outline has no native outline -> no restore button
assert(restoreBtn === 0, 'E: manual/ai-toc PDF without native outline shows no 恢复原始目录')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
