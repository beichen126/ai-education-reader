// v1.3.3 Stage C: bookmark range selector -> persistence -> actual PDF pages.
import { launchBrowser } from './e2e-browser.mjs'
import { openAppDb } from './e2e-idb.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'
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

const readDocuments = () => openAppDb(page, { store: 'documents' })

const readPdfPageAttachments = async () => {
  const rows = await openAppDb(page, { store: 'attachments' })
  return rows.filter(row => row.meta?.source?.type === 'pdf-page').map(row => ({ id: row.id, source: row.meta.source }))
}

const waitForPdfPageAttachments = async (documentId, minimumCount) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const rows = await readPdfPageAttachments()
    if (rows.filter(item => item.source.documentId === documentId).length >= minimumCount) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for durable PDF page attachments')
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
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
await openLibrary()

let docs = await readDocuments()
assert(docs.length === 1, 'IMPORT: one document available for bookmark range flow')
let doc = docs[0]

// Add a stable one-page test chapter to the imported document. This only changes
// the persisted ChapterNode tree in the E2E fixture; the PDF source stays intact.
const singlePageChapter = { id: 'stage-d-single-page', title: 'Stage D 单页章节', level: 1, startPage: doc.pageCount, endPage: doc.pageCount, selectable: true, source: 'manual', children: [] }
const stageL3 = { id: 'stage-d-l3', title: 'Stage D L3', level: 3, startPage: 16, endPage: 17, selectable: true, source: 'manual', children: [] }
const stageL3Sibling = { id: 'stage-d-l3-sibling', title: 'Stage D L3 sibling', level: 3, startPage: 18, endPage: 19, selectable: true, source: 'manual', children: [] }
const stageL2 = { id: 'stage-d-l2', title: 'Stage D L2', level: 2, startPage: 12, endPage: 14, selectable: true, source: 'manual', children: [stageL3, stageL3Sibling] }
const stageL2Sibling = { id: 'stage-d-l2-sibling', title: 'Stage D L2 sibling', level: 2, startPage: 20, endPage: 21, selectable: true, source: 'manual', children: [] }
const stageL1 = { id: 'stage-d-l1', title: 'Stage D L1 [10,20]', level: 1, startPage: 10, endPage: 19, selectable: true, source: 'manual', children: [stageL2, stageL2Sibling] }
const stageL1Sibling = { id: 'stage-d-l1-sibling', title: 'Stage D L1 sibling', level: 1, startPage: 22, endPage: 23, selectable: true, source: 'manual', children: [] }
const stageLastPage = { id: 'stage-d-last-page', title: 'Stage D 最后一页', level: 1, startPage: doc.pageCount, endPage: doc.pageCount, selectable: true, source: 'manual', children: [] }
const fixtureDoc = await openAppDb(page, { store: 'documents', operation: 'get', key: doc.id })
fixtureDoc.chapters = [...(fixtureDoc.chapters || []), stageL1, stageL1Sibling, stageLastPage, singlePageChapter]
fixtureDoc.chapterSource = 'mixed'
await openAppDb(page, { store: 'documents', operation: 'put', value: fixtureDoc })
docs = await readDocuments()
doc = docs.find(item => item.id === fixtureDoc.id)
const sameNameDocumentId = 'stage-d-same-name-document'
const sameNameDoc = { ...doc, id: sameNameDocumentId, bookmarkRangePreferences: undefined, createdAt: doc.createdAt + 1, updatedAt: doc.updatedAt + 1 }
await openAppDb(page, { store: 'documents', operation: 'put', value: sameNameDoc })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
const allChapters = flatten(doc?.chapters || [])
const chapter = allChapters.find(item => item.id === stageL1.id)
const lastChapter = allChapters.find(item => item.id === stageLastPage.id)
const singleChapter = allChapters.find(item => item.id === singlePageChapter.id)
assert(!!chapter, 'PREP: found a selectable chapter with a resolved non-final range')
assert(!!lastChapter, 'PREP: found a selectable final-page chapter')
assert(!!singleChapter && singleChapter.startPage === singleChapter.endPage, 'PREP: found a single-page chapter')

const openPickerFor = async (documentId) => {
  await page.locator('[data-testid="doc-context-' + documentId + '"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
}
const openPicker = () => openPickerFor(doc.id)

const modeSelector = (target) => page.locator('[data-testid="doc-context-mode-' + target.id + '"]')
const actualLabel = (target) => page.locator('[data-testid="doc-context-actual-' + target.id + '"]')
const waitForPreference = async (target, mode, documentId = doc.id) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const row = await openAppDb(page, { store: 'documents', operation: 'get', key: documentId })
    if (row?.bookmarkRangePreferences?.[target.id] === mode) return row
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for durable bookmark preference: ' + target.id + ' = ' + mode)
}

