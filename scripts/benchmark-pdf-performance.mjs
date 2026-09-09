// Stage 6 PDF benchmark. This deliberately prints raw samples and summary stats
// instead of writing a benchmark/report artifact into the repository.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchBrowser } from './e2e-browser.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const SAMPLES = Number(process.env.PDF_PERF_SAMPLES || 10)
const fixtureRoot = 'test/.playwright/pdf-performance'
const fixtures = [
  { key: 'small', file: fixtureRoot + '/small-8.pdf', pages: 8 },
  { key: 'medium', file: fixtureRoot + '/medium-100.pdf', pages: 100 },
  { key: 'large', file: fixtureRoot + '/large-520.pdf', pages: 520 },
]
for (const fixture of fixtures) {
  if (!existsSync(fixture.file)) {
    const result = spawnSync(process.execPath, ['scripts/make-outline-pdf.mjs', fixture.file, String(fixture.pages)], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('failed to generate ' + fixture.file)
  }
}

const results = []
const pageErrors = []
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}
const summary = values => ({
  n: values.length,
  median: Number(median(values).toFixed(2)),
  p95: Number(percentile(values, 0.95).toFixed(2)),
  min: Number(Math.min(...values).toFixed(2)),
  max: Number(Math.max(...values).toFixed(2)),
})

async function waitForApp(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
  await openDocumentLibrary(page)
}

async function importFixture(page, fixture) {
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture.file)
  for (let i = 0; i < 80; i++) {
    if (await page.locator('[data-testid="document-reader"]').count()) break
    if (await page.locator('[data-testid="import-conflict"]').count()) break
    await page.waitForTimeout(250)
  }
  if (await page.locator('[data-testid="import-conflict"]').count()) {
    await page.locator('[data-testid="duplicate-import-copy"]').click()
  }
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[data-testid="reader-close"]').click()
  await openDocumentLibrary(page)
}

async function docIdFor(page, fixture) {
  const button = page.locator('[data-testid^="doc-open-"]').filter({ hasText: fixture.file.split('/').pop() }).first()
  await button.waitFor({ state: 'visible', timeout: 10000 })
  return (await button.getAttribute('data-testid')).slice('doc-open-'.length)
}

async function latestRun(page, documentId, surface) {
  return page.evaluate(({ documentId: id, surface: target }) => {
    const runs = window.__dshPdfTelemetry || []
    return [...runs].reverse().find(run => run.documentId === id && run.surface === target) || null
  }, { documentId, surface })
}

function assertOutlineAfterPixel(run, fixture) {
  const firstPixel = run.phases['first-pixel-ready']
  const outline = run.phases['outline-ready']
  if (firstPixel !== undefined && outline !== undefined && outline < firstPixel) {
    throw new Error('outline blocked first-pixel for ' + fixture.key + ': ' + JSON.stringify(run.phases))
  }
}

async function openReaderSample(page, fixture, documentId, cold) {
  if (cold) {
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
    await openDocumentLibrary(page)
  }
  const button = page.locator('[data-testid="doc-open-' + documentId + '"]')
  const beforeRuns = await page.evaluate(id => (window.__dshPdfTelemetry || []).filter(run => run.documentId === id && run.surface === 'reader').length, documentId)
  const clickAt = performance.now()
  await button.click()
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 20000 })
  const shell = performance.now() - clickAt
  await page.waitForFunction(({ id, count }) => (window.__dshPdfTelemetry || []).filter(run => run.documentId === id && run.surface === 'reader' && run.phases['first-pixel-ready'] !== undefined).length > count, { id: documentId, count: beforeRuns }, { timeout: 60000 })
  const run = await latestRun(page, documentId, 'reader')
  if (!run) throw new Error('reader telemetry missing for ' + fixture.key)
  assertOutlineAfterPixel(run, fixture)
  const firstPixel = run.phases['first-pixel-ready']
  await page.locator('[data-testid="reader-close"]').click()
  await openDocumentLibrary(page)
  return { shell, firstPixel, phases: run.phases }
}

