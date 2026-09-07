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

const waitForPdfPageAttachments = async (documentId, minimumCount) => {
  const deadline = Date.now() + 15000
  let rows = []
  while (Date.now() < deadline) {
    rows = await readPdfPageAttachments()
    if (rows.filter(item => item.source.documentId === documentId).length >= minimumCount) return rows
    await page.waitForTimeout(250)
  }
  return readPdfPageAttachments()
}

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
let doc = docs[0]

// Add a stable one-page test chapter to the imported document. This only changes
// the persisted ChapterNode tree in the E2E fixture; the PDF source stays intact.
const singlePageChapter = { id: 'stage-d-single-page', title: 'Stage D 单页章节', level: 1, startPage: doc.pageCount, endPage: doc.pageCount, selectable: true, source: 'manual', children: [] }
await page.evaluate(async ({ documentId, singlePageChapter }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const store = db.transaction('documents', 'readwrite').objectStore('documents')
    const get = store.get(documentId)
    get.onsuccess = () => {
      const row = get.result
      row.chapters = [...(row.chapters || []), singlePageChapter]
      row.chapterSource = 'mixed'
      store.put(row)
    }
    get.onerror = () => reject(get.error)
    store.transaction.oncomplete = () => resolve(true)
    store.transaction.onerror = () => reject(store.transaction.error)
  })
  db.close()
}, { documentId: doc.id, singlePageChapter })
docs = await readDocuments()
doc = docs[0]
const allChapters = flatten(doc?.chapters || [])
const chapter = allChapters.find(item => item.selectable && item.startPage != null && item.endPage != null && item.endPage < doc.pageCount)
const lastChapter = allChapters.find(item => item.selectable && item.startPage != null && item.endPage === doc.pageCount) || allChapters[allChapters.length - 1]
const singleChapter = allChapters.find(item => item.id === singlePageChapter.id)
assert(!!chapter, 'PREP: found a selectable chapter with a resolved non-final range')
assert(!!lastChapter, 'PREP: found a selectable final-page chapter')
assert(!!singleChapter && singleChapter.startPage === singleChapter.endPage, 'PREP: found a single-page chapter')

