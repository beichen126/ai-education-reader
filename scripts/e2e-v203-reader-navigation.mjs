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
await page.setViewportSize({ width: 390, height: 844 })
await page.locator('[data-testid="reader-toc-toggle"]').click()
const tocBack = page.locator('[data-testid="reader-toc-back"]')
assert(await tocBack.count() === 1 && await tocBack.isVisible().catch(() => false), 'TOC drawer exposes a visible 返回阅读 action')
assert(await tocBack.getAttribute('aria-label').catch(() => null) === '返回阅读', '返回阅读 has an accessible name')
if (await tocBack.count()) {
  await tocBack.click()
  assert(await page.locator('[data-testid="document-reader"]').count() === 1, '返回阅读 closes only the TOC drawer and keeps Reader open')
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
