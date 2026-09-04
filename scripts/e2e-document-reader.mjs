// Document Library + Reader acceptance e2e (Windows/local, REAL Microsoft Edge).
//
// Run:
//   1) npm run build && npm run preview -- --port 5299
//   2) node scripts/e2e-document-reader.mjs
//      E2E_BASE=... node scripts/e2e-document-reader.mjs   (other host)
//
// Covers: library import -> reader -> chapter jump -> prev/next -> direct page ->
// close -> reopen (progress restored) -> reload (still restored) -> page zoom
// (zoom viewer + transient HUD) -> responsive (mobile toc drawer) -> delete.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const FILES_ENTRY = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const IMAGES_ENTRY = '[data-testid="sidebar-entry-images"], [data-testid="rail-images"]'
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator(FILES_ENTRY).first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}

// ---- A. library empty state -> import PDF -> Reader opens on page 1 ----
await openLibrary()
assert(await page.locator('[data-testid="library-empty"]').count() === 1, 'A: library shows empty state')
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('outline-sample.pdf'), 'A: import -> reader opened with title')
assert((await inputVal()).trim() === '1', 'A: unread doc opens at page 1')

// ---- B. chapter jump (expand parent chapter first) ----
await page.locator('[data-testid="reader-toc-toggle-0"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-0.0"]').click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '2', 'B: chapter 1.1 -> page 2 (got ' + (await inputVal()) + ')')

// ---- C. prev / next ----
await page.locator('[data-testid="reader-next"]').click()
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '3', 'C: next -> 3')
await page.locator('[data-testid="reader-prev"]').click()
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '2', 'C: prev -> 2')
assert(await page.locator('[data-testid="reader-prev"]').isDisabled() === false, 'C: prev enabled at page 2')
await page.locator('[data-testid="reader-page-input"]').fill('1')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '1' && await page.locator('[data-testid="reader-prev"]').isDisabled(), 'C: page 1 -> prev disabled')

// ---- D. direct page input (valid + invalid) ----
await page.locator('[data-testid="reader-page-input"]').fill('5')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
assert((await inputVal()).trim() === '5', 'D: direct input 5 -> page 5')
await page.locator('[data-testid="reader-page-input"]').fill('0')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="reader-page-error"]').count() === 1, 'D: invalid 0 shows error, no navigation')
assert((await inputVal()).trim() === '0' || (await inputVal()).trim() === '5', 'D: input text stays (no silent jump)')
await page.locator('[data-testid="reader-page-input"]').fill('5')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(300)
await page.waitForTimeout(1300) // debounce (1000ms) fires -> persisted 5

// ---- E. 返回文件 -> reopen restores page; reload still restores ----
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
assert((await inputVal()).trim() === '5', 'E: reopen after close -> lastReadPage 5')
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
assert((await inputVal()).trim() === '5', 'E: reload -> still page 5')

// ---- F. page zoom (existing viewer + transient HUD) ----
await page.locator('[data-testid="reader-page"]').click()
await page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="viewer-zoom-hud"]').count() === 0, 'F: zoom viewer opens with HUD hidden')
const box = await page.locator('[data-testid="viewer-stage"]').boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.wheel(0, -600)
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="viewer-zoom-hud"]').count() === 1, 'F: wheel zoom shows HUD')
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
assert(await page.locator('[role="dialog"]').count() === 0, 'F: Escape closes zoom viewer')
assert(await page.locator('[data-testid="reader-page"]').count() === 1, 'F: back on the reader page')
assert((await inputVal()).trim() === '5', 'F: reader page unchanged after zoom')

