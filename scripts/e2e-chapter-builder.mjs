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
const freshPage = async () => {
  if (page) await page.close().catch(() => {})
  page = await ctx.newPage()
  page.on('pageerror', e => errors.push('pageerror2: ' + e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
}
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES_ENTRY = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator(FILES_ENTRY).first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
const importPdf = async (p, title) => {
  await openLibrary()
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(p)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
  assert((await page.locator('[data-testid="reader-title"]').textContent()).includes(title), 'import reader title ' + title)
}
const jumpTo = async (pg) => {
  await page.locator('[data-testid="reader-page-input"]').fill(String(pg))
  await page.locator('[data-testid="reader-page-input"]').press('Enter')
  await page.waitForTimeout(400)
}
const tocTexts = () => page.locator('[data-testid^="reader-chapter-"]').allTextContents()
// Find the builder row index whose page input equals `pg`, then fill its title.
const fillRowAtPage = async (pg, title) => {
  const count = await page.locator('[data-testid^="cb-row"]').count()
  for (let r = 0; r < count; r++) {
    const val = await page.locator('[data-testid="cb-page-' + r + '"]').inputValue()
    if (val.trim() === String(pg)) { await page.locator('[data-testid="cb-title-' + r + '"]').fill(title); return r }
  }
  return -1
}

// ---- A. no-outline doc -> empty TOC -> 创建章节 ---------------
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NO_OUTLINE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('no-outline.pdf'), 'A: imported no-outline pdf')
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 1, 'A: empty TOC state shown')
assert(await page.locator('[data-testid="reader-toc-create"]').count() === 1, 'A: 创建章节 button shown in empty TOC')

// ---- B. create chapters (Chapter A p2, then Chapter B p8) ---------------
// Create the first chapter from the empty builder at page 2.
await jumpTo(2)
await page.locator('[data-testid="reader-toc-create"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-empty"]').count() === 1, 'B: builder opens with empty draft')
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('Chapter A')
assert((await page.locator('[data-testid="cb-page-0"]').inputValue()).trim() === '2', 'B: first add defaults to current page 2')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'B: reader STAYS open after first save')
// Create the second chapter from current page 8.
await jumpTo(8)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const idxB = await fillRowAtPage(8, 'Chapter B')
assert(idxB >= 0, 'B: new Chapter B row at page 8 found')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const tocRows = await tocTexts()
assert(tocRows.join('|').includes('Chapter A') && tocRows.join('|').includes('Chapter B'), 'B: TOC shows Chapter A and B (got ' + tocRows.join('|') + ')')

// ---- C. click Chapter B -> page 8 ---------------
await page.locator('[data-testid^="reader-chapter-"]').filter({ hasText: 'Chapter B' }).first().click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '8', 'C: click Chapter B -> page 8 (got ' + await inputVal() + ')')

// ---- D. 从此页新建 at page 5 -> MIDDLE insertion (A p2, X p5, B p8) §18 ---------------
await jumpTo(5)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const rowsD = await page.locator('[data-testid^="cb-row"]').count()
assert(rowsD === 3, 'D: builder pre-seeds a row (3 rows; got ' + rowsD + ')')
const orderD = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid^="cb-row"]'))
  return rows.map(r => r.querySelector('[data-testid^="cb-page-"]')?.value).join(',')
})
assert(orderD === '2,5,8', 'D: new row inserted in MIDDLE by page order (got ' + orderD + ')')
const idxX = await fillRowAtPage(5, 'Chapter X')
assert(idxX >= 0, 'D: new Chapter X row at page 5 found')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const tocRows2 = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(tocRows2.join('|').includes('Chapter X'), 'D: TOC has Chapter X after middle save (got ' + tocRows2.join('|') + ')')
assert((await inputVal()).trim() === '5', 'D: reader page unchanged after builder save (got ' + await inputVal() + ')')
assert(!tocRows2.join('|').includes('B') || tocRows2.join('|').split('|').findIndex(t => t.includes('B')) > tocRows2.join('|').split('|').findIndex(t => t.includes('X')), 'D: X order before B in TOC')

