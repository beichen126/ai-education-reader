// Stage G2 focused browser gate: multi-select and atomic bulk level editing.
import { chromium } from 'playwright-core'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const NO_OUTLINE = 'test/fixtures/no-outline.pdf'
const results = []
const pageErrors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => pageErrors.push(error.message))

const jumpTo = async (pageNumber) => {
  await page.locator('[data-testid="reader-page-input"]').fill(String(pageNumber))
  await page.locator('[data-testid="reader-page-input"]').press('Enter')
  await page.waitForTimeout(250)
}
const inputValues = locator => locator.evaluateAll(elements => elements.map(element => element.value))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="document-library"] input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(NO_OUTLINE)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

  // Create four top-level rows to exercise stable-id multi-selection.
  await page.locator('[data-testid="reader-toc-create"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="cb-add"]').click()
  await page.locator('[data-testid="cb-title-0"]').fill('第一章')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
  for (const [pageNumber, title] of [[2, '第二章'], [3, '第三章'], [4, '第四章']]) {
    await jumpTo(pageNumber)
    await page.locator('[data-testid="reader-build"]').click()
    await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('[data-testid="cb-title-0"]').fill(title)
    await page.locator('[data-testid="cb-save"]').click()
    await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
  }

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  const toolbar = page.locator('[data-testid="cb-bulk-toolbar"]')
  assert(await toolbar.count() === 1, 'G2: bulk toolbar is present')
  assert(await toolbar.evaluate(el => getComputedStyle(el).position) === 'sticky', 'G2: bulk toolbar is sticky')

  await page.locator('[data-testid="cb-select-level-1"]').click()
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 4 项', 'G2: select current L1 selects all four rows')
  await page.locator('[data-testid="cb-clear-selection"]').click()
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 0 项', 'G2: clear selection removes all selected ids')

  const titlesBefore = await inputValues(page.locator('[data-testid^="cb-title-"]'))
  const pagesBefore = await inputValues(page.locator('[data-testid^="cb-page-"]'))
  for (const index of [1, 2, 3]) await page.locator('[data-testid="cb-select-' + index + '"]').check()
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 3 项', 'G2: three stable-id rows are selected')
  await page.locator('[data-testid="cb-bulk-set-2"]').click()
  assert((await page.locator('[data-testid^="cb-level-"]').evaluateAll(els => els.map(el => el.value))).join(',') === '1,2,2,2', 'G2: set selected rows to L2 in one operation')
  assert((await inputValues(page.locator('[data-testid^="cb-title-"]'))).join('|') === titlesBefore.join('|'), 'G2: bulk level edit preserves all titles')
  assert((await inputValues(page.locator('[data-testid^="cb-page-"]'))).join('|') === pagesBefore.join('|'), 'G2: bulk level edit preserves all start pages')

  await page.locator('[data-testid="cb-bulk-outdent"]').click()
  assert((await page.locator('[data-testid^="cb-level-"]').evaluateAll(els => els.map(el => el.value))).join(',') === '1,1,1,1', 'G2: bulk decrease applies to every selected row')
  await page.locator('[data-testid="cb-bulk-indent"]').click()
  assert((await page.locator('[data-testid^="cb-level-"]').evaluateAll(els => els.map(el => el.value))).join(',') === '1,2,2,2', 'G2: bulk increase applies to every selected row')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  assert((await page.locator('[data-testid^="cb-level-"]').evaluateAll(els => els.map(el => el.value))).join(',') === '1,2,2,2', 'G2: batch result persists after reopen')

  // A boundary failure is atomic: selecting L1 + L2 and decreasing must change nothing.
  await page.locator('[data-testid="cb-select-0"]').check()
  await page.locator('[data-testid="cb-select-1"]').check()
  await page.locator('[data-testid="cb-bulk-outdent"]').click()
  assert(await page.locator('[data-testid="cb-bulk-error"]').count() === 1, 'G2: invalid batch boundary shows an explicit error')
  assert((await page.locator('[data-testid^="cb-level-"]').evaluateAll(els => els.map(el => el.value))).join(',') === '1,2,2,2', 'G2: invalid batch leaves every selected row unchanged')

  await page.locator('[data-testid="cb-select-2"]').check()
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 0 项', 'G2: Escape clears selection without closing the editor')
  assert(await page.locator('[data-testid="chapter-builder"]').count() === 1, 'G2: Escape with selection keeps the editor open')
  await page.locator('[data-testid="cb-cancel"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
} catch (error) {
  console.error(error)
  results.push('FAIL  fatal browser error: ' + (error instanceof Error ? error.message : String(error)))
} finally {
  await browser.close()
}

console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (pageErrors.length ? pageErrors.join(' | ') : '(none)'))
const passed = results.filter(result => result.startsWith('PASS')).length
const failed = results.filter(result => result.startsWith('FAIL')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed' + (failed ? ' (' + failed + ' failed)' : ''))
process.exit(failed === 0 && pageErrors.length === 0 ? 0 : 1)
