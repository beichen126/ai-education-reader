// Stage 2 browser gate: real continuous PDF scrolling with a virtualized, bounded DOM.
// The stack keeps two spacers plus at most 11 mounted page sections (at most 7 canvases)
// for 500 / 2000 / 10000 page documents; page turns are driven by the real wheel, and the
// restored page survives close/reopen. Run against a fresh production preview with E2E_BASE.
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchBrowser } from './e2e-browser.mjs'
import { openDocumentLibrary, dismissProductGuide } from './e2e-navigation.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'

const fixtures = {
  500: 'test/.playwright/continuous-500.pdf',
  2000: 'test/.playwright/continuous-2000.pdf',
  10000: 'test/.playwright/continuous-10000.pdf',
}
for (const [pages, file] of Object.entries(fixtures)) {
  if (existsSync(file)) continue
  mkdirSync('test/.playwright', { recursive: true })
  const generated = spawnSync(process.execPath, ['scripts/make-outline-pdf.mjs', file, pages], { stdio: 'inherit' })
  if (generated.status !== 0) throw new Error('failed to generate ' + file)
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const mountedCount = () => page.locator('[data-testid^="reader-continuous-page-"][data-page-number]').count()
const canvasCount = () => page.locator('[data-testid^="reader-continuous-canvas-"]').count()
const currentPageValue = async () => (await page.locator('[data-testid="reader-page-input"]').inputValue().catch(() => '')).trim()
const waitForCurrentPage = async expected => {
  await page.waitForFunction(value => document.querySelector('[data-testid="reader-page-input"]')?.value.trim() === value, String(expected), { timeout: 30000 })
}
const safe = async (fn, fallback = null) => { try { return await fn() } catch { return fallback } }
const assertBounded = async label => {
  // Settle the first window before measuring: the stack legitimately starts empty for a
  // frame. A window that never mounts still fails below (measured 0).
  await safe(() => page.waitForFunction(() => document.querySelectorAll('[data-testid^="reader-continuous-page-"][data-page-number]').length >= 1, null, { timeout: 30000 }))
  await safe(() => page.waitForFunction(() => document.querySelectorAll('[data-testid^="reader-continuous-canvas-"]').length >= 1, null, { timeout: 45000 }))
  const mounted = await safe(() => mountedCount(), 0)
  const canvases = await safe(() => canvasCount(), 0)
  assert(mounted >= 1 && mounted <= 11, label + ': mounted page sections bounded (' + mounted + ')')
  assert(canvases >= 1 && canvases <= 7, label + ': canvas window bounded (' + canvases + ')')
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await dismissProductGuide(page)

// ---- choose continuous through the real user path (no generic save click) ----
await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="pdf-navigation-continuous"]').click()
await page.keyboard.press('Escape')

const openFixture = async file => {
  await openDocumentLibrary(page)
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(file)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[data-testid="reader-viewport"]').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('[data-testid="reader-continuous-scroll"]').waitFor({ state: 'visible', timeout: 60000 })
}
const backToLibrary = async () => {
  await page.locator('[data-testid="reader-back"]').click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="library-close"]').click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'hidden', timeout: 10000 })
}

// ---- A. 500 pages: virtualized stack, real wheel scrolling, jump to the end ----
await openFixture(fixtures[500])
assert(await page.locator('[data-testid="reader-viewport"]').getAttribute('data-pdf-navigation-mode') === 'continuous', 'Reader enters continuous mode')
try {
  await page.locator('[data-testid^="reader-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 60000 })
} catch (error) {
  const diagnostics = await page.evaluate(() => ({
    mode: document.querySelector('[data-testid="reader-viewport"]')?.getAttribute('data-pdf-navigation-mode'),
    pages: document.querySelectorAll('[data-testid^="reader-continuous-page-"][data-page-number]').length,
    canvases: document.querySelectorAll('[data-testid^="reader-continuous-canvas-"]').length,
    top: document.querySelector('[data-testid="reader-continuous-top-spacer"]')?.getAttribute('style') ?? null,
    loading: document.querySelector('[data-testid="reader-loading"]')?.textContent ?? null,
  }))
  console.error('continuous initial diagnostics:', JSON.stringify(diagnostics))
  throw error
}
const stackPageCount = await mountedCount()
assert(stackPageCount <= 11, '500-page stack mounts at most 11 page sections, not 500 (got ' + stackPageCount + ')')
assert(await page.locator('[data-testid="reader-continuous-top-spacer"]').count() === 1, 'the stack has a top spacer')
assert(await page.locator('[data-testid="reader-continuous-bottom-spacer"]').count() === 1, 'the stack has a bottom spacer')
await assertBounded('500 pages initial')

let peakCanvases = await safe(() => canvasCount(), 0)
let peakMounted = stackPageCount
const trackPeak = async () => {
  peakCanvases = Math.max(peakCanvases, await safe(() => canvasCount(), 0))
  peakMounted = Math.max(peakMounted, await safe(() => mountedCount(), 0))
}

// Real wheel input (not scrollIntoView): scroll far enough to cross many pages.
for (let step = 0; step < 12; step++) {
  await page.mouse.move(720, 500)
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(120)
  await trackPeak()
}
await page.waitForTimeout(600)
const afterWheel = Number(await currentPageValue())
assert(afterWheel > 1, 'real wheel scrolling advances the current page (' + afterWheel + ')')
assert(peakMounted <= 11 && peakCanvases <= 11, 'wheel scrolling keeps the DOM bounded (peak ' + peakMounted + ' sections / ' + peakCanvases + ' canvases)')
await assertBounded('after wheel scrolling')

// TOC / page input jump to the end.
await page.locator('[data-testid="reader-page-input"]').fill('500')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
const reachedEnd = await safe(async () => { await waitForCurrentPage(500); return true }, false)
assert(reachedEnd === true, 'the page input jumps to page 500')
await safe(() => page.locator('[data-testid="reader-continuous-canvas-500"]').waitFor({ state: 'visible', timeout: 30000 }))
await assertBounded('page 500')
const bottomSpacerStyle = await safe(() => page.locator('[data-testid="reader-continuous-bottom-spacer"]').getAttribute('style'), null)
assert(typeof bottomSpacerStyle === 'string' && bottomSpacerStyle.includes('0px'), 'the last page leaves no bottom spacer')

// Jump back near the start (rapid 500 -> 3) and zoom the clicked page.
await page.locator('[data-testid="reader-page-input"]').fill('3')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
const reachedStart = await safe(async () => { await waitForCurrentPage(3); return true }, false)
assert(reachedStart === true, 'the page input jumps back to page 3')
const zoomed = await safe(async () => {
  await page.locator('[data-testid="reader-continuous-page-button-3"]').click({ timeout: 15000 })
  await page.locator('[data-testid="viewer-image"]').waitFor({ state: 'visible', timeout: 30000 })
  return true
}, false)
assert(zoomed === true, 'the mounted page 3 can be opened in the zoom viewer')
if (zoomed) {
  assert((await page.locator('[data-testid="viewer-image"]').getAttribute('alt')) === 'PDF 第 3 页', 'Reader zoom is bound to the clicked continuous page')
  await page.keyboard.press('Escape')
}

// Close and reopen: the page is restored.
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 30000 })
const restored = await safe(async () => { await waitForCurrentPage(3); return true }, false)
assert(restored === true, 'continuous current page survives close and reopen')
await assertBounded('reopen at page 3')