// ---- E. same-page insertion now SUCCEEDS (Stage 9.4B.1): jump page 5, add a row at 5 ---------------
await jumpTo(5)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-insert-error"]').count() === 0, 'E: no same-page conflict error (same-page allowed)')
const rowsE = await page.locator('[data-testid^="cb-row"]').count()
assert(rowsE === 4, 'E: same-page new row inserted (4 rows: A,X,NEW,B; got ' + rowsE + ')')
await page.locator('[data-testid="cb-cancel"]').click()
if (await page.locator('[data-testid="cb-discard-confirm"]').count()) { await page.locator('[data-testid="cb-discard-yes"]').click() }
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

// ---- F. save-failure retry: draft preserved, error shown, stays open, retry succeeds §21 ---------------
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-title-0"]').fill('Chapter A EDITED')
await page.evaluate(() => { (window).__dshFailNextChapterSave = true })
await page.locator('[data-testid="cb-save"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="chapter-builder"]').count() === 1, 'F: failed save keeps builder open')
assert(await page.locator('[data-testid="cb-save-error"]').count() === 1, 'F: save error shown after failure')
const titleAfterFail = await page.locator('[data-testid="cb-title-0"]').inputValue()
assert(titleAfterFail.trim() === 'Chapter A EDITED', 'F: edited title preserved after failed save (got ' + titleAfterFail + ')')
// retry succeeds -> builder closes, TOC updates
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const tocAfterRetry = await tocTexts()
assert(tocAfterRetry.join('|').includes('Chapter A EDITED'), 'F: retry save updates TOC (got ' + tocAfterRetry.join('|') + ')')

// ---- G. context at page 6 -> 当前章节 = Chapter X (5..7) §26 ---------------
await jumpTo(6)
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-menu"]').waitFor({ state: 'visible', timeout: 10000 })
const chapBtn = page.locator('[data-testid="reader-ctx-current-chapter"]')
assert(!(await chapBtn.isDisabled()), 'G: 当前章节 enabled at page 6')
const chapMeta = (await chapBtn.textContent()) || ''
// Same-page ambiguity (Stage 9.4B.1 A4): page 6 falls within multiple same-page chapters
// (X and the page-5 row both cover 5–7); the resolver picks deterministically but the
// exact title here is not guaranteed to be X — assert it is one of the page-5 chapters.
assert(chapMeta.includes('Chapter X') || chapMeta.includes('新章节'), 'G: current chapter is a same-page chapter (got ' + chapMeta + ')')
await chapBtn.click()
await page.getByText(/已加入「.*」/).waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'G: reader stays open after context add')
await page.locator('[data-testid="reader-ctx-toggle"]').click().catch(() => {})

// ---- H. cancel/dirty reopen preserves old title ---------------
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-title-0"]').fill('FLIP')
await page.locator('[data-testid="cb-cancel"]').click()
await page.locator('[data-testid="cb-discard-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="cb-discard-confirm"]').count() === 1, 'H: dirty cancel -> discard confirm')
await page.locator('[data-testid="cb-discard-yes"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const titleH = await page.locator('[data-testid="cb-title-0"]').inputValue()
assert(titleH.trim() === 'Chapter A EDITED', 'H: reopen keeps old title (got ' + titleH + ')')
await page.locator('[data-testid="cb-cancel"]').click()
if (await page.locator('[data-testid="cb-discard-confirm"]').count()) { await page.locator('[data-testid="cb-discard-yes"]').click() }
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })

