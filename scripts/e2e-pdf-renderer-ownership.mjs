// Stage 2 browser gate: exactly one renderer owns the viewport at any moment.
// PDF telemetry is enabled explicitly for this run; the diagnostics counter is inert in
// production. In continuous mode the paged backend must see ZERO viewport reads and ZERO
// renders, and the other way round in paged mode.
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
  if (generated.status !== 0) throw new Error('failed to generate the ownership fixture')
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
await page.addInitScript(() => { window.__dshEnablePdfTelemetry = true })
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const resetCalls = () => page.evaluate(() => { window.__dshPdfRendererCalls = {}; window.__dshPdfRendererAttach = {} })
const calls = () => page.evaluate(() => ({ ...(window.__dshPdfRendererCalls || {}) }))
const attach = () => page.evaluate(() => ({ ...(window.__dshPdfRendererAttach || {}) }))
const activeRenderers = () => page.evaluate(() => [...(window.__dshPdfActiveRenderers || [])])
const count = (snapshot, key) => snapshot[key] ?? 0

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await dismissProductGuide(page)

const setMode = async mode => {
  await page.locator('[data-testid="sidebar-settings"]').click()
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="pdf-navigation-' + mode + '"]').click()
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'hidden', timeout: 10000 })
}
const openReader = async () => {
  await openDocumentLibrary(page)
  const reader = page.locator('[data-testid="document-reader"]')
  if (!(await reader.isVisible().catch(() => false))) {
    const existing = page.locator('[data-testid^="doc-open-"]').first()
    if (await existing.count()) await existing.click()
    else await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture)
  }
  await reader.waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[data-testid="reader-viewport"]').waitFor({ state: 'visible', timeout: 30000 })
}
const closeReader = async () => {
  await page.locator('[data-testid="reader-back"]').click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="library-close"]').click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'hidden', timeout: 10000 })
}
const scroll = async (delta, times = 6) => {
  for (let index = 0; index < times; index++) {
    await page.mouse.move(720, 500)
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(500)
}

// ---- continuous mode: the paged renderer must not be constructed or touch the PDF ----
await setMode('continuous')
await resetCalls()
await openReader()
await page.locator('[data-testid^="reader-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 60000 })
await scroll(1400)
const continuousCalls = await calls()
assert(count(continuousCalls, 'continuous:readViewport') > 0, 'continuous mode reads page viewports through the continuous renderer')
assert(count(continuousCalls, 'continuous:startRender') > 0, 'continuous mode renders through the continuous renderer')
assert(count(continuousCalls, 'paged:readViewport') === 0, 'continuous mode performs ZERO paged viewport reads (got ' + count(continuousCalls, 'paged:readViewport') + ')')
assert(count(continuousCalls, 'paged:startRender') === 0, 'continuous mode performs ZERO paged renders (got ' + count(continuousCalls, 'paged:startRender') + ')')
assert((await activeRenderers()).join(',') === 'continuous', 'only the continuous renderer is attached (got ' + (await activeRenderers()).join(',') + ')')
const continuousAttach = await attach()
assert(count(continuousAttach, 'paged:attach') === 0, 'continuous mode never even constructs the paged renderer (got ' + count(continuousAttach, 'paged:attach') + ')')
assert(await page.locator('[data-testid="reader-page-img"]').count() === 0, 'continuous mode has no paged canvas in the DOM')

// ---- the scroll hot path must not scan conversations / branches while 关于此页 is closed ----
await page.evaluate(() => {
  window.__dshIdbScans = {}
  const proto = IDBObjectStore.prototype
  if (!proto.__dshScanPatch) {
    const realGetAll = proto.getAll
    proto.getAll = function (...args) {
      if (this.name === 'conversations' || this.name === 'conversationBranches' || this.name === 'studyCards') {
        window.__dshIdbScans[this.name] = (window.__dshIdbScans[this.name] ?? 0) + 1
      }
      return realGetAll.apply(this, args)
    }
    proto.__dshScanPatch = true
  }
})
await scroll(1200, 4)
const scansWhileClosed = await page.evaluate(() => ({ ...window.__dshIdbScans }))
assert((scansWhileClosed.conversations ?? 0) === 0, 'scrolling scans ZERO conversations while 关于此页 is closed (got ' + (scansWhileClosed.conversations ?? 0) + ')')
assert((scansWhileClosed.conversationBranches ?? 0) === 0, 'scrolling scans ZERO branches while 关于此页 is closed (got ' + (scansWhileClosed.conversationBranches ?? 0) + ')')
assert((scansWhileClosed.studyCards ?? 0) === 0, 'scrolling scans ZERO study cards while 关于此页 is closed (got ' + (scansWhileClosed.studyCards ?? 0) + ')')

// Positive control: asking for the panel performs the query on demand.
await page.evaluate(() => { window.__dshIdbScans = {} })
await page.locator('[data-testid="reader-related-toggle"]').click()
await page.waitForTimeout(1200)
const scansWhenOpen = await page.evaluate(() => ({ ...window.__dshIdbScans }))
assert((scansWhenOpen.conversations ?? 0) >= 1, 'opening 关于此页 queries conversations on demand (got ' + (scansWhenOpen.conversations ?? 0) + ')')
await page.locator('[data-testid="reader-related-toggle"]').click()
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="reader-related-conversations"]').count() === 0, 'closing 关于此页 removes the panel')
await closeReader()

// ---- paged mode: the continuous renderer must not be constructed or touch the PDF ----
await setMode('paged')
await resetCalls()
await openReader()
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 60000 })
for (let step = 0; step < 4; step++) {
  await page.locator('[data-testid="reader-next"]').click()
  await page.waitForTimeout(400)
}
const pagedCalls = await calls()
assert(count(pagedCalls, 'paged:readViewport') > 0, 'paged mode reads page viewports through the paged renderer')
assert(count(pagedCalls, 'paged:startRender') > 0, 'paged mode renders through the paged renderer')
assert(count(pagedCalls, 'continuous:readViewport') === 0, 'paged mode performs ZERO continuous viewport reads (got ' + count(pagedCalls, 'continuous:readViewport') + ')')
assert(count(pagedCalls, 'continuous:startRender') === 0, 'paged mode performs ZERO continuous renders (got ' + count(pagedCalls, 'continuous:startRender') + ')')
assert((await activeRenderers()).join(',') === 'paged', 'only the paged renderer is attached (got ' + (await activeRenderers()).join(',') + ')')
const pagedAttach = await attach()
assert(count(pagedAttach, 'continuous:attach') === 0, 'paged mode never even constructs the continuous renderer (got ' + count(pagedAttach, 'continuous:attach') + ')')
assert(await page.locator('[data-testid="reader-continuous-scroll"]').count() === 0, 'paged mode has no continuous stack in the DOM')

