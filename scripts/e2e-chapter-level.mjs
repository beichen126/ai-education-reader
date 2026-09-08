// Stage G1 focused browser gate: direct chapter level editing.
// Uses one isolated browser context and one PDF so duplicate-import behavior
// cannot obscure the direct-level workflow being tested here.
import { chromium } from 'playwright-core'
import { openChapterBuilderForSource } from './chapter-entry.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const NO_OUTLINE = 'test/fixtures/no-outline.pdf'
const results = []
const pageErrors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => pageErrors.push(error.message))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  const fileInput = page.locator('[data-testid="document-library"] input[type="file"][accept=".pdf,application/pdf"]')
  await fileInput.waitFor({ state: 'attached', timeout: 25000 })
  await fileInput.setInputFiles(NO_OUTLINE)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

  // Seed two top-level rows so changing the second row to L2 is structurally valid.
  await page.locator('[data-testid="reader-toc-create"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="cb-add"]').click()
  await page.locator('[data-testid="cb-title-0"]').fill('第一章')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-page-input"]').fill('8')
  await page.locator('[data-testid="reader-page-input"]').press('Enter')
  await page.waitForTimeout(300)
  await openChapterBuilderForSource(page, 'manual', { addCurrentPage: true })
  await page.locator('[data-testid="cb-title-0"]').fill('第二章')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  const firstLevel = page.locator('[data-testid="cb-level-0"]')
  const secondLevel = page.locator('[data-testid="cb-level-1"]')
  const titleBefore = await page.locator('[data-testid="cb-title-1"]').inputValue()
  const pageBefore = await page.locator('[data-testid="cb-page-1"]').inputValue()
  assert(await firstLevel.count() === 1 && await secondLevel.count() === 1, 'G1: each row exposes a direct level selector')
  assert(await secondLevel.locator('option').count() === 8, 'G1: selector follows MAX_CHAPTER_LEVEL (8 options)')

  // Direct editing can express an invalid structure, but canonical save validation blocks it.
  await firstLevel.selectOption('3')
  await page.locator('[data-testid="cb-save"]').click()
  assert(await page.locator('[data-testid="cb-error"]').count() === 1, 'G1: invalid direct level is blocked by canonical validation')
  assert(await page.locator('[data-testid="chapter-builder"]').count() === 1, 'G1: invalid direct level keeps the draft open')
  await firstLevel.selectOption('1')
  await page.waitForFunction(() => document.querySelector('[data-testid="cb-level-0"]')?.value === '1')

  await secondLevel.selectOption('2')
  await page.waitForFunction(() => document.querySelector('[data-testid="cb-level-1"]')?.value === '2')
  assert(await secondLevel.inputValue() === '2', 'G1: direct selector changes the target row to L2')
  assert(await page.locator('[data-testid="cb-title-1"]').inputValue() === titleBefore, 'G1: direct level edit preserves title')
  assert(await page.locator('[data-testid="cb-page-1"]').inputValue() === pageBefore, 'G1: direct level edit preserves start page')
  await page.locator('[data-testid="cb-save"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

  // Reopen proves the saved level is durable, then restore the fixture for a clean exit.
  await page.locator('[data-testid="reader-toc-edit"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="cb-level-1"]').inputValue() === '2', 'G1: saved L2 survives editor reopen')
  assert(await page.locator('[data-testid="cb-title-1"]').inputValue() === titleBefore, 'G1: reopened title remains unchanged')
  assert(await page.locator('[data-testid="cb-page-1"]').inputValue() === pageBefore, 'G1: reopened start page remains unchanged')
  await page.locator('[data-testid="cb-level-1"]').selectOption('1')
  await page.locator('[data-testid="cb-save"]').click()
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
