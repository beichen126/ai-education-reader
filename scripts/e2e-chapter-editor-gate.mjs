// Stage G4 release gate: chapter editor desktop workflow plus mobile layout.
// This is intentionally self-contained so Pages can run it with bundled Chromium.
import { chromium } from 'playwright-core'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const LONG_PDF = 'test/fixtures/many-pages.pdf'
const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium')
const results = []
const pageErrors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const launchOptions = { headless: true }
if (channel && channel !== 'chromium') launchOptions.channel = channel
const browser = await chromium.launch(launchOptions)
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => pageErrors.push(error.message))

const levels = async () => page.locator('[data-testid^="cb-level-"]').evaluateAll(elements => elements.map(element => element.value))
const noHorizontalOverflow = async () => page.evaluate(() => {
  const panel = document.querySelector('[data-testid="chapter-builder"] > div')
  const width = window.innerWidth
  return {
    document: document.documentElement.scrollWidth <= width,
    body: document.body.scrollWidth <= width,
    panel: !panel || panel.scrollWidth <= panel.clientWidth,
    toolbar: (() => {
      const element = document.querySelector('[data-testid="cb-bulk-toolbar"]')
      if (!element) return false
      const box = element.getBoundingClientRect()
      return box.left >= 0 && box.right <= width + 1
    })(),
  }
})

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="document-library"] input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(LONG_PDF)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

  // Build the minimum long-directory fixture required by the UX task.
  await page.locator('[data-testid="reader-toc-create"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  for (let index = 0; index < 60; index++) {
    await page.locator('[data-testid="cb-add"]').click()
    const title = index === 10 ? '第二章 目标章节' : '章节 ' + String(index + 1).padStart(2, '0')
    await page.locator('[data-testid="cb-title-' + index + '"]').fill(title)
  }
  assert(await page.locator('[data-testid="cb-row"]').count() === 60, 'G4: release gate creates 60-row directory')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="cb-bulk-toolbar"]').isVisible(), 'G4: bulk toolbar is accessible on desktop')

  const search = page.locator('[data-testid="cb-search"]')
  await search.fill('第二章')
  assert(await page.locator('[data-testid="cb-row"]').count() === 1, 'G4: search filters the long directory')
  await page.locator('[data-testid="cb-clear-selection"]').click()
  await page.locator('[data-testid="cb-select-all"]').click()
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 1 项', 'G4: filtered select-all does not select hidden rows')
  await page.locator('[data-testid="cb-clear-selection"]').click()

  await search.fill('')
  await page.locator('[data-testid="cb-select-10"]').check()
  await page.keyboard.down('Shift')
  await page.locator('[data-testid="cb-select-20"]').click()
  await page.keyboard.up('Shift')
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 11 项', 'G4: Shift range includes both endpoints')
  await page.locator('[data-testid="cb-bulk-set-2"]').click()
  const changed = await levels()
  assert(changed.slice(10, 21).every(level => level === '2') && changed.slice(0, 10).every(level => level === '1') && changed.slice(21).every(level => level === '1'), 'G4: range batch level operation preserves unselected rows')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  assert((await levels()).slice(10, 21).every(level => level === '2'), 'G4: batch result persists after reopen')
  assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 0 项', 'G4: selection is not persisted')

  // Invalid first-level batch must leave the draft open and intact.
  await page.locator('[data-testid="cb-select-0"]').check()
  await page.locator('[data-testid="cb-bulk-set-2"]').click()
  await page.locator('[data-testid="cb-error"]').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('[data-testid="cb-save"]').click()
  assert(await page.locator('[data-testid="chapter-builder"]').count() === 1, 'G4: canonical validation blocks invalid bulk save')
  assert(await page.locator('[data-testid="cb-level-0"]').inputValue() === '2', 'G4: invalid draft is not discarded')
  await page.locator('[data-testid="cb-level-0"]').selectOption('1')
  await page.locator('[data-testid="cb-clear-selection"]').click()

  // The same editor must remain usable at all required mobile widths.
  for (const [width, height] of [[375, 812], [390, 844], [412, 915]]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(100)
    const metrics = await noHorizontalOverflow()
    assert(metrics.document && metrics.body && metrics.panel && metrics.toolbar, `G4: ${width}x${height} has no horizontal overflow and toolbar fits`)
    await page.locator('[data-testid="cb-select-10"]').scrollIntoViewIfNeeded()
    await page.locator('[data-testid="cb-select-10"]').check()
    assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 1 项', `G4: ${width}x${height} checkbox is operable`)
    await page.keyboard.press('Escape')
    assert(await page.locator('[data-testid="cb-selected-count"]').textContent() === '已选 0 项', `G4: ${width}x${height} Escape clears selection without closing`)
  }
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
