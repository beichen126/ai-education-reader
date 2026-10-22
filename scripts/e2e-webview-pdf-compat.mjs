import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'
process.env.E2E_BASE ||= 'http://127.0.0.1:5173/ai-education-reader/'
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } })
  await context.addInitScript(() => { delete globalThis.Iterator })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await seedAndBoot(page, {})
  try { await openDocumentLibrary(page) } catch (error) {
    console.error('Browser errors:', errors)
    throw error
  }
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
  await page.getByTestId('document-reader').waitFor({ timeout: 40000 })
  await page.getByTestId('reader-page-img').waitFor({ state: 'visible', timeout: 30000 })
  assert.equal(errors.length, 0, errors.join('\n'))
  await page.screenshot({ path: 'test-results/webview-pdf-compat.png' })
  console.log('PASS: library import, outline and real PDF page rendering without global Iterator')
  await context.close()
} finally { await browser.close() }
