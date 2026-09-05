// v1.1.3 regression e2e: AI TOC pageLabel normalization + numeric offset calibration.
// Reproduces the reported "全部页码待确认" bug: a PDF with NO native PageLabels (labels null)
// + AI-transcribed decorated labels ("/1", "/3", "/5", "/24"). Under the old code the items stay
// unresolved AND the offset UI is hidden (it was gated on PDF PageLabels), forcing the user to
// fill every row by hand. This e2e asserts that (a) the calibration UI now appears even without
// PageLabels, (b) one anchor calibration recalcs every canonical-Arabic item, (c) the raw "/1"
// label is still shown, (d) non-numeric labels stay unresolved (never coerced), (e) the reader
// jumps to the computed physical page, and (f) the review can then be saved. Uses the
// deterministic mock seam — no paid API.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'   // 260 pages, 0 native PageLabels -> the bug case
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
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- A: open the picker and select 3 TOC pages ---
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(800)
await page.locator('[data-testid="toc-thumb-1"]').click()
await page.locator('[data-testid="toc-thumb-2"]').click()
await page.locator('[data-testid="toc-thumb-3"]').click()
assert((await page.locator('[data-testid="toc-picker-start"]').textContent()).includes('3 页'), 'A: picker shows 3 selected pages')

// --- B: mock seam -> decorated pageLabels; PDF has NO PageLabels ---
await page.evaluate(() => {
  ;(globalThis).__dshMockAiToc = (req) => {
    if (req.phase === 'structure') {
      return ['{"id":"r0001","level":1}', '{"id":"r0002","level":1}', '{"id":"r0003","level":2}', '{"id":"r0004","level":2}', '{"id":"r0005","level":2}', '{"id":"r0006","level":1}'].join('\n')
    }
    const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 }
    const rows = [
      { title: '前言', pageLabel: 'iii', sourceImageIndex: si(req.pages[0]), visualIndent: 0, numbering: '' },
      { title: '第一部分 方法论', pageLabel: '/1', sourceImageIndex: si(req.pages[0]), visualIndent: 0, numbering: '第一部分' },
      { title: '第一节 题型的设计类型', pageLabel: '/3', sourceImageIndex: si(req.pages[0]), visualIndent: 0, numbering: '' },
      { title: '第三节 阅读能力与写作能力', pageLabel: '/5', sourceImageIndex: si(req.pages[1]), visualIndent: 0, numbering: '' },
      { title: '第六节 常见失误', pageLabel: '/24', sourceImageIndex: si(req.pages[1]), visualIndent: 0, numbering: '' },
      { title: '附录', pageLabel: 'A-1', sourceImageIndex: si(req.pages[2]), visualIndent: 0, numbering: '' },
    ]
    return rows.map(r => JSON.stringify(r)).join('\n')
  }
})
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
const itemCount = await page.locator('[data-testid^="toc-review-item-"]').count()
assert(itemCount === 6, 'B: review lists 6 items (got ' + itemCount + ')')

// --- C: raw decorated labels are shown; all unresolved (the bug state) ---
const item1Text = await page.locator('[data-testid="toc-review-item-1"]').textContent()
assert(item1Text.includes('/1'), 'C: item 1 shows raw "/1" (got ' + JSON.stringify(item1Text) + ')')
assert(item1Text.includes('页码待确认'), 'C: item 1 starts unresolved (页码待确认)')
const item4Text = await page.locator('[data-testid="toc-review-item-4"]').textContent()
assert(item4Text.includes('/24'), 'C: item 4 shows raw "/24"')

// --- D: calibration UI present EVEN THOUGH the PDF has no PageLabels; select the anchor ---
await page.locator('[data-testid="toc-review-item-1"]').click()
await page.waitForTimeout(200)
assert((await page.locator('[data-testid="toc-review-calib"]').count()) === 1, 'D: calibration UI present without PDF PageLabels')
assert((await page.locator('[data-testid="toc-review-calibrate"]').count()) === 1, 'D: "以当前项校准全书" button present')
const calPrinted = await page.locator('[data-testid="toc-review-calib-printed"]').textContent()
assert(calPrinted === '/1', 'D: calibration shows current printed page /1 (got ' + calPrinted + ')')