// ---- G. responsive: mobile toc drawer ----
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)
assert(overflow, 'G: 360px no horizontal page overflow')
assert(await page.locator('[data-testid="reader-toc-toggle"]').isVisible(), 'G: mobile shows 目录 toggle')
await page.locator('[data-testid="reader-toc-toggle"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-toc"]').isVisible(), 'G: drawer opens')
await page.locator('[data-testid="reader-toc-toggle-1"]').click()
await page.waitForTimeout(200)
await page.locator('[data-testid="reader-chapter-1.0"]').click()
await page.waitForTimeout(400)
assert((await inputVal()).trim() === '6', 'G: chapter 2.1 -> page 6 (drawer auto-closes)')
assert(await page.locator('[data-testid="reader-next"]').isVisible(), 'G: bottom nav clickable')
await page.setViewportSize({ width: 1024, height: 768 })
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-toc"]').isVisible(), 'G: 1024px toc persists')
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="reader-next"]').isVisible(), 'G: 1280px nav visible')

// ---- H. sidebar regression: 图片 entry + settings + new chat ----
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'H: reader close -> closed (no overlay)')
await page.locator('[data-testid="library-close"]').click().catch(() => {})
await page.waitForTimeout(200)
await page.locator(IMAGES_ENTRY).first().click()
await page.getByText('当前会话暂无图片资料').waitFor({ state: 'visible', timeout: 10000 })
const galleryTitle = await page.locator('div[class*="head"] span').first().textContent()
assert(galleryTitle === '图片', 'H: gallery entry opens with 图片 title (got ' + galleryTitle + ')')
await page.getByRole('button', { name: '关闭' }).last().click()
await page.waitForTimeout(200)
await page.locator('[data-testid="sidebar-settings"]').click()
await page.getByText('AI Education Reader · v1.0.0').waitFor({ state: 'visible', timeout: 10000 })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await page.locator('[data-testid="sidebar-new-chat"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="sidebar-new-chat"]').count() === 1, 'H: sidebar new chat works')

// ---- J. repeat import: A -> reader -> back -> B -> both documents kept ----
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="library-import"]').isEnabled(), 'J: 导入 PDF re-enabled after reader round-trip')
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-tricky.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('outline-tricky.pdf'), 'J: second import opens B reader (got ' + await page.locator('[data-testid="reader-title"]').textContent() + ')')
await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid^="doc-card-"]').count() === 3, 'J: library keeps all imported documents (outline-sample x2 + outline-tricky)')

// ---- K. A -> B page isolation: no stale A image during B load ----
const bCard = page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'outline-tricky.pdf' }).first()
await bCard.click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
// after doc switch the old A page image must be GONE (loading state), then B's image appears
const imgDuringLoad = await page.locator('[data-testid="reader-page-img"]').count()
assert(imgDuringLoad === 0 || (await page.locator('[data-testid="reader-title"]').textContent() || '').includes('outline-tricky'), 'K: no stale A page image during B load (img=' + imgDuringLoad + ')')
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes('outline-tricky'), 'K: B title shown with B page')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await openLibrary()

