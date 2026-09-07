// Stage G3 focused browser gate: chapter search and Shift range selection.
import { chromium } from 'playwright-core'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const LONG_PDF = 'test/fixtures/many-pages.pdf'
const results = []
const pageErrors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => pageErrors.push(error.message))

const levels = async () => page.locator('[data-testid^="cb-level-"]').evaluateAll(elements => elements.map(element => element.value))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="document-library"] input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(LONG_PDF)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

  // Build a 60-row same-page directory in one local draft. Same-page siblings
  // are valid and keep this gate focused on editor navigation, not PDF paging.
  await page.locator('[data-testid="reader-toc-create"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  for (let index = 0; index < 60; index++) {
    await page.locator('[data-testid="cb-add"]').click()
    const title = index === 10 ? '第二章 目标章节' : '章节 ' + String(index + 1).padStart(2, '0')
    await page.locator('[data-testid="cb-title-' + index + '"]').fill(title)
  }
  assert(await page.locator('[data-testid="cb-row"]').count() === 60, 'G3: long directory contains at least 60 rows')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="cb-row"]').count() === 60, 'G3: reopening keeps all long-directory rows')

  // Search filters only the view and still edits the canonical row.
  const search = page.locator('[data-testid="cb-search"]')
  await search.fill('第二章')
  assert(await page.locator('[data-testid="cb-row"]').count() === 1, 'G3: title search filters the visible view to one match')
  assert((await page.locator('[data-testid="cb-visible-count"]').textContent()).includes('显示 1 / 60'), 'G3: search count reports visible versus total rows')
  await page.locator('[data-testid="cb-title-10"]').fill('第二章 已编辑')
  await search.fill('')
  assert(await page.locator('[data-testid="cb-title-10"]').inputValue() === '第二章 已编辑', 'G3: filtered title edit updates the canonical item')

  // In a filtered view, select-all means exactly the visible result.
  await search.fill('第二章')
  await page.locator('[data-testid="cb-clear-selection"]').click()
  assert((await page.locator('[data-testid="cb-select-all"]').textContent()).includes('全选当前结果'), 'G3: filtered toolbar names visible-result selection explicitly')
  await page.locator('[data-testid="cb-select-all"]').click()
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 1 项', 'G3: filtered select-all selects only the visible result')
  await page.locator('[data-testid="cb-clear-selection"]').click()

  // Shift-click uses current visible order and includes both endpoints.
  await search.fill('')
  await page.locator('[data-testid="cb-select-10"]').check()
  await page.keyboard.down('Shift')
  await page.locator('[data-testid="cb-select-20"]').click()
  await page.keyboard.up('Shift')
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 11 项', 'G3: Shift-click selects rows 10 through 20 inclusive')
  const selectedRange = await page.locator('input[data-testid^="cb-select-"]').evaluateAll(elements => elements.map((element, index) => element.checked ? index : -1).filter(index => index >= 0))
  assert(selectedRange.join(',') === '10,11,12,13,14,15,16,17,18,19,20', 'G3: range selection contains exactly both endpoints and interior rows')

  await page.locator('[data-testid="cb-bulk-set-2"]').click()
  const afterBulk = await levels()
  assert(afterBulk.slice(10, 21).every(level => level === '2') && afterBulk.slice(0, 10).every(level => level === '1') && afterBulk.slice(21).every(level => level === '1'), 'G3: selected range can be batch-set without changing hidden rows')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  const reopenedLevels = await levels()
  assert(reopenedLevels.slice(10, 21).every(level => level === '2'), 'G3: range levels persist after save and reopen')
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 0 项', 'G3: selection state is transient and is not persisted')

  // An invalid batch remains a local draft and cannot be saved away.
  await page.locator('[data-testid="cb-select-0"]').check()
  await page.locator('[data-testid="cb-bulk-set-2"]').click()
  await page.locator('[data-testid="cb-error"]').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('[data-testid="cb-save"]').click()
  assert(await page.locator('[data-testid="chapter-builder"]').count() === 1, 'G3: invalid batch is blocked by canonical validation')
  assert(await page.locator('[data-testid="cb-level-0"]').inputValue() === '2', 'G3: invalid draft remains visible instead of being discarded')
  await page.locator('[data-testid="cb-level-0"]').selectOption('1')
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
