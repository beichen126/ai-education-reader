// Manual Chapter Builder + Reader integration e2e (Windows/local, REAL Microsoft Edge).
// Run:
//   1) npm run build && npm run preview -- --port 5299
//   2) node scripts/e2e-chapter-builder.mjs
// Uses a NO-OUTLINE PDF fixture so the "创建章节 / 从此页新建章节" flow is exercised.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const NO_OUTLINE = 'test/fixtures/no-outline.pdf'
const NATIVE = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
let page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES_ENTRY = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator(FILES_ENTRY).first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()

// ---- A. no-outline doc -> empty TOC -> 创建章节 ---------------
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NO_OUTLINE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('no-outline.pdf'), 'A: imported no-outline pdf')
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 1, 'A: empty TOC state shown')
assert(await page.locator('[data-testid="reader-toc-create"]').count() === 1, 'A: 创建章节 button shown in empty TOC')

// ---- B. create chapters via builder (Chapter A p2, Chapter B p5) ---------------
await page.locator('[data-testid="reader-toc-create"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-empty"]').count() === 1, 'B: builder opens with empty draft')
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('Chapter A')
await page.locator('[data-testid="cb-page-0"]').fill('2')
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-1"]').fill('Chapter B')
await page.locator('[data-testid="cb-page-1"]').fill('5')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'B: reader STAYS open after save')
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 0, 'B: empty TOC gone after save')
const tocRows = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(tocRows.join('|').includes('Chapter A') && tocRows.join('|').includes('Chapter B'), 'B: TOC shows Chapter A and B (got ' + tocRows.join('|') + ')')

// ---- C. click Chapter B -> page 5 ---------------
const chapterB = page.locator('[data-testid^="reader-chapter-"]').filter({ hasText: 'Chapter B' }).first()
await chapterB.click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '5', 'C: click Chapter B -> page 5 (got ' + await inputVal() + ')')

// ---- D. 从此页新建章节 at page 7 -> Chapter C ---------------
await page.locator('[data-testid="reader-page-input"]').fill('7')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(400)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
// builder MUST pre-seed one row at the current page (7)
const newRowCount = await page.locator('[data-testid^="cb-row"]').count()
assert(newRowCount === 3, 'D: builder pre-seeds a row (3 rows total = A,B + new; got ' + newRowCount + ')')
const newPageVal = await page.locator('[data-testid="cb-page-' + (newRowCount - 1) + '"]').inputValue()
assert(newPageVal.trim() === '7', 'D: from-current-page new row startPage = 7 (got ' + newPageVal + ')')
await page.locator('[data-testid="cb-title-' + (newRowCount - 1) + '"]').fill('Chapter C')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const tocRows2 = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(tocRows2.join('|').includes('Chapter C'), 'D: TOC has Chapter C after from-current save (got ' + tocRows2.join('|') + ')')
assert((await inputVal()).trim() === '7', 'D: reader page unchanged after builder save (got ' + await inputVal() + ')')

// ---- E. Context integration: jump page 6 -> 当前章节 ---------------
await page.locator('[data-testid="reader-page-input"]').fill('6')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(400)
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-menu"]').waitFor({ state: 'visible', timeout: 10000 })
const chapterBtn = page.locator('[data-testid="reader-ctx-current-chapter"]')
assert(await chapterBtn.count() === 1, 'E: 当前章节 enabled')
assert(!(await chapterBtn.isDisabled()), 'E: 当前章节 not disabled (page 6 in a manual chapter)')
const chapMeta = (await chapterBtn.textContent()) || ''
assert(chapMeta.includes('Chapter A') || chapMeta.includes('Chapter B'), 'E: current chapter title mention (got ' + chapMeta + ')')
await chapterBtn.click()
await page.getByText(/已加入「.*」/).waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'E: reader stays open after context add')
// dismiss the success message WITHOUT leaving the reader (返回对话 would close it)
await page.locator('[data-testid="reader-ctx-toggle"]').click().catch(() => {})

