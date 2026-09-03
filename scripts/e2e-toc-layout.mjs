// Reader TOC nested-layout e2e (Windows/local, REAL Microsoft Edge).
// Uses the no-outline fixture + IndexedDB to build a REAL Chinese 3-level nested
// outline, then asserts the rendered TOC DOM layout: no horizontal overflow, each
// row spans the full usable width, the page number is not compressed, and the
// title keeps a reasonable width at TOC viewport 240 / 280 / 320px.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const NO_OUTLINE = 'test/fixtures/no-outline.pdf'
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
const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator(FILES_ENTRY).first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}

// --- import the no-outline doc ---
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(NO_OUTLINE)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- inject a REAL Chinese 3-level nested outline directly into the document ---
const chapters = [
  { id: 'c1', title: '绪论', level: 1, startPage: 1, endPage: 9, selectable: true, source: 'manual', children: [
    { id: 'c2', title: '一、自然地理学的研究对象和分科', level: 2, startPage: 5, endPage: 7, selectable: true, source: 'manual', children: [
      { id: 'c3', title: '第一节 地球在宇宙中的位置', level: 3, startPage: 7, endPage: 7, selectable: true, source: 'manual', children: [] },
    ] },
  ] },
]
await page.evaluate((chapters) => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ai-education-reader', 4)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('documents', 'readwrite')
      const store = tx.objectStore('documents')
      const getReq = store.getAll()
      getReq.onsuccess = () => {
        const doc = getReq.result.find(d => d.fileName === 'no-outline.pdf')
        if (!doc) { reject(new Error('no-outline document not found')); return }
        doc.chapters = chapters
        doc.chapterSource = 'manual'
        store.put(doc)
        tx.oncomplete = () => resolve(doc.id)
        tx.onerror = () => reject(tx.error)
      }
      getReq.onerror = () => reject(getReq.error)
    }
    req.onerror = () => reject(req.error)
  })
}, chapters)
// reload so the reader re-reads the injected chapters
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'no-outline.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// expand the 3-level hierarchy so all rows are visible
const expandAll = async () => {
  let clicks = 0
  while (clicks < 8) {
    const toggle = page.locator('[data-testid^="reader-toc-toggle-"]').filter({ hasText: '▸' }).first()
    if (await toggle.count() === 0) break
    await toggle.click()
    await page.waitForTimeout(120)
    clicks++
  }
}
await expandAll()
await page.waitForTimeout(300)
const titles = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(titles.join('|').includes('绪论'), 'TOC shows 绪论 (got ' + titles.join('|') + ')')
assert(titles.join('|').includes('一、自然地理学的研究对象和分科'), 'TOC shows L2 long title (got ' + titles.join('|') + ')')
assert(titles.join('|').includes('第一节 地球在宇宙中的位置'), 'TOC shows L3 title (got ' + titles.join('|') + ')')

// --- layout assertions at TOC viewport 240 / 280 / 320 ---
async function measureToc(widthPx) {
  return page.evaluate((width) => {
    const toc = document.querySelector('[data-testid="reader-toc"]')
    if (!toc) return null
    toc.style.width = width + 'px'
    void toc.offsetHeight
    const docOverflowX = document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    const tocClientW = toc.clientWidth
    const tocScrollW = toc.scrollWidth
    const tocOverflowX = tocScrollW <= tocClientW + 1
    const nodes = Array.from(document.querySelectorAll('[data-testid^="reader-toc-node-"]'))
    const rowInfo = nodes.map(n => {
      const nodeW = n.getBoundingClientRect().width
      const wrap = n.querySelector('[data-testid^="reader-toc-node-"] > div')
      const wrapW = wrap ? wrap.getBoundingClientRect().width : nodeW
      const row = n.querySelector('[data-testid^="reader-chapter-"]')
      const rowW = row ? row.getBoundingClientRect().width : 0
      const title = row && row.children[0] ? row.children[0] : null
      const range = row && row.children[1] ? row.children[1] : null
      const titleW = title ? title.getBoundingClientRect().width : 0
      const rangeW = range ? range.getBoundingClientRect().width : 0
      // row should fill the wrap minus the chevron column (24px) and gap (2px)
      const rowFills = rowW >= wrapW - 28
      return { nodeW, wrapW, rowW, titleW, rangeW, rowFills, hasRangeView: !!range && range.textContent !== '' }
    })
    const allRowsFill = rowInfo.length > 0 && rowInfo.every(r => r.rowFills)
    const minTitleW = rowInfo.length ? Math.min(...rowInfo.map(r => r.titleW)) : 0
    const maxRangeW = rowInfo.length ? Math.max(...rowInfo.map(r => r.rangeW)) : 0
    const minRangeW = rowInfo.length ? Math.min(...rowInfo.map(r => r.rangeW)) : 0
    return { docOverflowX, tocOverflowX, tocScrollW, tocClientW, allRowsFill, minTitleW, maxRangeW, minRangeW, nodeCount: rowInfo.length }
  }, widthPx)
}

