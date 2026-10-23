import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'
process.env.E2E_BASE ||= 'http://127.0.0.1:5173/ai-education-reader/'
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } })
  let patchedWorkers = 0
  await context.addInitScript(() => { delete globalThis.Iterator; delete Blob.prototype.arrayBuffer; delete Promise.withResolvers })
  // Built worker bundles have their own global Promise. Simulate WV114 there,
  // not merely in the window, so a main-thread-only workaround cannot pass.
  await context.route(/pdf-worker-entry-[^/?]+\.js(?:\?|$)/, async route => {
    const response = await route.fetch()
    patchedWorkers++
    await route.fulfill({ response, body: 'delete Promise.withResolvers;\n' + await response.text() })
  })
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
  if (process.env.E2E_REQUIRE_BUILT_WORKER === '1') assert.ok(patchedWorkers > 0, 'Built PDF worker must be tested with Promise.withResolvers removed')
  await page.screenshot({ path: 'test-results/webview-pdf-compat.png' })
  console.log(`PASS: PDF import and rendering without Iterator, Blob.arrayBuffer or Promise.withResolvers; patched built workers: ${patchedWorkers}`)
  await context.close()
} finally { await browser.close() }
