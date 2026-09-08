import { launchBrowser } from './e2e-browser.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openDocumentLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-context-"]').first().click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="doc-context-tree"]').waitFor({ state: 'visible', timeout: 10000 })

assert(await page.locator('[data-testid="doc-context-preview"]').count() === 1, 'context picker exposes an independent PDF 预览 action')
const firstNode = page.locator('[data-testid^="doc-context-node-"]').filter({ has: page.locator('input[type="checkbox"]:not([disabled])') }).first()
if (await firstNode.count()) {
  const checkbox = firstNode.locator('input[type="checkbox"]')
  await checkbox.click()
  const range = firstNode.locator('[data-testid^="doc-context-actual-"]')
  const rangeText = (await range.textContent()) || ''
  const optionTexts = await firstNode.locator('option').allTextContents()
  assert(optionTexts.every(text => !rangeText || !text.includes(rangeText)), 'range page text is rendered once, not duplicated inside select labels')
  const mode = firstNode.locator('select[data-testid^="doc-context-mode-"]')
  const box = await mode.boundingBox()
  assert(Boolean(box) && box.width <= 120, 'range mode select stays within the compact desktop width budget')
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