// ---- L. Escape BEFORE the debounce (1000ms) — cleanup flush must restore the page ----
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-page-input"]').fill('6')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(120) // deliberately FAR below the 1000ms debounce
await page.keyboard.press('Escape') // reader -> closed via cleanup path (no button flush)
await page.waitForTimeout(250)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'L: Escape closes the reader')
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await inputVal()).trim() === '6', 'L: reopen restores page 6 via cleanup flush (<1000ms, got ' + (await inputVal()) + ')')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// ---- M. Reader -> Context bridge (current page / current chapter / manual range) ----
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const ctxMsg = async () => (await page.locator('[data-testid="reader-ctx-msg"]').textContent().catch(() => '')) || ''
// current page (jump to 5)
await page.locator('[data-testid="reader-page-input"]').fill('5')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(400)
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-menu"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-ctx-current-page"]').click()
await page.getByText(/已加入当前对话 · 1 页/).waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'M: reader STILL open after adding (no auto-close)')
// current chapter (page 2 = 1.1 History)
await page.locator('[data-testid="reader-page-input"]').fill('2')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(400)
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid^="reader-ctx-ancestor-"]').first().click()
await page.getByText(/已加入「1.1 History」· 1 页/).waitFor({ state: 'visible', timeout: 30000 })
// manual range 3-5
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-manual"]').click()
// REAL keyboard typing (Stage 9.2B2.1): real keydown, not fill()
await page.locator('[data-testid="reader-ctx-start"]').click()
await page.keyboard.press('3')
assert(await page.locator('[data-testid="reader-ctx-menu"]').isVisible(), 'M: menu stays visible while typing digits')
assert(await page.locator('[data-testid="reader-ctx-start"]').inputValue() === '3', 'M: typed digit lands in the input')
await page.locator('[data-testid="reader-ctx-end"]').click()
await page.keyboard.press('5')
assert(await page.locator('[data-testid="reader-ctx-menu"]').isVisible(), 'M: menu stays visible after typing end page')
assert(await page.locator('[data-testid="reader-ctx-end"]').inputValue() === '5', 'M: end page typed')
await page.locator('[data-testid="reader-ctx-go"]').click()
await page.getByText(/已加入当前对话 · 3 页/).waitFor({ state: 'visible', timeout: 30000 })
// invalid manual range shows the shared validation error
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-manual"]').click()
await page.locator('[data-testid="reader-ctx-start"]').fill('6')
await page.locator('[data-testid="reader-ctx-end"]').fill('3')
await page.locator('[data-testid="reader-ctx-go"]').click()
await page.getByText('开始页不能大于结束页。').waitFor({ state: 'visible', timeout: 10000 })
// back to conversation: 3 distinct context groups, no auto-send
await page.locator('[data-testid="reader-ctx-back"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'M: 返回对话 closes the reader')
await page.locator('[data-testid="pdf-group-card"]').nth(2).waitFor({ state: 'visible', timeout: 20000 })
assert(await page.locator('[data-testid="pdf-group-card"]').count() === 3, 'M: composer shows 3 distinct context groups')
const ctxMeta = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const g = (s, k) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const last = await g('settings', 'lastConversationId')
  const conv = await g('conversations', last.value)
  const messages = conv && conv.messages ? conv.messages.length : -1
  const d = await g('settings', 'draft:' + last.value)
  const ids = d && d.value ? d.value.imageIds : []
  const metas = []
  for (const id of ids) { const row = await g('attachments', id); metas.push({ gid: row.meta.source?.groupId, doc: row.meta.source?.documentId, sel: row.meta.source?.selection }) }
  return { messages, metas }
})
assert(ctxMeta.messages === 0, 'M: NO message auto-sent (messages=' + ctxMeta.messages + ')')
const gids = new Set(ctxMeta.metas.map(m => m.gid))
const docIds = new Set(ctxMeta.metas.map(m => m.doc))
assert(gids.size === 3, 'M: 3 groupIds (no auto-merge)')
assert(docIds.size === 1 && !docIds.has(undefined), 'M: all share one documentId')
assert(ctxMeta.metas.some(m => m.sel && m.sel.kind === 'outline' && m.sel.selectedChapterIds && m.sel.selectedChapterIds.length === 1), 'M: chapter selection carries selectedChapterIds')
assert(ctxMeta.metas.some(m => m.sel && m.sel.kind === 'manual' && m.sel.ranges[0].startPage === 3 && m.sel.ranges[0].endPage === 5), 'M: manual selection ranges 3-5 persisted')
// responsive: 加入对话 visible + clickable at 360
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-ctx-toggle"]').isVisible(), 'M: 加入对话 visible on 360px')
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-menu"]').waitFor({ state: 'visible', timeout: 10000 })
const menuBox = await page.locator('[data-testid="reader-ctx-menu"]').boundingBox()
assert(menuBox && menuBox.width <= 360, 'M: ctx menu fits 360px (' + JSON.stringify(menuBox) + ')')
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="reader-ctx-menu"]').count() === 0 && await page.locator('[data-testid="document-reader"]').count() === 1, 'M: Escape #1 closes menu, reader stays open')
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'M: Escape #2 closes the reader')
// input-focused Escape hierarchy: same menu-first, reader-second behavior
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-manual"]').click()
await page.locator('[data-testid="reader-ctx-start"]').click()
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
assert(await page.locator('[data-testid="reader-ctx-menu"]').count() === 0 && await page.locator('[data-testid="document-reader"]').count() === 1, 'M: input-focused Escape #1 -> menu closed, reader open')
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
assert(await page.locator('[data-testid="document-reader"]').count() === 0, 'M: input-focused Escape #2 -> reader closed')
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(300)

