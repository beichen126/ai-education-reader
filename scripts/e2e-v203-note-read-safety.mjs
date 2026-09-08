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
assert(await noteToggle.getAttribute('data-note-state') === 'unknown', 'cold note read failure keeps the closed state unknown')
assert((await noteToggle.textContent() || '').includes('检查笔记'), 'cold note read failure does not present an existing note as 新建笔记')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