// ---- I. reload persistence: manual chapters survive reload + library count -------
await freshPage()
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'no-outline.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const tocReload = await tocTexts()
assert(tocReload.join('|').includes('Chapter X') && tocReload.join('|').includes('Chapter A EDITED'), 'I: TOC persists after reload (got ' + tocReload.join('|') + ')')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
const card = page.locator('[data-testid^="doc-card-"]').filter({ hasText: 'no-outline.pdf' }).first()
const cardText = (await card.textContent()) || ''
assert(/([0-9]+)/.test(cardText), 'I: library card shows a chapter count (got ' + cardText + ')')

// ---- J. responsive: builder usable + no horizontal overflow at 360/768/1024/1280 -------
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'no-outline.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const SIZES = [360, 768, 1024, 1280]
for (const w of SIZES) {
  await page.setViewportSize({ width: w, height: w <= 768 ? 1024 : 800 })
  await page.waitForTimeout(250)
  await page.locator('[data-testid="reader-build"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)
  assert(noOverflow, 'J: no horizontal overflow in builder at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-title-0"]').isEditable(), 'J: title input editable at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-page-0"]').isEditable(), 'J: page input editable at ' + w + 'px')
  assert(await page.locator('[data-testid="cb-save"]').isVisible(), 'J: save button visible at ' + w + 'px')
  const anyEnabledOp = await page.evaluate(() => {
    const btns = document.querySelectorAll('[data-testid^="cb-indent-"], [data-testid^="cb-outdent-"], [data-testid^="cb-del-"]')
    return Array.from(btns).some(b => !b.disabled)
  })
  assert(anyEnabledOp, 'J: an op button enabled/clickable at ' + w + 'px')
  await page.locator('[data-testid="cb-cancel"]').click()
  if (await page.locator('[data-testid="cb-discard-confirm"]').count()) { await page.locator('[data-testid="cb-discard-yes"]').click() }
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
}
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(200)

// ---- K. before-first + append insertion on a FRESH doc (§19, §20) ---------------
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NO_OUTLINE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
// create a fresh pair First p4, Second p8 (each from its own current page)
await jumpTo(4)
await page.locator('[data-testid="reader-toc-create"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('First')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
await jumpTo(8)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="cb-title-0"]').fill('Second')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
// before-first: jump page 2 -> 从此页新建 -> new at p2 goes BEFORE First
await jumpTo(2)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const orderK1 = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid^="cb-row"]'))
  return rows.map(r => r.querySelector('[data-testid^="cb-page-"]')?.value).join(',')
})
assert(orderK1 === '2,4,8', 'K: before-first insertion (got ' + orderK1 + ')')
const idxZero = await fillRowAtPage(2, 'Zero')
assert(idxZero >= 0, 'K: new Zero row at page 2 found')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
// append: jump page 9 -> 从此页新建 -> new at p9 appended
await jumpTo(9)
await page.locator('[data-testid="reader-build"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
const orderK2 = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid^="cb-row"]'))
  return rows.map(r => r.querySelector('[data-testid^="cb-page-"]')?.value).join(',')
})
assert(orderK2 === '2,4,8,9', 'K: append insertion (got ' + orderK2 + ')')
const idxLast = await fillRowAtPage(9, 'Last')
assert(idxLast >= 0, 'K: new Last row at page 9 found')
await page.locator('[data-testid="cb-save"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'detached', timeout: 10000 })
const tocK = await tocTexts()
assert(tocK.join('|').includes('Zero') && tocK.join('|').includes('Last'), 'K: TOC reflects before-first + append saves (got ' + tocK.join('|') + ')')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// ---- L. native regression: outline-sample.pdf keeps native TOC + current chapter -------
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NATIVE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-toc-empty"]').count() === 0, 'L: native doc has non-empty TOC')
assert(await page.locator('[data-testid="reader-build"]').count() === 0, 'L: native doc hides 从此页新建章节 (read-only)')
await page.locator('[data-testid="reader-toc-toggle-0"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-0.0"]').click()
await page.waitForTimeout(400)
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '2', 'L: native chapter jump works (page 2)')
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
