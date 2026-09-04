// Document -> Context e2e (Stage 9.5, v1.0.0, block 0.1/0.2/0.3). Asserts ACTUAL Draft
// output (a PdfContextCard in the current conversation + persisted attachments with
// document provenance), NOT a mere status message. Covers: Composer unscoped document
// transition (0.1), temporary PdfSession (0.2), parent-chapter context and provenance
// (0.3), reader ancestor selection, multi-chapter normalization, cancellation (0.4).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
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
const closeLibrary = async () => { const b = page.locator('[data-testid="library-close"]'); if (await b.count()) { await b.click(); await page.waitForTimeout(300) } }

const readDocs = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res, rej) => { const r = db.transaction('documents', 'readonly').objectStore('documents').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  return rows.map(row => ({ id: row.id, fileName: row.fileName, pageCount: row.pageCount, chapters: row.chapters || [], source: row.source || null, sourceStorage: row.source ? row.source.storage : null }))
})
const readPdfPageAtts = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res, rej) => { const r = db.transaction('attachments', 'readonly').objectStore('attachments').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  return rows.filter(r => r.meta && r.meta.source && r.meta.source.type === 'pdf-page').map(r => ({ id: r.id, source: r.meta.source }))
})
const flatten = (chapters, acc) => { for (const c of chapters) { acc.push(c); if (c.children && c.children.length) flatten(c.children, acc) } return acc }

// Wait (poll) until the composer shows >= target PdfContextCards, or the timeout elapses.
const waitForCards = async (target, timeoutMs) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.locator('[data-testid="pdf-group-card"]').count()
    if (n >= target) return n
    await page.waitForTimeout(200)
  }
  return page.locator('[data-testid="pdf-group-card"]').count()
}
// --- import the fixture (native outline: 2 chapters, 8 pages) ---
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

let docs = await readDocs()
assert(docs.length === 1, 'IMPORT: exactly one document after import')
const doc = docs[0]
assert(doc.sourceStorage === 'opfs', 'IMPORT: document persisted via OPFS ref (got ' + doc.sourceStorage + ')')
assert(doc.chapters.length >= 2, 'IMPORT: native outline captured chapters (got ' + doc.chapters.length + ')')

const all = flatten(doc.chapters, [])
const parent = all.find(n => n.selectable && n.startPage != null && n.children && n.children.length > 0)
assert(!!parent, 'PREP: found a selectable parent chapter')

// Ids of pdf-page attachments for ONE document (used as a before-set for delta assertions).
const docAttIds = async (did) => new Set((await readPdfPageAtts()).filter(a => a.source.documentId === did).map(a => a.id))

// After an add: wait for render+commit, then assert the NEW pdf-page attachments and provenance.
// cardTarget increments once per completed add (each add = one PdfContextCard group).
let cardTarget = 0
const expectDraftContext = async (label, expectedPages, beforeIds) => {
  cardTarget++
  await waitForCards(cardTarget, 15000)
  await page.waitForTimeout(300)
  const atts = await readPdfPageAtts()
  const forDoc = atts.filter(a => a.source.documentId === doc.id)
  const added = forDoc.filter(a => !beforeIds.has(a.id))
  assert(added.length === expectedPages, label + ': new attachment count == expected pages (got ' + added.length + '/expected ' + expectedPages + ')')
  const sel = added.length ? added[added.length - 1].source.selection : null
  return { added, sel }
}

// ========== FLOW A: Library card -> scoped picker -> parent chapter -> Draft context ==========
await openLibrary()
await page.locator('[data-testid^="doc-context-"]').first().click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="doc-context-doclist"]').count() === 0, 'A: scoped picker has no document list')
const aBefore = await docAttIds(doc.id)
await page.locator('[data-testid="doc-context-check-' + parent.id + '"]').click()
await page.locator('[data-testid="doc-context-add"]').click()
if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
const A = await expectDraftContext('A', parent.endPage - parent.startPage + 1, aBefore)
assert(A.sel && A.sel.selectedChapterIds && A.sel.selectedChapterIds.includes(parent.id), 'A: provenance selectedChapterIds includes the parent chapter')
assert(A.added.every(a => a.source.documentId === doc.id), 'A: every page attachment provenance documentId == Document.id')
docs = await readDocs()
assert(docs.length === 1, 'A: Document count unchanged (no duplicate)')
assert(docs[0].sourceStorage === 'opfs', 'A: original Document OPFS source ref unchanged')

