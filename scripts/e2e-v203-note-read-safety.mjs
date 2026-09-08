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

const readDocumentId = () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction('documents', 'readonly').objectStore('documents').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows[0]?.id
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openDocumentLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
const documentId = await readDocumentId()
assert(Boolean(documentId), 'fixture document is available for the read-failure case')

await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.evaluate(async (id) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('documentNotes', 'readwrite')
    transaction.objectStore('documentNotes').put({
      id: id + '/page-1', documentId: id, pageNumber: 1,
      content: 'ORIGINAL_EXISTING_NOTE', createdAt: Date.now(), updatedAt: Date.now(),
    })
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}, documentId)

await page.addInitScript(() => {
  const store = IDBObjectStore.prototype
  const originalGet = store.get
  Object.defineProperty(store, 'get', {
    configurable: true,
    value: function (key) {
      if (this.name === 'documentNotes' && (window).__v203FailNoteReads > 0) {
        ;(window).__v203FailNoteReads -= 1
        throw new DOMException('forced document note read failure', 'UnknownError')
      }
      return originalGet.call(this, key)
    },
  })
  ;(window).__v203FailNoteReads = 2
})
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openDocumentLibrary(page)
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-testid="reader-notes-toggle"]').waitFor({ state: 'visible', timeout: 10000 })

const noteToggle = page.locator('[data-testid="reader-notes-toggle"]')
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes-toggle"]')?.dataset.noteState === 'unknown', null, { timeout: 10000 })
assert(await noteToggle.getAttribute('data-note-state') === 'unknown', 'cold note read failure keeps the closed state unknown')
assert((await noteToggle.textContent() || '').includes('重试'), 'cold note read failure does not present an existing note as 新建笔记')

await page.evaluate(() => {
  const w = window
  w.__v203NoteWrites = 0
  const put = IDBObjectStore.prototype.put
  const del = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'documentNotes') w.__v203NoteWrites++
    return put.apply(this, args)
  }
  IDBObjectStore.prototype.delete = function (...args) {
    if (this.name === 'documentNotes') w.__v203NoteWrites++
    return del.apply(this, args)
  }
})
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.evaluate(() => window.__v203NoteWrites === 0), 'unknown note state closes without put/delete')

await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-testid="reader-notes-toggle"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes-toggle"]')?.dataset.noteState === 'unknown', null, { timeout: 10000 })
await page.locator('[data-testid="reader-notes-toggle"]').click()
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes-toggle"]')?.dataset.noteState === 'existing', null, { timeout: 10000 })
assert(await page.evaluate(() => window.__v203NoteWrites === 0), 'retry read does not write while establishing the base')
await page.locator('[data-testid="reader-notes-toggle"]').click()
const note = page.locator('[data-testid="reader-notes"] textarea')
await note.waitFor({ state: 'visible', timeout: 10000 })
assert(await note.inputValue() === 'ORIGINAL_EXISTING_NOTE', 'retry success restores the original existing note without overwrite')

// A second page starts with no row. A failed preload must still keep the empty
// editor closed; only a successful retry may expose a writable new-note editor.
await page.locator('[data-testid="reader-notes-toggle"]').click()
await page.evaluate(() => { window.__v203FailNoteReads = 1 })
// Force the page-2 read after arming the fault; page 2 has no persisted note.
await page.locator('[data-testid="reader-page-input"]').fill('2')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes-toggle"]')?.dataset.noteState === 'unknown', null, { timeout: 10000 })
assert(await page.locator('[data-testid="reader-notes"]').count() === 0, 'empty note read failure keeps the editor closed before retry')
await page.locator('[data-testid="reader-notes-toggle"]').click()
await page.waitForFunction(() => document.querySelector('[data-testid="reader-notes-toggle"]')?.dataset.noteState === 'empty', null, { timeout: 10000 })
await page.locator('[data-testid="reader-notes-toggle"]').click()
const emptyNote = page.locator('[data-testid="reader-notes"] textarea')
await emptyNote.waitFor({ state: 'visible', timeout: 10000 })
assert(await emptyNote.isEnabled(), 'empty note becomes writable only after a successful retry')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
