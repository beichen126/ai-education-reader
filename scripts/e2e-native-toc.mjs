// Native TOC override e2e (Windows/local, REAL Microsoft Edge): native outline -> 整理目录
// -> override to manual -> save -> restore original native outline; plus cancel + failure.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const NATIVE = 'test/fixtures/outline-sample.pdf'
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
const tocTexts = () => page.locator('[data-testid^="reader-chapter-"]').allTextContents()

// --- import native-outline pdf ---
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NATIVE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 0, 'A: native doc has non-empty TOC')
assert(await page.locator('[data-testid="reader-toc-organize"]').count() === 1, 'A: native doc shows 整理目录 button')
assert(await page.locator('[data-testid="reader-toc-restore"]').count() === 0, 'A: native doc shows NO restore button (already native)')
const nativeTitles = await tocTexts()
assert(nativeTitles.join('|').includes('Computer Organization'), 'A: shows native chapter title')

// --- 整理目录 -> builder opens with native draft + hint ---
await page.locator('[data-testid="reader-toc-organize"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-hint"]').count() === 1, 'B: builder shows 正在整理 PDF 原始目录 hint')
const firstTitle = await page.locator('[data-testid="cb-title-0"]').inputValue()
assert(firstTitle.includes('Computer Organization'), 'B: native title propagated into builder (got ' + firstTitle + ')')
const rowCount = await page.locator('[data-testid^="cb-row"]').count()
assert(rowCount >= 4, 'B: many native rows imported (got ' + rowCount + ')')

// --- override: rename + change a page, save ---
await page.locator('[data-testid="cb-title-0"]').fill('绪论 地球')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'C: reader stays open after override save')
const postOverride = await tocTexts()
assert(postOverride.join('|').includes('绪论 地球'), 'C: TOC shows overridden title (got ' + postOverride.join('|') + ')')
assert(await page.locator('[data-testid="reader-toc-edit"]').count() === 1, 'C: override shows 编辑目录')
assert(await page.locator('[data-testid="reader-toc-restore"]').count() === 1, 'C: override shows 恢复原始目录 (native present)')
assert(await page.locator('[data-testid="reader-toc-organize"]').count() === 0, 'C: override hides 整理目录 (no longer native)')

// --- restore original native outline (confirm) ---
await page.locator('[data-testid="reader-toc-restore"]').click()
await page.locator('[data-testid="reader-restore-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-restore-yes"]').click()
await page.locator('[data-testid="reader-restore-confirm"]').waitFor({ state: 'detached', timeout: 10000 })
await page.waitForTimeout(600)
const restored = await tocTexts()
assert(restored.join('|').includes('Computer Organization') && !restored.join('|').includes('绪论 地球'), 'D: restored native title from PDF (got ' + restored.join('|') + ')')
assert(await page.locator('[data-testid="reader-toc-organize"]').count() === 1, 'D: back to native -> 整理目录 shown again')

// --- cancel restore keeps manual tree ---
await page.locator('[data-testid="reader-toc-organize"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-title-0"]').fill('再改一次')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const manualBeforeCancel = await tocTexts()
await page.locator('[data-testid="reader-toc-restore"]').click()
await page.locator('[data-testid="reader-restore-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-restore-no"]').click()
await page.waitForTimeout(400)
const manualAfterCancel = await tocTexts()
assert(manualAfterCancel.join('|') === manualBeforeCancel.join('|'), 'E: cancel restore leaves manual tree unchanged (got ' + manualAfterCancel.join('|') + ')')

// --- restore failure (test seam) keeps manual tree + shows error ---
await page.evaluate(() => { (window).__dshFailNextNativeRestore = true })
await page.locator('[data-testid="reader-toc-restore"]').click()
await page.locator('[data-testid="reader-restore-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-restore-yes"]').click()
await page.locator('[data-testid="reader-toc-restore-msg"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="reader-toc-restore-msg"]').count() === 1, 'F: restore failure shows error message')
const afterFail = await tocTexts()
assert(afterFail.join('|').includes('再改一次'), 'F: failed restore keeps manual tree (got ' + afterFail.join('|') + ')')
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'F: reader still readable after failed restore')

// --- manual-only (no native) PDF shows 编辑目录 but NOT 恢复原始目录 ---
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/no-outline.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-toc-create"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('唯 手动章')
await page.locator('[data-testid="cb-page-0"]').fill('1')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
assert(await page.locator('[data-testid="reader-toc-edit"]').count() === 1, 'G: manual-only shows 编辑目录')
assert(await page.locator('[data-testid="reader-toc-restore"]').count() === 0, 'G: manual-only shows NO 恢复原始目录')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
const failCount = results.filter(r => r.startsWith('FAIL')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed' + (failCount ? ' (' + failCount + ' failed)' : ''))
process.exit(failCount === 0 ? 0 : 1)
