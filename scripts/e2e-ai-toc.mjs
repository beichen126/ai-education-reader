// AI TOC picker + review + save e2e (commit 1+2). Uses a deterministic mock seam
// (window.__dshMockAiToc) so NO real paid API is called. Validates the full chain:
// picker -> extraction -> review (jump/continue/adjust) -> save to 'ai-toc' -> TOC.
import { chromium } from 'playwright-core'
import { openChapterBuilderForSource } from './chapter-entry.mjs'
import { dismissProductGuide } from './e2e-navigation.mjs'
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
await dismissProductGuide(page)
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
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, attempt: req.attempt, repair: req.repair })
  const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 };
  return '{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":' + si(req.pages[0]) + ',"level":1,"visualIndent":0,"numbering":"第一章"}\n' +
    '{"title":"第二章 地球","pageLabel":"2","sourceImageIndex":' + si(req.pages[1]) + ',"level":1,"visualIndent":0,"numbering":"第二章"}'
} })
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
assert(await page.locator('[data-testid="toc-review-progress"]').count() === 1, 'B: review opens with progress')
const itemCount = await page.locator('[data-testid^="toc-review-item-"]').count()
assert(itemCount === 2, 'B: review lists 2 items (got ' + itemCount + ')')
assert(await page.locator('[data-testid="toc-review-invalid"]').count() === 0, 'B: missing PDF PageLabels are not misreported as two content corrections')
assert((await page.locator('[data-testid="toc-review-calibration-needed"]').textContent()).includes('不需要逐条修正 2 项'), 'B: unresolved numeric labels explain that only one calibration is needed')
await page.locator('[data-testid="toc-review-start-calibration"]').click()
await page.waitForFunction(() => document.querySelector('[data-testid="reader-page-input"]')?.value === '7')
assert((await inputVal()).trim() === '7', 'B: calibration action jumps to the PDF outline page containing the unresolved row')
const allCalls = await page.evaluate(() => (globalThis).__dshAllCalls)
assert(allCalls.length === 1 && allCalls[0].phase === 'outline', 'B1: the whole outline uses one model request')

// --- B2 (finding 8): blocking continue STAYS on the current unresolved row ---
// First row is unresolved (page 待确认) -> continueReview must NOT advance.
await page.locator('[data-testid="toc-review-next"]').click()
await page.waitForTimeout(300)
const activeState0 = await page.locator('[data-testid="toc-review-item-0"]').getAttribute('data-state')
assert(activeState0 !== 'verified', 'B2: blocking continue does NOT mark the unresolved row verified')
const active0 = await page.locator('[data-testid="toc-review-item-0"]').evaluate(el => el.className)
assert(active0.includes('active'), 'B2: blocking continue STAYS on the current (unresolved) row')

// --- C: click first item -> jump (unresolved -> stays; assign page then jump) ---
await page.locator('[data-testid="toc-review-title"]').fill('第一章 自然地理')
await page.locator('[data-testid="toc-review-page"]').fill('5')
await page.locator('[data-testid="toc-review-calibrate"]').click()
assert(await page.locator('[data-testid="toc-review-item-1"]').getAttribute('data-sp') === '6', 'C: one anchor maps the remaining numeric page labels automatically')
await page.locator('[data-testid="toc-review-ok-0"]').click()
// advance to item 1; its page was resolved by the single calibration
await page.locator('[data-testid="toc-review-next"]').click()
await page.locator('[data-testid="toc-review-title"]').fill('第二章 地球')
await page.locator('[data-testid="toc-review-ok-1"]').click()

// --- D: save (all resolved + valid) ---
await page.locator('[data-testid="toc-review-save"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'detached', timeout: 10000 })
await page.waitForTimeout(600)
const toc = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(toc.join('|').includes('第一章 自然地理') && toc.join('|').includes('第二章 地球'), 'D: TOC shows ai-toc chapters (got ' + toc.join('|') + ')')
// The last selected review row resolved to PDF page 6; saving preserves that useful location.
assert((await inputVal()).trim() === '6', 'D: reader stays on the page selected while reviewing (got ' + await inputVal() + ')')
const aiTocBack = page.locator('[data-testid="reader-toc-back"]')
assert(await aiTocBack.isVisible(), 'D: ai-toc exposes 返回阅读')
await aiTocBack.click()
await page.locator('[data-testid="reader-toc"]').waitFor({ state: 'hidden', timeout: 5000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'D: ai-toc 返回阅读 keeps Reader open')
await page.locator('[data-testid="reader-toc-toggle"]').click()
await page.locator('[data-testid="reader-toc"]').waitFor({ state: 'visible', timeout: 5000 })

// --- E: context uses the new ai-toc tree (no special branch) ---
assert(await page.locator('[data-testid="reader-toc-edit"]').count() === 1, 'E: ai-toc tree shows 编辑目录')
assert(await page.locator('[data-testid="reader-build"]').count() === 0, 'E: ai-toc tree has no reader-build entry')
await openChapterBuilderForSource(page, 'ai-toc')
assert(await page.locator('[data-testid="cb-add"]').count() === 1, 'E: ai-toc edit path keeps Builder current-page add')
await page.locator('[data-testid="cb-cancel"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const restoreBtn = await page.locator('[data-testid="reader-toc-restore"]').count()
// no-outline has no native outline -> no restore button
assert(restoreBtn === 0, 'E: manual/ai-toc PDF without native outline shows no 恢复原始目录')

// --- F: invalid hierarchy keeps the faithful transcription as a review draft ---
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, attempt: req.attempt, repair: req.repair })
  const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 };
  return '{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":' + si(req.pages[0]) + '}\n' +
    '{"title":"第二章 地球","pageLabel":"2","sourceImageIndex":' + si(req.pages[1]) + '}'
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
assert((await page.locator('[data-testid="toc-review-notice"]').textContent()).includes('层级未通过'), 'F: fallback review clearly asks the user to check hierarchy')
assert(await page.locator('[data-testid^="toc-review-item-"]').count() === 2, 'F: fallback preserves all transcribed rows')
const failedAllCalls = await page.evaluate(() => (globalThis).__dshAllCalls)
assert(failedAllCalls.length === 1, 'F: local hierarchy fallback does not request the model again')
assert(await page.locator('[data-testid^="reader-chapter-"]').count() === 2, 'F: opening fallback review leaves the previously saved TOC unchanged')

