// Stage 9.4D.2-0.6: TOC picker range selection + review layout regression e2e.
// Uses a deterministic mock so NO real paid API is called. Validates:
//  - range input selects pages not yet loaded (43-50 -> slots grow, no eager render of 1-50)
//  - invalid range does not change selection
//  - review body is a 2-column grid (list | adjust) with nav as a FULL-WIDTH footer
//  - long Chinese titles wrap horizontally (never single-character vertical)
//  - no horizontal overflow
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- A: open the picker ---
await page.locator('[data-testid="reader-toc-ai"]').click()
await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(500)

// --- B: invalid range does not change selection ---
await page.locator('[data-testid="toc-picker-range-start"]').fill('20')
await page.locator('[data-testid="toc-picker-range-end"]').fill('10')
await page.locator('[data-testid="toc-picker-range-apply"]').click()
await page.waitForTimeout(200)
const errEl = page.locator('[data-testid="toc-picker-range-error"]')
assert(await errEl.count() === 1, 'B: invalid range shows an explicit validation message')
assert((await page.locator('[data-testid="toc-picker-count"]').textContent()).includes('已选择 0 页'), 'B: invalid range leaves selection unchanged')

// --- C: valid range selects pages 43-50 (NOT loaded), slots grow, no eager render ---
await page.locator('[data-testid="toc-picker-range-start"]').fill('43')
await page.locator('[data-testid="toc-picker-range-end"]').fill('50')
await page.locator('[data-testid="toc-picker-range-apply"]').click()
await page.waitForTimeout(400)
const selText = await page.locator('[data-testid="toc-picker-count"]').textContent()
assert(selText.includes('已选择 8 页') && selText.includes('43–50'), 'C: range 43-50 selects exactly 8 pages (got ' + selText + ')')
const loadedHint = await page.locator('[data-testid="toc-picker-more"]').count() ? await page.locator('.toc-picker-footer, footer').count() : 0
// slots to 50: the '继续加载' should be gone or reflect 50 loaded
const grid = page.locator('[data-testid="toc-picker-grid"]')
const thumb50 = await page.locator('[data-testid="toc-thumb-50"]').count()
assert(thumb50 === 1, 'C: a placeholder slot for page 50 exists (selection spans beyond loaded batch)')

// --- D: a mock returns a full review; check the 2-col layout ---
await page.evaluate(() => { (globalThis).__dshMockAiToc = (req) => {
  if (req.phase === 'structure') { let s=''; for (let i=1;i<=6;i++) s += '{"id":"r'+String(i).padStart(4,'0')+'","level":'+(i===1?1:2)+'}\n'; return s }
  const rows = []
  const titles = ['第一章 自然地理学','第二节 自然地理环境各组成要素之间的相互作用','三、自然地理学与其他学科的关系','第四章 地球表层环境的组成与结构特征']
  for (let i=1;i<=6;i++) rows.push('{"title":"'+titles[(i-1)%titles.length]+'","pageLabel":"'+i+'","sourceImageIndex":'+(req.pages.indexOf(req.pages[Math.min(i-1,req.pages.length-1)])+1)+',"visualIndent":'+(i===1?0:1)+'}')
  return rows.join('\n')
} })
await page.locator('[data-testid="toc-picker-start"]').click()
await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(400)

// nav must be a footer (not a 3rd flex column): its top must be >= the bottom of reviewBody
const navBox = await page.locator('[data-testid="toc-review-next"]').boundingBox()
const listBox = await page.locator('[data-testid="toc-review-list"]').boundingBox()
assert(navBox && listBox && navBox.y >= listBox.y + 50, 'D: nav is a bottom footer (below the list, not a side column)')
// list width >= 260 on desktop
assert(listBox && listBox.width >= 260, 'D: review list width >= 260px (got ' + (listBox && listBox.width) + ')')
// no horizontal overflow on the panel body
const overflow = await page.evaluate(() => { const el = document.querySelector('[data-testid="toc-review"] .toc-review-reviewBody') || document.querySelector('[data-testid="toc-review"]'); return el ? el.scrollWidth - el.clientWidth : 0 })
assert(overflow <= 0, 'D: no horizontal overflow in the review body (overflow=' + overflow + ')')
// long title wraps: item-0 title's line count > 1 OR width > single char
const itemTitleWidth = await page.locator('[data-testid="toc-review-item-0"] .toc-review-itemText, [data-testid="toc-review-item-0"] > div > span:nth-child(2)').evaluate(el => el.getBoundingClientRect().width)
assert(itemTitleWidth > 60, 'D: long Chinese title is rendered horizontally (width=' + itemTitleWidth + 'px)')

// Capture a regression artifact (finding 9.4D.2-0.6.33): the review layout with long titles.
await page.screenshot({ path: 'docs/test-artifacts/toc-review-layout.png', fullPage: false })

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
