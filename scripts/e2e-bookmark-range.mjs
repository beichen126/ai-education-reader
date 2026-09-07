// v1.3.3 Stage C: bookmark range selector -> persistence -> actual PDF pages.
import { launchBrowser } from './e2e-browser.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}

const readDocuments = () => page.evaluate(async () => {
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
  return rows
})

const readPdfPageAttachments = () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction('attachments', 'readonly').objectStore('attachments').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows.filter(row => row.meta?.source?.type === 'pdf-page').map(row => ({ id: row.id, source: row.meta.source }))
})

const readPreference = (documentId, chapterId) => page.evaluate(async ({ documentId, chapterId }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const row = await new Promise((resolve, reject) => {
    const request = db.transaction('documents', 'readonly').objectStore('documents').get(documentId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return row?.bookmarkRangePreferences?.[chapterId] || null
}, { documentId, chapterId })

const flatten = (chapters, output = []) => {
  for (const chapter of chapters) {
    output.push(chapter)
    flatten(chapter.children || [], output)
  }
  return output
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()

let docs = await readDocuments()
assert(docs.length === 1, 'IMPORT: one document available for bookmark range flow')
const doc = docs[0]
const allChapters = flatten(doc?.chapters || [])
const chapter = allChapters.find(item => item.selectable && item.startPage != null && item.endPage != null && item.endPage < doc.pageCount) || allChapters.find(item => item.selectable && item.startPage != null && item.endPage != null)
assert(!!chapter, 'PREP: found a selectable chapter with a resolved range')

const openPicker = async () => {
  await page.locator('[data-testid="doc-context-' + doc.id + '"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
}

const modeSelector = () => page.locator('[data-testid="doc-context-mode-' + chapter.id + '"]')
const actualLabel = () => page.locator('[data-testid="doc-context-actual-' + chapter.id + '"]')
const waitForPreference = async (mode) => page.waitForFunction(({ documentId, chapterId, mode }) => {
  return new Promise(resolve => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('documents', 'readonly').objectStore('documents').get(documentId)
      get.onsuccess = () => { db.close(); resolve(get.result?.bookmarkRangePreferences?.[chapterId] === mode) }
      get.onerror = () => { db.close(); resolve(false) }
    }
    request.onerror = () => resolve(false)
  })
}, { documentId: doc.id, chapterId: chapter.id, mode }, { timeout: 10000 })

const addSelectedChapter = async (mode, expectedPages) => {
  await openPicker()
  const selector = modeSelector()
  await selector.waitFor({ state: 'visible', timeout: 5000 })
  await selector.selectOption(mode)
  assert(await selector.inputValue() === mode, mode + ': selector shows selected mode')
  await waitForPreference(mode)
  const actual = await actualLabel().textContent()
  const expectedEnd = mode === 'inclusive' ? Math.min(chapter.endPage + 1, doc.pageCount) : chapter.endPage
  assert((actual || '').includes('实际发送：PDF ' + (chapter.startPage === expectedEnd ? '第 ' + chapter.startPage + ' 页' : chapter.startPage + '–' + expectedEnd)), mode + ': UI actual-page preview matches resolved range')
  await page.locator('[data-testid="doc-context-check-' + chapter.id + '"]').click()
  const before = await readPdfPageAttachments()
  await page.locator('[data-testid="doc-context-add"]').click()
  if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
  await page.waitForFunction(({ count }) => document.querySelectorAll('[data-testid="pdf-group-card"]').length >= count, { count: 1 }, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(500)
  const after = await readPdfPageAttachments()
  const beforeIds = new Set(before.map(item => item.id))
  const added = after.filter(item => !beforeIds.has(item.id) && item.source.documentId === doc.id)
  assert(added.length === expectedPages, mode + ': actual PDF attachment count = ' + expectedPages + ' (got ' + added.length + ')')
  const pages = added.map(item => item.source.pageNumber).sort((a, b) => a - b)
  const expected = Array.from({ length: expectedEnd - chapter.startPage + 1 }, (_, index) => chapter.startPage + index)
  assert(JSON.stringify(pages) === JSON.stringify(expected), mode + ': actual PDF pages match UI preview (' + pages.join(',') + ')')
}

const exclusiveExpectedEnd = chapter.endPage
await addSelectedChapter('exclusive', exclusiveExpectedEnd - chapter.startPage + 1)

// Close/reopen the picker and reload the app; the document-owned selection must remain inclusive.
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await openPicker()
assert(await modeSelector().inputValue() === 'exclusive', 'reload: exclusive preference is restored')
await page.locator('[data-testid="doc-context-cancel"]').click()
await addSelectedChapter('inclusive', Math.min(chapter.endPage + 1, doc.pageCount) - chapter.startPage + 1)

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(result => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
