// Stage 8 browser gate: real continuous PDF scrolling with bounded canvas window.
// Run against a fresh production preview with E2E_BASE, or through test:release.
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchBrowser } from './e2e-browser.mjs'
import { openDocumentLibrary, dismissProductGuide } from './e2e-navigation.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const fixture = 'test/.playwright/continuous-500.pdf'

if (!existsSync(fixture)) {
  mkdirSync('test/.playwright', { recursive: true })
  const generated = spawnSync(process.execPath, ['scripts/make-outline-pdf.mjs', fixture, '500'], { stdio: 'inherit' })
  if (generated.status !== 0) throw new Error('failed to generate continuous scroll fixture')
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await dismissProductGuide(page)

await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="pdf-navigation-continuous"]').click()
await page.getByRole('button', { name: '保存', exact: true }).click()
await page.keyboard.press('Escape')
await openDocumentLibrary(page)

await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 60000 })
try {
  await page.locator('[data-testid^="reader-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 60000 })
} catch (error) {
  const diagnostics = await page.evaluate(() => ({
    mode: document.querySelector('[data-testid="reader-viewport"]')?.getAttribute('data-pdf-navigation-mode'),
    pages: document.querySelectorAll('[data-testid^="reader-continuous-page-"][data-page-number]').length,
    canvases: document.querySelectorAll('[data-testid^="reader-continuous-canvas-"]').length,
    loading: document.querySelector('[data-testid="reader-loading"]')?.textContent ?? null,
    error: document.querySelector('[data-testid="reader-page-error"]')?.textContent ?? null,
  }))
  console.error('continuous initial diagnostics:', JSON.stringify(diagnostics))
  throw error
}

const mountedCount = async () => page.locator('[data-testid^="reader-continuous-page-"][data-mounted="true"]').count()
const canvasCount = async () => page.locator('[data-testid^="reader-continuous-canvas-"]').count()
const assertBounded = async label => {
  const mounted = await mountedCount()
  const canvases = await canvasCount()
  assert(mounted <= 11 && canvases <= 11, `${label}: mounted page/canvas window bounded (${mounted}/${canvases})`)
  assert(mounted >= 1 && canvases >= 1, `${label}: at least one visible page is rendered`)
}

assert(await page.locator('[data-testid="reader-viewport"]').getAttribute('data-pdf-navigation-mode') === 'continuous', 'Reader enters continuous mode')
assert(await page.locator('[data-testid="reader-continuous-scroll"]').isVisible(), 'Reader exposes a continuous scroll region')
assert(await page.locator('[data-testid^="reader-continuous-page-"][data-page-number]').count() === 500, '500-page document keeps lightweight placeholders for all pages')
await assertBounded('initial page')

const scrollToPage = async pageNumber => {
  await page.locator(`[data-testid="reader-continuous-page-${pageNumber}"]`).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'auto' }))
  await page.waitForTimeout(700)
}

const waitForCurrentPage = async pageNumber => {
  await page.waitForFunction(expected => {
    const input = document.querySelector('[data-testid="reader-page-input"]')
    return input?.value.trim() === expected
  }, String(pageNumber), { timeout: 30000 })
}

await scrollToPage(100)
await page.locator('[data-testid="reader-continuous-canvas-100"]').waitFor({ state: 'visible', timeout: 30000 })
await waitForCurrentPage(100)
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '100', 'scroll center stabilizes current page at 100')
await assertBounded('page 100')
await page.locator('[data-testid="reader-continuous-page-button-100"]').click()
await page.locator('[data-testid="viewer-image"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="viewer-image"]').getAttribute('alt')) === 'PDF 第 100 页', 'Reader zoom is bound to the clicked continuous page 100')
await page.keyboard.press('Escape')

await scrollToPage(500)
await page.locator('[data-testid="reader-continuous-canvas-500"]').waitFor({ state: 'visible', timeout: 30000 })
await waitForCurrentPage(500)
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '500', 'scroll reaches the final page and updates current page')
await assertBounded('page 500')

await page.waitForTimeout(1200)
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-continuous-canvas-500"]').waitFor({ state: 'visible', timeout: 30000 })
await waitForCurrentPage(500)
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '500', 'continuous current page survives close and reopen')
await assertBounded('reopen at page 500')

await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-context-"]').first().click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
const wholeSelection = page.locator('[data-testid="doc-context-whole"]')
if (await wholeSelection.isEnabled()) await wholeSelection.click()
else await page.locator('[data-testid^="doc-context-check-"]').first().check()
await page.locator('[data-testid="doc-context-preview"]').click()
await page.locator('[data-testid="doc-context-preview-view"]').waitFor({ state: 'visible', timeout: 10000 })
try {
  await page.locator('[data-testid^="doc-context-preview-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 30000 })
} catch (error) {
  const diagnostics = await page.evaluate(() => ({
    mode: document.querySelector('[data-testid="doc-context-preview-stage"]')?.getAttribute('data-pdf-navigation-mode'),
    pages: document.querySelectorAll('[data-testid^="doc-context-preview-continuous-page-"][data-page-number]').length,
    canvases: document.querySelectorAll('[data-testid^="doc-context-preview-continuous-canvas-"]').length,
    loading: document.querySelector('[data-testid="doc-context-preview-loading"]')?.textContent ?? null,
    error: document.querySelector('[data-testid="doc-context-preview-error"]')?.textContent ?? null,
  }))
  console.error('continuous preview diagnostics:', JSON.stringify(diagnostics))
  throw error
}
assert(await page.locator('[data-testid="doc-context-preview-stage"]').getAttribute('data-pdf-navigation-mode') === 'continuous', 'Context Preview shares continuous mode')
assert(await page.locator('[data-testid^="doc-context-preview-continuous-page-"][data-page-number]').count() === 500, 'Preview keeps lightweight placeholders for all pages')
const previewMounted = await page.locator('[data-testid^="doc-context-preview-continuous-page-"][data-mounted="true"]').count()
const previewCanvases = await page.locator('[data-testid^="doc-context-preview-continuous-canvas-"]').count()
assert(previewMounted <= 11 && previewCanvases <= 11, `Preview mounted window bounded (${previewMounted}/${previewCanvases})`)
await page.locator('[data-testid="doc-context-preview-continuous-page-button-2"]').click()
await page.locator('[data-testid="viewer-image"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="viewer-image"]').getAttribute('alt')) === 'PDF 第 2 页', 'Context Preview zoom is bound to the clicked continuous page 2')
await page.keyboard.press('Escape')

await page.setViewportSize({ width: 375, height: 812 })
await page.waitForTimeout(300)
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), '375px continuous Preview has no horizontal overflow')
await page.locator('[data-testid="doc-context-preview-back"]').click()
assert(errors.length === 0, 'continuous Reader/Preview produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