async function previewSample(page, fixture, documentId) {
  const beforeRuns = await page.evaluate(id => (window.__dshPdfTelemetry || []).filter(run => run.documentId === id && run.surface === 'preview').length, documentId)
  await page.locator('[data-testid="doc-context-' + documentId + '"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="doc-context-whole"]').click()
  await page.locator('[data-testid="doc-context-preview"]').click()
  await page.locator('[data-testid="doc-context-preview-view"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForFunction(({ id, count }) => (window.__dshPdfTelemetry || []).filter(run => run.documentId === id && run.surface === 'preview' && run.phases['first-pixel-ready'] !== undefined).length > count, { id: documentId, count: beforeRuns }, { timeout: 60000 })
  const run = await latestRun(page, documentId, 'preview')
  if (!run) throw new Error('preview telemetry missing for ' + fixture.key)
  const firstPixel = run.phases['first-pixel-ready']
  await page.locator('[data-testid="doc-context-preview-back"]').click()
  await page.locator('[data-testid="doc-context-cancel2"]').click()
  await openDocumentLibrary(page)
  return { firstPixel, phases: run.phases }
}

async function runCase({ mode, storage, viewport, deviceScaleFactor }) {
  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport, deviceScaleFactor })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(mode + '/' + storage + '/' + viewport.width + ': ' + error.message))
  await page.addInitScript(({ mode: perfMode, fallback }) => {
    window.__dshEnablePdfTelemetry = true
    window.__dshPdfTelemetry = []
    window.__dshPdfPerformanceMode = perfMode
    window.__dshForceIdbBinaryFallback = fallback
  }, { mode, fallback: storage === 'idb-fallback' })
  await waitForApp(page)
  for (const fixture of fixtures) await importFixture(page, fixture)

  for (const fixture of fixtures) {
    const documentId = await docIdFor(page, fixture)
    const warmup = await openReaderSample(page, fixture, documentId, false)
    const cold = []
    for (let i = 0; i < SAMPLES; i++) cold.push(await openReaderSample(page, fixture, documentId, true))
    const warm = []
    for (let i = 0; i < SAMPLES; i++) warm.push(await openReaderSample(page, fixture, documentId, false))
    for (const [kind, samples] of [['cold', cold], ['warm', warm]]) {
      const firstPixels = samples.map(sample => sample.firstPixel)
      const shells = samples.map(sample => sample.shell)
      const group = { mode, storage, viewport: viewport.width + 'x' + viewport.height + '@' + deviceScaleFactor, fixture: fixture.key, kind, warmupFirstPixel: Number(warmup.firstPixel.toFixed(2)), firstPixel: summary(firstPixels), shell: summary(shells), rawFirstPixel: firstPixels.map(value => Number(value.toFixed(2))) }
      results.push(group)
      console.log('GROUP', JSON.stringify(group))
    }
  }

  const previewFixture = fixtures[1]
  const previewId = await docIdFor(page, previewFixture)
  const previewWarmup = await previewSample(page, previewFixture, previewId)
  const previews = []
  for (let i = 0; i < SAMPLES; i++) previews.push(await previewSample(page, previewFixture, previewId))
  const previewPixels = previews.map(sample => sample.firstPixel)
  const previewGroup = { mode, storage, viewport: viewport.width + 'x' + viewport.height + '@' + deviceScaleFactor, fixture: previewFixture.key, kind: 'reader-preview', warmupFirstPixel: Number(previewWarmup.firstPixel.toFixed(2)), firstPixel: summary(previewPixels), rawFirstPixel: previewPixels.map(value => Number(value.toFixed(2))) }
  results.push(previewGroup)
  console.log('GROUP', JSON.stringify(previewGroup))
  await context.close()
  await browser.close()
}

// The full suite covers OPFS/IDB fallback and desktop/mobile DPR=1/2. Set
// PDF_PERF_QUICK=1 only for a local smoke run; release evidence uses the default.
const cases = process.env.PDF_PERF_QUICK === '1'
  ? [{ mode: 'split', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }]
  : process.env.PDF_PERF_SPLIT_ONLY === '1'
    ? [
        { mode: 'split', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
        { mode: 'split', storage: 'idb-fallback', viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 },
      ]
  : process.env.PDF_PERF_OPFS_ONLY === '1'
    ? [
        { mode: 'legacy', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
        { mode: 'split', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
      ]
  : [
      { mode: 'legacy', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
      { mode: 'split', storage: 'opfs', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
      { mode: 'legacy', storage: 'idb-fallback', viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 },
      { mode: 'split', storage: 'idb-fallback', viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 },
    ]

for (const testCase of cases) await runCase(testCase)
console.log('PDF_PERFORMANCE_SUMMARY ' + JSON.stringify(results))
console.log('PAGEERRORS: ' + (pageErrors.length ? pageErrors.join(' | ') : '(none)'))
if (pageErrors.length) process.exitCode = 1
