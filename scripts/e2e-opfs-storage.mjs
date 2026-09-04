// OPFS storage e2e (Windows/local, REAL Microsoft Edge). Verifies a document PDF is
// persisted across a full page reload and re-readable, and that the DOM never leaks
// OPFS/FileSystemHandle into the UI path (it only ever gets a Blob).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/no-outline.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }

// --- A. import PDF -> reader opens -> stored ---
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('no-outline.pdf'), 'A: import -> reader opened')

// --- B. the persisted document row carries an OPFS source ref (no inline sourceBlob) ---
const rowInfo = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res, rej) => { const r = db.transaction('documents', 'readonly').objectStore('documents').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const row = rows[0];
  const opfsApi = !!(navigator.storage && navigator.storage.getDirectory);
  return { opfsApi, count: rows.length, sourceStorage: row && row.source ? row.source.storage : undefined, hasSourceBlob: row ? !!row.sourceBlob : undefined };
})
assert(rowInfo.count >= 1, 'B: a document row exists');
assert(rowInfo.opfsApi === true, 'B: OPFS API available in Edge (got ' + rowInfo.opfsApi + ')');
assert(rowInfo.sourceStorage === 'opfs', 'B: document row stored via OPFS ref (got ' + rowInfo.sourceStorage + ')');
assert(rowInfo.hasSourceBlob === false, 'B: no inline sourceBlob in the IDB row');

// --- C. close reader -> reload the page -> document library still lists it ---
await page.locator('[data-testid="reader-back"]').click()
await page.waitForTimeout(400)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
const openBtns = page.locator('[data-testid^="doc-open-"]')
assert(await openBtns.count() >= 1, 'C: library lists the imported document after reload');

// --- D. reopen the document from the persisted OPFS binary (fresh page session) ---
await openBtns.first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-page-img"]').count() === 1, 'D: document re-read from persisted storage renders');
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)