// ---- repeated mode switches keep ownership exclusive and still produce a first pixel ----
for (let round = 0; round < 4; round++) {
  await closeReader()
  await setMode('continuous')
  await resetCalls()
  await openReader()
  await page.locator('[data-testid^="reader-continuous-canvas-"]').first().waitFor({ state: 'visible', timeout: 60000 })
  await scroll(900, 2)
  const afterSwitch = await calls()
  const afterSwitchAttach = await attach()
  assert(count(afterSwitch, 'paged:readViewport') === 0 && count(afterSwitch, 'paged:startRender') === 0, 'switch round ' + (round + 1) + ': continuous keeps the paged renderer idle')
  assert(count(afterSwitchAttach, 'paged:attach') === 0, 'switch round ' + (round + 1) + ': continuous never constructs the paged renderer')
  assert(count(afterSwitch, 'continuous:startRender') > 0, 'switch round ' + (round + 1) + ': continuous renders a first pixel')
  await closeReader()
  await setMode('paged')
  await resetCalls()
  await openReader()
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[data-testid="reader-next"]').click()
  await page.waitForTimeout(400)
  const afterPaged = await calls()
  const afterPagedAttach = await attach()
  assert(count(afterPaged, 'continuous:readViewport') === 0 && count(afterPaged, 'continuous:startRender') === 0, 'switch round ' + (round + 1) + ': paged keeps the continuous renderer idle')
  assert(count(afterPagedAttach, 'continuous:attach') === 0, 'switch round ' + (round + 1) + ': paged never constructs the continuous renderer')
  assert(count(afterPaged, 'paged:startRender') > 0, 'switch round ' + (round + 1) + ': paged renders a first pixel')
}
await closeReader()

assert(errors.length === 0, 'renderer ownership produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