for (const width of [240, 280, 320]) {
  const m = await measureToc(width)
  assert(m !== null, 'TOC measured at ' + width + 'px')
  if (!m) continue
  assert(m.docOverflowX, 'no document horizontal overflow at ' + width + 'px toc')
  assert(m.tocOverflowX, 'no toc horizontal scroll at ' + width + 'px (scrollW ' + m.tocScrollW + ' vs client ' + m.tocClientW + ')')
  assert(m.allRowsFill, 'each node row fills the row wrap at ' + width + 'px')
  assert(m.minTitleW >= 60, 'title keeps a reasonable width at ' + width + 'px (min ' + Math.round(m.minTitleW) + 'px)')
  assert(m.nodeCount >= 3, '3-level nested chapters rendered at ' + width + 'px (got ' + m.nodeCount + ')')
  assert(m.minRangeW >= 6 && m.maxRangeW <= 40, 'page number readable & not oversized at ' + width + 'px (min ' + Math.round(m.minRangeW) + ' / max ' + Math.round(m.maxRangeW) + 'px)')
}

// restore + snapshots for manual review
await page.evaluate(() => { const t = document.querySelector('[data-testid="reader-toc"]'); if (t) t.style.width = '' })
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(300)
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
await page.locator('[data-testid="reader-toc-toggle"]').click()
await page.waitForTimeout(400)
const m360 = await page.evaluate(() => {
  const toc = document.querySelector('[data-testid="reader-toc"]')
  const docOverflowX = document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  const tocClientW = toc ? toc.clientWidth : 0
  const tocScrollW = toc ? toc.scrollWidth : 0
  return { docOverflowX, tocClientW, tocScrollW, tocOverflowX: toc ? tocScrollW <= tocClientW + 1 : true }
})
assert(m360.docOverflowX, '360px: no document horizontal overflow')
assert(m360.tocOverflowX, '360px: no toc horizontal overflow (scrollW ' + m360.tocScrollW + ' vs client ' + m360.tocClientW + ')')

// take screenshots: mobile drawer open first, then desktop (toc visible in sidebar)
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForTimeout(300)
await page.locator('[data-testid="reader-toc-toggle"]').click()
await page.waitForTimeout(900)
// ensure the mobile drawer is actually visible for the screenshot (rows present)
const visible = await page.locator('[data-testid="reader-toc"]').isVisible()
assert(visible, '360px: mobile toc drawer visible when toggled')
const drawerRows = await page.evaluate(() => document.querySelectorAll('[data-testid^="reader-chapter-"]').length)
assert(drawerRows >= 3, '360px: mobile drawer shows the nested chapters (got ' + drawerRows + ' rows)')
// screenshot the drawer element itself (position:fixed; captures the panel regardless of overlay)
await page.locator('[data-testid="reader-toc"]').screenshot({ path: 'test/.playwright/toc-mobile.png' })
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(400)
await page.locator('[data-testid="document-reader"]').screenshot({ path: 'test/.playwright/toc-desktop.png' })

await browser.close()
const pageErrors = errors.length ? errors.join('\n') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
const failCount = results.filter(r => r.startsWith('FAIL')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed' + (failCount ? ' (' + failCount + ' failed)' : ''))
console.log('SCREENSHOTS: test/.playwright/toc-desktop.png, test/.playwright/toc-mobile.png')
process.exit(failCount === 0 ? 0 : 1)