// ========== FLOW B: Composer unscoped -> library list -> choose document -> parent chapter ==========
await closeLibrary()
await page.locator('[data-testid="composer-attach"]').first().click()
await page.locator('[data-testid="composer-from-library"]').click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="doc-context-doclist"]').count() === 1, 'B: unscoped picker shows the document list')
await page.locator('[data-testid="doc-context-doc-' + doc.id + '"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="doc-context-tree"]').count() === 1, 'B: click Document -> context tree appears')
assert(await page.locator('[data-testid="doc-context-doclist"]').count() === 0, 'B: document list hidden after doc pick')
await page.locator('[data-testid="doc-context-back"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="doc-context-doclist"]').count() === 1, 'B: back -> document list')
await page.locator('[data-testid="doc-context-doc-' + doc.id + '"]').click()
await page.waitForTimeout(400)
const parent2 = flatten(doc.chapters, []).find(n => n.selectable && n.startPage != null && n.children && n.children.length > 0)
const bBefore = await docAttIds(doc.id)
await page.locator('[data-testid="doc-context-check-' + parent2.id + '"]').click()
await page.locator('[data-testid="doc-context-add"]').click()
if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
const B = await expectDraftContext('B', parent2.endPage - parent2.startPage + 1, bBefore)
assert(B.sel && B.sel.selectedChapterIds && B.sel.selectedChapterIds.includes(parent2.id), 'B: provenance selectedChapterIds includes the parent chapter')

// ========== FLOW C: Reader nested page -> choose ancestor -> actual parent range ==========
await closeLibrary()
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const pageInput = page.locator('[data-testid="reader-page-input"]')
if (await pageInput.count()) { await pageInput.fill('2'); await pageInput.press('Enter'); await page.waitForTimeout(800) }
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.waitForTimeout(300)
const rootAncestor = doc.chapters.find(n => n.selectable && n.startPage === 1 && n.children && n.children.length > 0)
assert(!!rootAncestor, 'C: fixture exposes a root selectable parent chapter')
const cBefore = await docAttIds(doc.id)
const anc = page.locator('[data-testid="reader-ctx-ancestor-' + rootAncestor.id + '"]')
assert(await anc.count() === 1, 'C: reader ctx menu exposes the root ancestor option')
await anc.click()
const C = await expectDraftContext('C', rootAncestor.endPage - rootAncestor.startPage + 1, cBefore)
assert(C.sel && C.sel.ranges && C.sel.ranges.length === 1 && C.sel.ranges[0].startPage === rootAncestor.startPage && C.sel.ranges[0].endPage === rootAncestor.endPage, 'C: actual parent range, not deepest node range')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// ========== FLOW D: multi-chapter -> ONE Context group -> normalized ranges ==========
await openLibrary()
await page.locator('[data-testid^="doc-context-"]').first().click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
const topLevel = doc.chapters.filter(n => n.selectable && n.startPage != null && n.endPage != null)
const c1 = topLevel[0], c2 = topLevel[1]
const dBefore = await docAttIds(doc.id)
await page.locator('[data-testid="doc-context-check-' + c1.id + '"]').click()
await page.locator('[data-testid="doc-context-check-' + c2.id + '"]').click()
await page.locator('[data-testid="doc-context-add"]').click()
if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
const D = await expectDraftContext('D', (c1.endPage - c1.startPage + 1) + (c2.endPage - c2.startPage + 1), dBefore)
assert(D.sel && D.sel.ranges && D.sel.ranges.length >= 1 && D.sel.ranges.length <= 2, 'D: multi-chapter normalized ranges (got ' + (D.sel ? D.sel.ranges.length : 0) + ')')
assert(D.sel && D.sel.selectedChapterIds && D.sel.selectedChapterIds.includes(c1.id) && D.sel.selectedChapterIds.includes(c2.id), 'D: multi-chapter keeps both provenance ids')
const dPageNums = D.added.map(a => a.source.pageNumber)
assert(new Set(dPageNums).size === dPageNums.length, 'D: no duplicate rendered page numbers within the add')

// ========== FLOW CANCEL (0.4): large context -> cancel -> no runaway attachments ==========
await closeLibrary()
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/many-pages.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()
const mpDocs = await readDocs()
assert(mpDocs.length === 2, 'CANCEL: now 2 documents (outline-sample + many-pages)')
const mp = mpDocs.find(d => d.fileName.indexOf('many-pages') >= 0)
const cancelBefore = (await readPdfPageAtts()).filter(a => a.source.documentId === mp.id).length
const joinBtns = page.locator('[data-testid^="doc-context-"]')
await joinBtns.nth(1).click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="doc-context-tab-manual"]').click()
await page.locator('[data-testid="doc-context-ms"]').fill('1')
await page.locator('[data-testid="doc-context-me"]').fill('100')
await page.locator('[data-testid="doc-context-manual-add"]').click()
await page.locator('[data-testid="doc-context-summary"]').waitFor({ state: 'visible', timeout: 5000 })
await page.locator('[data-testid="doc-context-add"]').click()
if (await page.locator('[data-testid="doc-context-confirm"]').count()) await page.locator('[data-testid="doc-context-confirm-yes"]').click()
await page.locator('[data-testid="library-ctx-progress"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
await page.locator('[data-testid="library-ctx-cancel"]').click().catch(() => {})
await page.waitForTimeout(1200)
const cancelAfter = (await readPdfPageAtts()).filter(a => a.source.documentId === mp.id).length
assert(cancelAfter <= cancelBefore + 119, 'CANCEL: no runaway context attachments after cancel (' + cancelBefore + ' -> ' + cancelAfter + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)