const waitForPreferences = async (targets, mode, documentId = doc.id) => {
  for (const target of targets) await waitForPreference(target, mode, documentId)
}

const addSelectedChapter = async (target, mode, expectedPages) => {
  await openPicker()
  const selector = modeSelector(target)
  const sameLevelTargets = allChapters.filter(item => item.level === target.level && item.selectable && item.startPage != null && item.endPage != null)
  assert(sameLevelTargets.length >= 2, target.title + ': fixture has multiple selectable chapters at the same level')
  await selector.waitFor({ state: 'visible', timeout: 5000 })
  const row = page.locator('[data-testid="doc-context-node-' + target.id + '"]')
  const checkbox = row.getByRole('checkbox', { name: target.title })
  assert(await checkbox.count() === 1, target.title + ': checkbox accessible name is the chapter title')
  assert(await checkbox.locator('xpath=ancestor::label').count() === 1, target.title + ': checkbox and title share a label')
  assert(await selector.locator('xpath=ancestor::label').count() === 0, target.title + ': mode selector is outside the checkbox label')
  await row.locator('label').getByText(target.title, { exact: true }).click()
  assert(await checkbox.isChecked(), target.title + ': clicking the chapter title selects the checkbox')
  await checkbox.focus()
  await page.keyboard.press('Space')
  assert(!(await checkbox.isChecked()), target.title + ': Space can clear the focused checkbox')
  await page.keyboard.press('Space')
  assert(await checkbox.isChecked(), target.title + ': Space selects the focused checkbox')
  await page.keyboard.press('Tab')
  assert(await selector.evaluate(element => document.activeElement === element), target.title + ': Tab moves from checkbox to mode selector')
  const optionTexts = await selector.locator('option').allTextContents()
  const exclusiveLabel = '[' + target.startPage + ',' + (target.endPage + 1) + ')'
  const inclusiveLabel = '[' + target.startPage + ',' + Math.min(target.endPage + 1, doc.pageCount) + ']'
  assert(optionTexts.some(text => text.includes('左闭右开 ' + exclusiveLabel)), target.title + ': exclusive option uses canonical boundary before selection')
  assert(optionTexts.some(text => text.includes('左闭右闭 ' + inclusiveLabel)), target.title + ': inclusive option uses canonical boundary before selection')
  await selector.selectOption(mode)
  assert(await selector.inputValue() === mode, mode + ': selector shows selected mode')
  assert(await checkbox.isChecked(), target.title + ': changing mode leaves checkbox selected')
  await waitForPreferences(sameLevelTargets, mode)
  for (const sibling of sameLevelTargets) assert(await modeSelector(sibling).inputValue() === mode, sibling.title + ': same-level selector follows batch mode')
  const actual = await actualLabel(target).textContent()
  const expectedEnd = mode === 'inclusive' ? Math.min(target.endPage + 1, doc.pageCount) : target.endPage
  const expectedLabel = mode === 'inclusive' ? '[' + target.startPage + ',' + expectedEnd + ']' : '[' + target.startPage + ',' + (target.endPage + 1) + ')'
  assert((actual || '').trim() === expectedLabel, target.title + ' ' + mode + ': UI preview uses bracket notation only (' + expectedLabel + ')')
  assert(!(actual || '').includes('实际发送') && !(actual || '').includes('左闭右开') && !(actual || '').includes('左闭右闭'), target.title + ' ' + mode + ': UI preview omits verbose mode text')
  await checkbox.focus()
  await page.keyboard.press('Space')
  assert(!(await checkbox.isChecked()), target.title + ': Space can clear the checkbox without changing mode')
  await page.keyboard.press('Space')
  assert(await checkbox.isChecked(), target.title + ': Space can reselect the checkbox')
  const before = await readPdfPageAttachments()
  await page.locator('[data-testid="doc-context-add"]').click()
  if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
  const after = await waitForPdfPageAttachments(doc.id, before.filter(item => item.source.documentId === doc.id).length + expectedPages)
  const beforeIds = new Set(before.map(item => item.id))
  const newAttachments = after.filter(item => !beforeIds.has(item.id) && item.source.documentId === doc.id)
  const groupId = newAttachments[0]?.source.groupId
  const added = after.filter(item => item.source.documentId === doc.id && item.source.groupId === groupId)
  assert(added.length === expectedPages, target.title + ' ' + mode + ': actual PDF attachment count = ' + expectedPages + ' (got ' + added.length + ')')
  const pages = added.map(item => item.source.pageNumber).sort((a, b) => a - b)
  const expected = Array.from({ length: expectedEnd - target.startPage + 1 }, (_, index) => target.startPage + index)
  assert(JSON.stringify(pages) === JSON.stringify(expected), target.title + ' ' + mode + ': actual PDF pages match UI preview (' + pages.join(',') + ')')
}