// --- E: one anchor calibration recalcs every canonical-Arabic item ---
await page.locator('[data-testid="toc-review-page"]').fill('8')
await page.locator('[data-testid="toc-review-calibrate"]').click()
await page.waitForTimeout(400)
const sp = [0, 1, 2, 3, 4, 5].map(i => 'unused')
const data = {}
for (const i of [0, 1, 2, 3, 4, 5]) data[i] = await page.locator('[data-testid="toc-review-item-' + i + '"]').getAttribute('data-sp')
assert(data[0] === '', 'E: "iii" (前言) stays unresolved (got ' + JSON.stringify(data[0]) + ')')
assert(data[1] === '8', 'E: "/1" -> PDF 8 (anchor, got ' + data[1] + ')')
assert(data[2] === '10', 'E: "/3" -> PDF 10 (got ' + data[2] + ')')
assert(data[3] === '12', 'E: "/5" -> PDF 12 (got ' + data[3] + ')')
assert(data[4] === '31', 'E: "/24" -> PDF 31 (got ' + data[4] + ')')
assert(data[5] === '', 'E: "A-1" (附录) stays unresolved (got ' + JSON.stringify(data[5]) + ')')

// --- F: not every row is 页码待确认 anymore (the bug was 45/45) ---
const warn = await page.locator('[data-testid="toc-review-unresolved"]').textContent()
assert(warn.includes('2 项页码待确认'), 'F: only 2 rows remain unresolved (got ' + warn + ')')
assert(!warn.includes('6 项页码待确认'), 'F: no longer ALL rows unresolved')
const offsetVal = await page.locator('[data-testid="toc-review-offset"]').inputValue()
assert(offsetVal === '7', 'F: derived offset shown (7) in advanced field (got ' + offsetVal + ')')
const rawStill = await page.locator('[data-testid="toc-review-item-4"]').textContent()
assert(rawStill.includes('/24'), 'F: raw "/24" label still displayed after offset')

// --- G: click a mapped row -> reader jumps to the computed physical page ---
await page.locator('[data-testid="toc-review-item-4"]').click()
await page.waitForTimeout(500)
const cur = (await inputVal()).trim()
assert(cur === '31', 'G: click 第六节 jumps reader to computed page 31 (got ' + cur + ')')

// --- G2 (item 6 / P0): the PDF stays fully operable while the review is docked ---
const g2Base = (await inputVal()).trim()
await page.locator('[data-testid="reader-next"]').click()
await page.waitForTimeout(400)
const g2Next = (await inputVal()).trim()
assert(g2Next === String(Number(g2Base) + 1), 'G2: PDF 下一页 button works while review open (' + g2Base + ' -> ' + g2Next + ')')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(350)
const g2Arrow = (await inputVal()).trim()
assert(g2Arrow === String(Number(g2Next) + 1), 'G2: ArrowRight pages PDF while review open (focus not in input) (' + g2Next + ' -> ' + g2Arrow + ')')
// Focus inside the review title input: in-field arrow keys must NOT page the PDF.
await page.locator('[data-testid="toc-review-title"]').focus()
const g2Before = (await inputVal()).trim()
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(300)
const g2After = (await inputVal()).trim()
assert(g2After === g2Before, 'G2: ArrowLeft inside a text input does NOT page the PDF (' + g2Before + ' -> ' + g2After + ')')

// --- H: resolve the remaining 2 non-numeric rows, mark everything verified, save ---
await page.locator('[data-testid="toc-review-item-0"]').click()   // 前言 (iii)
await page.locator('[data-testid="toc-review-page"]').fill('2')
await page.locator('[data-testid="toc-review-item-5"]').click()   // 附录 (A-1)
await page.locator('[data-testid="toc-review-page"]').fill('40')
for (const i of [0, 1, 2, 3, 4, 5]) { await page.locator('[data-testid="toc-review-ok-' + i + '"]').click() }
await page.locator('[data-testid="toc-review-save"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'detached', timeout: 10000 })
await page.waitForTimeout(600)
const toc = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
const tocJoin = toc.join('|')
assert(tocJoin.includes('前言'), 'H: saved TOC root 前言 present (got ' + tocJoin + ')')
assert(tocJoin.includes('第一部分 方法论'), 'H: saved TOC root 第一部分 方法论 present (got ' + tocJoin + ')')
assert(tocJoin.includes('附录'), 'H: saved TOC root 附录 present (got ' + tocJoin + ')')
// level-2 items are nested under 第一部分 (only it has a toggle); expand it to confirm the full tree.
await page.locator('[data-testid^="reader-toc-toggle-"]').first().click()
await page.waitForTimeout(300)
const kids = (await page.locator('[data-testid^="reader-chapter-"]').allTextContents()).join('|')
assert(kids.includes('第一节 题型的设计类型') && kids.includes('第六节 常见失误'), 'H: expanded 第一部分 shows its children (got ' + kids + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && pageErrors === '(none)' ? 0 : 1)
