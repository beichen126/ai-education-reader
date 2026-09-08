// AI TOC picker + review + save e2e (commit 1+2). Uses a deterministic mock seam
// (window.__dshMockAiToc) so NO real paid API is called. Validates the full chain:
// picker -> extraction -> review (jump/continue/adjust) -> save to 'ai-toc' -> TOC.
import { chromium } from 'playwright-core'
import { openChapterBuilderForSource } from './chapter-entry.mjs'
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
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshStructureCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, attempt: req.attempt, repair: req.repair })
  if (req.phase === 'structure') {
    (globalThis).__dshStructureCalls.push({ attempt: req.attempt, repair: req.repair, diagnostics: req.diagnostics })
    return req.repair ? '{"levels":[1,1]}' : '{"levels":[1]}'
  }
  const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 };
  return '{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":' + si(req.pages[0]) + ',"visualIndent":0,"numbering":"第一章"}\n' +
    '{"title":"第二章 地球","pageLabel":"2","sourceImageIndex":' + si(req.pages[1]) + ',"visualIndent":0,"numbering":"第二章"}'
} })
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
assert(await page.locator('[data-testid="toc-review-progress"]').count() === 1, 'B: review opens with progress')
const itemCount = await page.locator('[data-testid^="toc-review-item-"]').count()
assert(itemCount === 2, 'B: review lists 2 items (got ' + itemCount + ')')
const structureCalls = await page.evaluate(() => (globalThis).__dshStructureCalls)
assert(structureCalls.length === 2, 'B1: structure repair uses exactly one retry (got ' + structureCalls.length + ')')
assert(structureCalls[0].repair === false && structureCalls[1].repair === true, 'B1: second structure request is marked as repair')
assert(structureCalls[1].diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'B1: repair request carries count-mismatch diagnostics')
const allCalls = await page.evaluate(() => (globalThis).__dshAllCalls)
assert(allCalls.filter(c => c.phase === 'transcribe').length === 1, 'B1: repair does not rerun successful Vision transcription')

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

// --- F: a failed repair returns no partial draft and does not rerun Vision ---
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshStructureCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, attempt: req.attempt, repair: req.repair })
  if (req.phase === 'structure') {
    (globalThis).__dshStructureCalls.push({ attempt: req.attempt, repair: req.repair, diagnostics: req.diagnostics })
    return '{"levels":[1]}'
  }
  const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 };
  return '{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":' + si(req.pages[0]) + '}\n' +
    '{"title":"第二章 地球","pageLabel":"2","sourceImageIndex":' + si(req.pages[1]) + '}'
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="toc-thumb-7"]').click()
await page.locator('[data-testid="toc-thumb-8"]').click()
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="ai-toc-progress-error"]').waitFor({ state: 'visible', timeout: 20000 })
assert(await page.locator('[data-testid="toc-review"]').count() === 0, 'F: failed repair opens no partial review draft')
assert((await page.locator('[data-testid="ai-toc-progress-error"]').textContent()).includes('层级数量'), 'F: final failure explains the structure count mismatch')
const failedStructureCalls = await page.evaluate(() => (globalThis).__dshStructureCalls)
assert(failedStructureCalls.length === 2 && failedStructureCalls[1].repair === true, 'F: failed repair stops after exactly one repair attempt')
const failedAllCalls = await page.evaluate(() => (globalThis).__dshAllCalls)
assert(failedAllCalls.filter(c => c.phase === 'transcribe').length === 1, 'F: failed repair does not rerun Vision transcription')
assert(await page.locator('[data-testid^="reader-chapter-"]').count() === 2, 'F: failed repair leaves the previously saved TOC unchanged')

// --- G: abort stops extraction without retry or opening a partial review ---
await page.locator('[data-testid="ai-toc-progress-close"]').click()
await page.evaluate(() => { (globalThis).__dshAllCalls = []; (globalThis).__dshMockAiToc = (req) => {
  (globalThis).__dshAllCalls.push({ phase: req.phase, attempt: req.attempt, repair: req.repair })
  if (req.phase === 'structure') return '{"levels":[1,1]}'
  return '{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":1}\n' +
    '{"title":"第二章 地球","pageLabel":"2","sourceImageIndex":2}'
} })
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
const abortThumbs = page.locator('[data-testid^="toc-thumb-"]')
const abortThumbCount = await abortThumbs.count()
for (let i = 0; i < abortThumbCount; i++) await abortThumbs.nth(i).click()
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="ai-toc-progress-cancel"]').click({ timeout: 20000 })
await page.locator('[data-testid="ai-toc-progress-error"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="ai-toc-progress-error"]').textContent()).includes('已取消'), 'G: abort reports cancellation')
assert(await page.locator('[data-testid="toc-review"]').count() === 0, 'G: abort opens no review draft')
const abortedCalls = await page.evaluate(() => (globalThis).__dshAllCalls)
assert(abortedCalls.filter(c => c.repair === true).length === 0, 'G: abort never starts a repair attempt')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