const testRapidPreferenceWrites = async target => {
  await openPicker()
  const selector = modeSelector(target)
  await selector.selectOption('inclusive')
  await selector.selectOption('exclusive')
  const sameLevelTargets = allChapters.filter(item => item.level === target.level && item.selectable && item.startPage != null && item.endPage != null)
  await waitForPreferences(sameLevelTargets, 'exclusive')
  assert(await selector.inputValue() === 'exclusive', target.title + ': rapid inclusive -> exclusive ends exclusive')
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

const testFailedPreferenceWrite = async target => {
  await openPicker()
  const selector = modeSelector(target)
  const before = await selector.inputValue()
  const next = before === 'inclusive' ? 'exclusive' : 'inclusive'
  await page.evaluate(() => { window.__dshFailNextBookmarkRangePreferenceWrite = true })
  await selector.selectOption(next)
  await page.locator('[data-testid="doc-context-block"]').waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="doc-context-picker"]').count() === 1, target.title + ': failed preference keeps Picker open')
  assert(await selector.inputValue() === before, target.title + ': failed preference rolls back to confirmed mode')
  await page.locator('[data-testid="doc-context-cancel"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 5000 })
  assert(await page.locator('[data-testid="doc-context-picker"]').count() === 1, target.title + ': cancel does not unmount after durable failure')
  await selector.selectOption(next)
  await waitForPreferences(allChapters.filter(item => item.level === target.level && item.selectable && item.startPage != null && item.endPage != null), next)
  assert((await page.locator('[data-testid="doc-context-block"]').count()) === 0, target.title + ': successful retry clears the failure message')
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

const selectableAtLevel = level => allChapters.filter(item => item.level === level && item.selectable && item.startPage != null && item.endPage != null)

const testSameNameDocumentIsolation = async target => {
  const sameLevelTargets = selectableAtLevel(target.level)
  await openPicker()
  await modeSelector(target).selectOption('inclusive')
  await waitForPreferences(sameLevelTargets, 'inclusive')
  await page.locator('[data-testid="doc-context-cancel"]').click()

  await openPickerFor(sameNameDocumentId)
  assert(await modeSelector(target).inputValue() === 'exclusive', 'same-name document starts with its own default exclusive mode')
  await modeSelector(target).selectOption('inclusive')
  await waitForPreferences(sameLevelTargets, 'inclusive', sameNameDocumentId)
  await page.locator('[data-testid="doc-context-cancel"]').click()

  await openPicker()
  assert(await modeSelector(target).inputValue() === 'inclusive', 'same-name document preference does not overwrite the primary document')
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

const testIndependentLevelPreferences = async () => {
  const targets = [
    { target: chapter, mode: 'exclusive' },
    { target: allChapters.find(item => item.id === stageL2.id), mode: 'inclusive' },
    { target: allChapters.find(item => item.id === stageL3.id), mode: 'exclusive' },
  ]
  for (const { target, mode } of targets) {
    const sameLevelTargets = selectableAtLevel(target.level)
    await openPicker()
    await modeSelector(target).selectOption(mode)
    await waitForPreferences(sameLevelTargets, mode)
    await page.locator('[data-testid="doc-context-cancel"]').click()
  }

  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
  await openLibrary()
  await openPicker()
  for (const { target, mode } of targets) {
    assert(await modeSelector(target).inputValue() === mode, target.title + ': ' + mode + ' preference survives reload independently')
  }
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

const testContextLimits = async () => {
  await openPicker()
  await page.locator('[data-testid="doc-context-tab-manual"]').click()
  await page.locator('[data-testid="doc-context-ms"]').fill('1')
  await page.locator('[data-testid="doc-context-me"]').fill('120')
  await page.locator('[data-testid="doc-context-manual-add"]').click()
  await page.getByText('共 120 页', { exact: false }).waitFor({ state: 'visible', timeout: 5000 })
  assert(await page.locator('[data-testid="doc-context-add"]').isEnabled(), '120-page manual range remains allowed')
  await page.locator('[data-testid="doc-context-cancel"]').click()

  await openPicker()
  await page.locator('[data-testid="doc-context-tab-manual"]').click()
  await page.locator('[data-testid="doc-context-ms"]').fill('1')
  await page.locator('[data-testid="doc-context-me"]').fill('121')
  await page.locator('[data-testid="doc-context-manual-add"]').click()
  const before = (await readPdfPageAttachments()).filter(item => item.source.documentId === doc.id).length
  await page.locator('[data-testid="doc-context-add"]').click()
  await page.locator('[data-testid="doc-context-block"]').waitFor({ state: 'visible', timeout: 5000 })
  assert((await page.locator('[data-testid="doc-context-block"]').textContent() || '').includes('120'), '121-page manual range is hard-blocked at 120 pages')
  assert(await page.locator('[data-testid="doc-context-picker"]').count() === 1, '121-page hard block keeps Picker open')
  const after = (await readPdfPageAttachments()).filter(item => item.source.documentId === doc.id).length
  assert(after === before, '121-page hard block sends no PDF pages')
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

const testReaderPreferenceRefresh = async target => {
  await page.locator('[data-testid="doc-open-' + doc.id + '"]').click()
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('[data-testid="reader-page-input"]').fill(String(target.startPage))
  await page.locator('[data-testid="reader-page-input"]').press('Enter')
  await page.waitForFunction(pageNumber => document.querySelector('[data-testid="reader-page-input"]')?.value === String(pageNumber), target.startPage)

  await page.locator('[data-testid="reader-ctx-toggle"]').click()
  await page.locator('[data-testid="reader-ctx-picker"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
  const selector = modeSelector(target)
  await selector.waitFor({ state: 'visible', timeout: 10000 })
  await selector.selectOption('inclusive')
  const sameLevelTargets = allChapters.filter(item => item.level === target.level && item.selectable && item.startPage != null && item.endPage != null)
  await waitForPreferences(sameLevelTargets, 'inclusive')
  await page.locator('[data-testid="doc-context-cancel"]').click()
  await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'detached', timeout: 10000 })
  assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === String(target.startPage), 'Reader page is preserved when Picker closes without reload')

  await page.locator('[data-testid="reader-ctx-toggle"]').click()
  const ancestor = page.locator('[data-testid="reader-ctx-ancestor-' + target.id + '"]')
  await ancestor.waitFor({ state: 'visible', timeout: 10000 })
  const expectedEnd = Math.min(target.endPage + 1, doc.pageCount)
  const menuText = await ancestor.textContent()
  assert((menuText || '').includes('[' + target.startPage + ',' + expectedEnd + ']'), 'Reader menu uses the saved inclusive mode without reload')
  const before = await readPdfPageAttachments()
  await ancestor.click()
  if (await page.locator('[data-testid="reader-ctx-confirm"]').count()) await page.locator('[data-testid="reader-ctx-confirm-yes"]').click()
  const expectedCount = expectedEnd - target.startPage + 1
  await page.getByText('已加入「' + target.title + '」· ' + expectedCount + ' 页', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  const after = await waitForPdfPageAttachments(doc.id, before.filter(item => item.source.documentId === doc.id).length + expectedCount)
  const beforeIds = new Set(before.map(item => item.id))
  const added = after.filter(item => !beforeIds.has(item.id) && item.source.documentId === doc.id)
  assert(added.length === expectedCount, 'Reader sends pages matching the refreshed inclusive range without reload')
  await page.locator('[data-testid="reader-close"]').click()
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
}

const exclusiveExpectedEnd = chapter.endPage
await addSelectedChapter(chapter, 'exclusive', exclusiveExpectedEnd - chapter.startPage + 1)

await testSameNameDocumentIsolation(chapter)

// Reader owner callback: change a scoped Picker preference, close without reload,
// then use the Reader's own chapter shortcut and verify the new mode is applied.
await testReaderPreferenceRefresh(chapter)

// Close/reopen the picker and reload the app; the document-owned selection must remain inclusive.
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await openPicker()
assert(await modeSelector(chapter).inputValue() === 'inclusive', 'reload: Reader-updated inclusive preference is restored')
await page.locator('[data-testid="doc-context-cancel"]').click()
await addSelectedChapter(chapter, 'inclusive', Math.min(chapter.endPage + 1, doc.pageCount) - chapter.startPage + 1)

// Last-page boundary: inclusive mode is capped at pageCount and sends the same
// final page set as exclusive mode, never pageCount + 1.
await addSelectedChapter(lastChapter, 'inclusive', lastChapter.endPage - lastChapter.startPage + 1)

// Single-page boundary: both modes remain exactly one physical page.
await addSelectedChapter(singleChapter, 'exclusive', 1)
await addSelectedChapter(singleChapter, 'inclusive', 1)

await testRapidPreferenceWrites(chapter)
await testFailedPreferenceWrite(chapter)
await testIndependentLevelPreferences()
await testContextLimits()

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
  const target = allChapters.find(item => item.id === chapter.id)
  await actualLabel(target).scrollIntoViewIfNeeded()
  const actualBox = await actualLabel(target).boundingBox()
  assert(Boolean(actualBox && actualBox.x >= -1 && actualBox.x + actualBox.width <= viewport.width + 1 && actualBox.y < viewport.height && actualBox.y + actualBox.height > 0), viewport.width + 'x' + viewport.height + ': actual-page preview remains visible for ' + target.title)
  await page.locator('[data-testid="doc-context-cancel"]').click()
}

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(result => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