const openPicker = async () => {
  await page.locator('[data-testid="doc-context-' + doc.id + '"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
}

const modeSelector = (target) => page.locator('[data-testid="doc-context-mode-' + target.id + '"]')
const actualLabel = (target) => page.locator('[data-testid="doc-context-actual-' + target.id + '"]')
const waitForPreference = async (target, mode) => page.waitForFunction(({ documentId, chapterId, mode }) => {
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
}, { documentId: doc.id, chapterId: target.id, mode }, { timeout: 10000 })

const addSelectedChapter = async (target, mode, expectedPages) => {
  await openPicker()
  const selector = modeSelector(target)
  await selector.waitFor({ state: 'visible', timeout: 5000 })
  const optionTexts = await selector.locator('option').allTextContents()
  const exclusiveLabel = '[' + target.startPage + ',' + (target.endPage + 1) + ')'
  const inclusiveLabel = '[' + target.startPage + ',' + Math.min(target.endPage + 1, doc.pageCount) + ']'
  assert(optionTexts.some(text => text.includes('左闭右开 ' + exclusiveLabel)), target.title + ': exclusive option uses canonical boundary before selection')
  assert(optionTexts.some(text => text.includes('左闭右闭 ' + inclusiveLabel)), target.title + ': inclusive option uses canonical boundary before selection')
  await selector.selectOption(mode)
  assert(await selector.inputValue() === mode, mode + ': selector shows selected mode')
  await waitForPreference(target, mode)
  const actual = await actualLabel(target).textContent()
  const expectedEnd = mode === 'inclusive' ? Math.min(target.endPage + 1, doc.pageCount) : target.endPage
  const expectedLabel = mode === 'inclusive' ? '[' + target.startPage + ',' + expectedEnd + ']' : '[' + target.startPage + ',' + (target.endPage + 1) + ')'
  assert((actual || '').trim() === expectedLabel, target.title + ' ' + mode + ': UI preview uses bracket notation only (' + expectedLabel + ')')
  assert(!(actual || '').includes('实际发送') && !(actual || '').includes('左闭右开') && !(actual || '').includes('左闭右闭'), target.title + ' ' + mode + ': UI preview omits verbose mode text')
  await page.locator('[data-testid="doc-context-check-' + target.id + '"]').click()
  const before = await readPdfPageAttachments()
  await page.locator('[data-testid="doc-context-add"]').click()
  if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
  const after = await waitForPdfPageAttachments(doc.id, before.filter(item => item.source.documentId === doc.id).length + expectedPages)
  const beforeIds = new Set(before.map(item => item.id))
  const added = after.filter(item => !beforeIds.has(item.id) && item.source.documentId === doc.id)
  assert(added.length === expectedPages, target.title + ' ' + mode + ': actual PDF attachment count = ' + expectedPages + ' (got ' + added.length + ')')
  const pages = added.map(item => item.source.pageNumber).sort((a, b) => a - b)
  const expected = Array.from({ length: expectedEnd - target.startPage + 1 }, (_, index) => target.startPage + index)
  assert(JSON.stringify(pages) === JSON.stringify(expected), target.title + ' ' + mode + ': actual PDF pages match UI preview (' + pages.join(',') + ')')
}

const exclusiveExpectedEnd = chapter.endPage
await addSelectedChapter(chapter, 'exclusive', exclusiveExpectedEnd - chapter.startPage + 1)

// Close/reopen the picker and reload the app; the document-owned selection must remain inclusive.
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await openPicker()
assert(await modeSelector(chapter).inputValue() === 'exclusive', 'reload: exclusive preference is restored')
await page.locator('[data-testid="doc-context-cancel"]').click()
await addSelectedChapter(chapter, 'inclusive', Math.min(chapter.endPage + 1, doc.pageCount) - chapter.startPage + 1)

// Last-page boundary: inclusive mode is capped at pageCount and sends the same
// final page set as exclusive mode, never pageCount + 1.
await addSelectedChapter(lastChapter, 'inclusive', lastChapter.endPage - lastChapter.startPage + 1)

// Single-page boundary: both modes remain exactly one physical page.
await addSelectedChapter(singleChapter, 'exclusive', 1)
await addSelectedChapter(singleChapter, 'inclusive', 1)

// Mobile layout gate: all requested widths keep the selector and actual-page
// preview inside the viewport with no document/picker horizontal overflow.
for (const viewport of [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 412, height: 915 }]) {
  await page.setViewportSize(viewport)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
  await openLibrary()
  await openPicker()
  const layout = await page.evaluate(() => {
    const picker = document.querySelector('[data-testid="doc-context-picker"]')
    const mode = picker?.querySelector('[data-testid^="doc-context-mode-"]')
    const box = mode?.getBoundingClientRect()
    return {
      viewport: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      pickerScrollWidth: picker?.scrollWidth ?? 0,
      pickerClientWidth: picker?.clientWidth ?? 0,
      modeRight: box?.right ?? 0,
      modeLeft: box?.left ?? 0,
    }
  })
  assert(layout.documentScrollWidth <= layout.viewport + 1 && layout.bodyScrollWidth <= layout.viewport + 1 && layout.pickerScrollWidth <= layout.pickerClientWidth + 1, viewport.width + 'x' + viewport.height + ': no horizontal overflow')
  assert(layout.modeLeft >= -1 && layout.modeRight <= layout.viewport + 1, viewport.width + 'x' + viewport.height + ': range selector is inside viewport')
  await actualLabel(chapter).scrollIntoViewIfNeeded()
  const actualBox = await actualLabel(chapter).boundingBox()
  assert(Boolean(actualBox && actualBox.x >= -1 && actualBox.x + actualBox.width <= viewport.width + 1 && actualBox.y < viewport.height && actualBox.y + actualBox.height > 0), viewport.width + 'x' + viewport.height + ': actual-page preview remains visible')
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(result => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