// --- G: invalid multi-page output reports an error after one request ---
await page.locator('[data-testid="toc-review-close"]').click()
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, pages: [...req.pages] })
  if (req.pages.length > 1) return '{"title":"invalid combined batch","pageLabel":"1"}'
  const page = req.pages[0]
  return '{"title":"Recovered page ' + page + '","pageLabel":"' + (page === 7 ? '1' : '2') + '","sourceImageIndex":1}'
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
await page.locator('[data-testid="toc-picker-start"]').click()
await page.getByTestId('ai-toc-progress-error').waitFor()
const invalidCalls = await page.evaluate(() => globalThis.__dshAllCalls)
assert(invalidCalls.length === 1 && invalidCalls[0].pages.length === 2, 'G: invalid output does not retry or split into further calls')
await page.getByTestId('ai-toc-progress-close').click()

// --- G2: an all-empty pageLabel response is a model failure ---
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, pages: [...req.pages] })
  return req.pages.map((_, i) => '{"title":"Missing label ' + (i + 1) + '","pageLabel":"","sourceImageIndex":' + (i + 1) + '}').join('\n')
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="ai-toc-progress-error"]').waitFor({ state: 'visible', timeout: 20000 })
assert((await page.locator('[data-testid="ai-toc-progress-error"]').textContent()).includes('pageLabel'), 'G2: all-empty page labels surface a specific field error')
assert(await page.locator('[data-testid="toc-review"]').count() === 0, 'G2: all-empty page labels never open a giant manual-correction review')
const emptyLabelCalls = await page.evaluate(() => globalThis.__dshAllCalls)
assert(emptyLabelCalls.length === 1, 'G2: missing labels never trigger another model request')
await page.getByTestId('ai-toc-progress-close').click()

await page.evaluate(() => {
  globalThis.__dshMockAiToc = () => JSON.stringify({ rows: [
    ['', '空页码前言'], ['1', '第一章'], ['', '无页码分节'], ['2', '下一节'],
    ...Array.from({ length: 20 }, (_, i) => ['2', '小节 ' + i]),
    ['A-1', '需要删除的附录'], ['', '空页码结尾'],
  ].map(([pageLabel, title]) => ({ pageLabel, title, sourceImageIndex: 1, level: 1 })) })
})
await page.getByTestId('reader-toc-ai').click()
await page.getByTestId('toc-thumb-7').click()
await page.getByTestId('toc-picker-start').click()
const review = page.getByTestId('toc-review')
await review.waitFor()
assert(await review.getByText(/空页码前言|空页码结尾/).count() === 0, 'H: blank front/back entries are omitted')
await review.getByTestId('toc-review-item-0').click()
await review.getByTestId('toc-review-page').fill('5')
await review.getByTestId('toc-review-calibrate').click()
assert(await review.getByTestId('toc-review-item-1').getAttribute('data-sp') === '6', 'H: interior blank uses the following item after calibration')
await page.setViewportSize({ width: 390, height: 844 })
const issue = review.getByTestId('toc-review-item-23')
await review.getByTestId('toc-review-locate-unresolved').click()
await page.waitForFunction(() => {
  const list = document.querySelector('[data-testid="toc-review-list"]')
  const issue = document.querySelector('[data-testid="toc-review-item-23"]')
  const bounds = list?.getBoundingClientRect()
  const row = issue?.getBoundingClientRect()
  return bounds && row && row.top >= bounds.top && row.bottom <= bounds.bottom && document.activeElement === issue
})
assert(await issue.getAttribute('aria-current') === 'true', 'H: locating an issue scrolls and highlights its row on mobile')
assert(!await review.getByTestId('toc-review-adjust').isVisible(), 'H: locating an issue leaves the mobile editor closed')
await issue.getByRole('button', { name: '删除目录项：需要删除的附录' }).click()
assert(await issue.count() === 0, 'H: the located issue can be deleted directly in the list')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
