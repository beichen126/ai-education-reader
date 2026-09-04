// OPFS migration e2e. Seeds LEGACY IDB rows (document.sourceBlob / attachment.blob inline) via
// a page.evaluate, reloads the app, lets the BACKGROUND migration turn them into OPFS refs,
// then verifies the persisted rows are OPFS-backed AND still hydrate correctly.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF_BUF = readFileSync('test/fixtures/no-outline.pdf')
const PDF_B64 = PDF_BUF.toString('base64')
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

// --- A. seed legacy IDB rows (no OPFS refs) ---
await page.evaluate(async (pdfB64) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  const put = (s, v) => new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(v); t.oncomplete = res; t.onerror = () => rej(t.error) });
  const pdfBytes = Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0));
  await put('documents', { id: 'legacy-doc-1', kind: 'pdf', fileName: 'legacy.pdf', mimeType: 'application/pdf', fileSize: pdfBytes.length, pageCount: pdfBytes.length ? 6 : 4, chapters: [], chapterSource: 'none', lastReadPage: 0, createdAt: Date.now(), updatedAt: Date.now(), sourceBlob: new Blob([pdfBytes], { type: 'application/pdf' }) });
  await put('attachments', { id: 'legacy-att-1', meta: { id: 'legacy-att-1', name: 'x.png', mimeType: 'image/png', size: 4, createdAt: Date.now(), updatedAt: Date.now() }, blob: new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' }) });
}, PDF_B64)
assert(true, 'A: legacy rows seeded');

// --- B. reload -> boot -> background migration ---
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const after = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  const g = (s, k) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  const doc = await g('documents', 'legacy-doc-1');
  const att = await g('attachments', 'legacy-att-1');
  return { docSource: doc?.source?.storage, docHasSourceBlob: !!doc?.sourceBlob, attBinary: att?.binary?.storage, attHasBlob: !!att?.blob };
})
assert(after.docSource === 'opfs', 'B: document migrated to OPFS ref (got ' + after.docSource + ')');
assert(after.docHasSourceBlob === false, 'B: document no longer has inline sourceBlob');
assert(after.attBinary === 'opfs', 'B: attachment migrated to OPFS ref (got ' + after.attBinary + ')');
assert(after.attHasBlob === false, 'B: attachment no longer has inline blob');

// --- C. the migrated document still opens/hydrates from OPFS ---
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid^="doc-open-"]').count() >= 1, 'C: migrated document listed in library');
await page.locator('[data-testid="document-library"]').locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-page-img"]').count() === 1, 'C: migrated document reader renders from OPFS');

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)