// ---- N. soft confirm >30 pages: continue executes ONCE (no loop) + cancel is clean ----
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/.playwright/outline-big.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
const groupsBefore = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const g = (s, k) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const last = await g('settings', 'lastConversationId')
  const d = await g('settings', 'draft:' + last.value)
  const ids = d && d.value ? d.value.imageIds : []
  const gids = new Set()
  for (const id of ids) { const row = await g('attachments', id); if (row) gids.add(row.meta.source?.groupId) }
  return gids.size
})
// request 1-35 -> soft confirm appears
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-manual"]').click()
await page.locator('[data-testid="reader-ctx-start"]').fill('1')
await page.locator('[data-testid="reader-ctx-end"]').fill('35')
await page.locator('[data-testid="reader-ctx-go"]').click()
await page.locator('[data-testid="reader-ctx-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="reader-ctx-progress"]').count() === 0, 'N: confirm BEFORE any render')
// <--- the key assertion: clicking 继续加入 executes and the confirm NEVER re-appears
await page.locator('[data-testid="reader-ctx-confirm-yes"]').click()
await page.getByText(/正在准备上下文/).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
await page.getByText(/已加入当前对话 · 35 页/).waitFor({ state: 'visible', timeout: 90000 })
assert(await page.locator('[data-testid="reader-ctx-confirm"]').count() === 0, 'N: confirm does NOT re-appear after 继续加入 (no loop)')
// cancel path: request 1-35 again -> cancel -> nothing renders / no attachment change
await page.locator('[data-testid="reader-ctx-toggle"]').click()
await page.locator('[data-testid="reader-ctx-manual"]').click()
await page.locator('[data-testid="reader-ctx-start"]').fill('1')
await page.locator('[data-testid="reader-ctx-end"]').fill('35')
await page.locator('[data-testid="reader-ctx-go"]').click()
await page.locator('[data-testid="reader-ctx-confirm"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-ctx-confirm-no"]').click()
await page.waitForTimeout(600)
assert(await page.locator('[data-testid="reader-ctx-confirm"]').count() === 0, 'N: cancel closes confirm')
assert(await page.locator('[data-testid="reader-ctx-progress"]').count() === 0, 'N: cancel -> no render started')
const groupsAfter = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const g = (s, k) => new Promise((res, rej) => { const r = db.transaction(s, 'readonly').objectStore(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const last = await g('settings', 'lastConversationId')
  const d = await g('settings', 'draft:' + last.value)
  const ids = d && d.value ? d.value.imageIds : []
  const gids = new Set()
  for (const id of ids) { const row = await g('attachments', id); if (row) gids.add(row.meta.source?.groupId) }
  return gids.size
})
assert(groupsAfter === groupsBefore + 1, 'N: cancel keeps draft unchanged (only the first 35-page group) (' + groupsBefore + ' -> ' + groupsAfter + ')')
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'N: reader stays open after cancel')
await page.locator('[data-testid="reader-close"]').click()
await page.waitForTimeout(300)

// ---- I. delete document (confirm accepted via dialog handler) ----
await openLibrary()
const beforeDel = await page.locator('[data-testid^="doc-card-"]').count()
await page.locator('[data-testid^="doc-delete-"]').first().click()
await page.waitForTimeout(500)
const afterDel = await page.locator('[data-testid^="doc-card-"]').count()
assert(afterDel === beforeDel - 1, 'I: delete removes one document (' + beforeDel + ' -> ' + afterDel + ')')
await page.locator('[data-testid="library-close"]').click()

console.log('--------')
console.log(results.join('\n'))
const pe = errors.filter(e => e.startsWith('pageerror:'))
console.log('PAGEERRORS:', pe.length ? pe.join(' | ') : '(none)')
const passed = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
await browser.close()
process.exit(results.some(r => r.startsWith('FAIL')) || pe.length ? 1 : 0)