// ---- F. cancel without save (discard confirm) ---------------
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-title-0"]').fill('Chapter A EDITED')
await page.locator('[data-testid="cb-cancel"]').click()
await page.locator('[data-testid="cb-discard-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-discard-confirm"]').count() === 1, 'F: dirty cancel -> discard confirm')
await page.locator('[data-testid="cb-discard-yes"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const title0 = await page.locator('[data-testid="cb-title-0"]').inputValue()
assert(title0.trim() === 'Chapter A', 'F: reopened builder keeps old title (got ' + title0 + ')')
// reopening via reader-build seeds an extra row -> builder is dirty, so cancel asks to discard
await page.locator('[data-testid="cb-cancel"]').click()
await page.locator('[data-testid="cb-discard-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-discard-yes"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

// ---- G. reload persistence: manual chapters survive reload + library count -------
await page.close()
page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror2: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'no-outline.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const tocRows3 = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(tocRows3.join('|').includes('Chapter C'), 'G: TOC persists after reload (got ' + tocRows3.join('|') + ')')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
const card = page.locator('[data-testid^="doc-card-"]').filter({ hasText: 'no-outline.pdf' }).first()
const cardText = (await card.textContent()) || ''
assert(/([0-9]+)/.test(cardText), 'G: library card shows a chapter count (got ' + cardText + ')')

// ---- I. responsive: chapter builder usable + no horizontal overflow at 360/768/1024/1280 -------
const SIZES = [360, 768, 1024, 1280]
// reopen the no-outline doc in the reader (we closed it after G)
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'no-outline.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
for (const w of SIZES) {
  await page.setViewportSize({ width: w, height: w <= 768 ? 1024 : 800 })
  await page.waitForTimeout(250)
  // open builder on the no-outline doc (still the current reader doc in this fresh page)
  await page.locator('[data-testid="reader-build"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)
  assert(noOverflow, 'I: no horizontal overflow in builder at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-title-0"]').isEditable(), 'I: title input editable at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-page-0"]').isEditable(), 'I: page input editable at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-save"]').isVisible(), 'I: save button visible at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-cancel"]').isVisible(), 'I: cancel button visible at ' + w + 'px')
  // some operation button must be enabled (first row's up is correctly disabled)
  const anyEnabledOp = await page.evaluate(() => {
    const btns = document.querySelectorAll('[data-testid^="cb-up-"], [data-testid^="cb-down-"], [data-testid^="cb-indent-"], [data-testid^="cb-outdent-"]')
    return Array.from(btns).some(b => !b.disabled)
  })
  assert(anyEnabledOp, 'I: an op button enabled/clickable at ' + w + 'px')
  await page.locator('[data-testid="cb-cancel"]').click()
  // reopening via reader-build seeds a row -> builder may be dirty, so confirm discard if asked
  if (await page.locator('[data-testid="cb-discard-confirm"]').count()) { await page.locator('[data-testid="cb-discard-yes"]').click() }
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
}
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(200)

// ---- H. native regression: outline-sample.pdf keeps native TOC + current chapter -------
// close the no-outline reader first (its overlay covers the sidebar)
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NATIVE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 0, 'H: native doc has non-empty TOC')
// native tree stays read-only: no manual build entry or create button leaking in
assert(await page.locator('[data-testid="reader-build"]').count() === 0, 'H: native doc hides 从此页新建章节 (read-only)')
await page.locator('[data-testid="reader-toc-toggle-0"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-0.0"]').click()
await page.waitForTimeout(400)
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '2', 'H: native chapter jump works (page 2)')
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-menu"]').waitFor({ state: 'visible', timeout: 10000 })
const nativeChapBtn = page.locator('[data-testid="reader-ctx-current-chapter"]')
assert(!(await nativeChapBtn.isDisabled()), 'H: native 当前章节 enabled')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

await browser.close()
const pageErrors = errors.length ? errors.join('\n') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
const failCount = results.filter(r => r.startsWith('FAIL')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed' + (failCount ? ' (' + failCount + ' failed)' : ''))
process.exit(failCount === 0 ? 0 : 1)