// ---- B. Preview shares the mode and stays bounded ----
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-context-"]').first().click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
const wholeSelection = page.locator('[data-testid="doc-context-whole"]')
if (await wholeSelection.isEnabled()) await wholeSelection.click()
else await page.locator('[data-testid^="doc-context-check-"]').first().check()
await page.locator('[data-testid="doc-context-preview"]').click()
await page.locator('[data-testid="doc-context-preview-view"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="doc-context-preview-continuous-scroll"]').waitFor({ state: 'visible', timeout: 30000 })
await safe(() => page.locator('[data-testid^="doc-context-preview-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 30000 }))
assert(await page.locator('[data-testid="doc-context-preview-stage"]').getAttribute('data-pdf-navigation-mode') === 'continuous', 'Context Preview shares continuous mode')
const previewMounted = await page.locator('[data-testid^="doc-context-preview-continuous-page-"][data-page-number]').count()
const previewCanvases = await page.locator('[data-testid^="doc-context-preview-continuous-canvas-"]').count()
assert(previewMounted <= 11, 'Preview mounts at most 11 page sections (' + previewMounted + ')')
assert(previewCanvases >= 1 && previewCanvases <= 7, 'Preview canvas window bounded (' + previewCanvases + ')')
await page.setViewportSize({ width: 375, height: 812 })
await page.waitForTimeout(300)
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), '375px continuous Preview has no horizontal overflow')
await page.setViewportSize({ width: 1440, height: 900 })
await page.locator('[data-testid="doc-context-preview-back"]').click()
await page.locator('[data-testid="doc-context-cancel"]').click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'hidden', timeout: 10000 })
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="library-close"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'hidden', timeout: 10000 })
assert(errors.length === 0, 'continuous Reader/Preview produced no page errors or unhandled rejections')

// ---- C. 2000 / 10000 page documents keep the same hard bounds ----
for (const pages of [2000, 10000]) {
  await openFixture(fixtures[pages])
  let peak = 0
  let peakCanvas = 0
  for (let step = 0; step < 8; step++) {
    await page.mouse.move(720, 500)
    await page.mouse.wheel(0, 2500)
    await page.waitForTimeout(100)
    peak = Math.max(peak, await mountedCount())
    peakCanvas = Math.max(peakCanvas, await canvasCount())
  }
  await page.waitForTimeout(400)
  assert(peak <= 11, pages + ' pages: mounted sections stay ≤ 11 while scrolling (peak ' + peak + ')')
  assert(peakCanvas <= 7, pages + ' pages: canvases stay ≤ 7 while scrolling (peak ' + peakCanvas + ')')
  const target = pages
  await page.locator('[data-testid="reader-page-input"]').fill(String(target))
  await page.locator('[data-testid="reader-page-input"]').press('Enter')
  const jumped = await safe(async () => { await waitForCurrentPage(target); return true }, false)
  assert(jumped === true, pages + ' pages: the page input reaches the last page')
  await safe(() => page.locator('[data-testid="reader-continuous-canvas-' + target + '"]').waitFor({ state: 'visible', timeout: 60000 }))
  await assertBounded(pages + ' pages at the end')
  await backToLibrary()
}

console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
