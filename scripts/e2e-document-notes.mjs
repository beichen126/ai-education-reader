// Page-note lifecycle E2E: debounce, page-change flush, and close/reopen durability.
import { launchBrowser } from './e2e-browser.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const filesEntry = page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first()
// At a narrow viewport the rail is intentionally visibility-hidden until the
// history drawer opens. Invoke its real button handler without changing the
// application layout just to reach the document library.
await filesEntry.evaluate((el) => (el instanceof HTMLElement ? el.click() : undefined))
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-notes-toggle"]').click()
const note = page.locator('[data-testid="reader-notes"] textarea')
await note.waitFor({ state: 'visible', timeout: 10000 })

await page.evaluate(() => {
  const w = window
  w.__documentNoteWrites = 0
  const put = IDBObjectStore.prototype.put
  const del = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'documentNotes') w.__documentNoteWrites++
    return put.apply(this, args)
  }
  IDBObjectStore.prototype.delete = function (...args) {
    if (this.name === 'documentNotes') w.__documentNoteWrites++
    return del.apply(this, args)
  }
})

// Continuous input must not write one IndexedDB row per key. The write happens
// once after the 450ms quiet period.
await note.fill('A')
await note.pressSequentially('BC', { delay: 40 })
await page.waitForTimeout(180)
const rapidWrites = await page.evaluate(() => window.__documentNoteWrites)
assert(rapidWrites === 0, 'debounce: rapid input has no per-key persistence (writes=' + rapidWrites + ')')
await page.waitForTimeout(450)
const settledWrites = await page.evaluate(() => window.__documentNoteWrites)
assert(settledWrites === 1, 'debounce: rapid input persists once after quiet period (writes=' + settledWrites + ')')

// A page turn before the debounce expires must flush the latest value exactly
// once, and reopening page 1 must wait for that flush rather than reload stale text.
await note.fill('切页前的最新内容')
await page.locator('[data-testid="reader-page-input"]').fill('2')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-page-input"]').fill('1')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await note.waitFor({ state: 'visible', timeout: 10000 })
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes"] textarea')?.value === '切页前的最新内容', null, { timeout: 10000 })
assert(await note.inputValue() === '切页前的最新内容', 'page change: latest page A text is flushed and restored')

// Closing the note panel immediately after an edit flushes the current value;
// reopening the panel reads the committed value.
await note.fill('收起前的最新内容')
await page.locator('[data-testid="reader-notes-toggle"]').click()
await page.locator('[data-testid="reader-notes"]').waitFor({ state: 'hidden' })
await page.locator('[data-testid="reader-notes-toggle"]').click()
await page.locator('[data-testid="reader-notes"] textarea').waitFor({ state: 'visible' })
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes"] textarea')?.value === '收起前的最新内容', null, { timeout: 10000 })
assert(await page.locator('[data-testid="reader-notes"] textarea').inputValue() === '收起前的最新内容', 'close/reopen: pending edit is flushed before reload')

await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')
