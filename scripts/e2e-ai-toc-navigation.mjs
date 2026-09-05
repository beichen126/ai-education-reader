// v1.2.0 P0 regression: AI TOC save -> Reader TOC navigation. On desktop the TOC sidebar is
// always visible (the .tocToggle button is mobile-only). This covers root + nested child nodes,
// click-immediately-after-save, and click-after-reload, asserting the reader-page-input AND the
// rendered canvas aria-label (PDF 第 N 页) equal the computed physical page. No real API (mock).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 25000 })
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
const inputVal = () => page.locator('[data-testid="reader-page-input"]').inputValue()
const canvasPage = () => page.locator('[data-testid="reader-page-img"]').getAttribute('aria-label')

async function seedAndSave() {
  await openLibrary()
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('[data-testid="reader-toc-ai"]').click()
  await page.locator('[data-testid="toc-picker"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(800)
  await page.locator('[data-testid="toc-thumb-1"]').click(); await page.locator('[data-testid="toc-thumb-2"]').click(); await page.locator('[data-testid="toc-thumb-3"]').click()
  await page.evaluate(() => { ;(globalThis).__dshMockAiToc = (req) => {
    if (req.phase === 'structure') return '{"id":"r0001","level":1}\n{"id":"r0002","level":2}\n{"id":"r0003","level":2}\n{"id":"r0004","level":2}'
    const si = (n) => { const i = req.pages.indexOf(n) + 1; return i > 0 ? i : 1 }
    const rows = [
      { title: '第一部分 方法论', pageLabel: '/1', sourceImageIndex: si(req.pages[0]) },
      { title: '第一节 题型', pageLabel: '/3', sourceImageIndex: si(req.pages[0]) },
      { title: '第三节 阅读', pageLabel: '/5', sourceImageIndex: si(req.pages[1]) },
      { title: '第六节 常见失误', pageLabel: '/24', sourceImageIndex: si(req.pages[1]) },
    ]
    return rows.map(r => JSON.stringify(r)).join('\n')
  } })
  await page.locator('[data-testid="toc-picker-start"]').click()
  await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 20000 })
  // single anchor calibration: /1 -> PDF 8  (offset 7 -> /3=10, /5=12, /24=31)
  await page.locator('[data-testid="toc-review-item-0"]').click()
  await page.locator('[data-testid="toc-review-page"]').fill('8')
  await page.locator('[data-testid="toc-review-calibrate"]').click()
  await page.waitForTimeout(400)
  const sps = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="toc-review-item-"]')).map(el => el.getAttribute('data-sp')))
  assert(sps.join(',') === '8,10,12,31', 'review rows carry mapped pages 8,10,12,31 (got ' + sps.join(',') + ')')
  for (const i of [0, 1, 2, 3]) await page.locator('[data-testid="toc-review-ok-' + i + '"]').click()
  await page.locator('[data-testid="toc-review-save"]').click()
  await page.locator('[data-testid="toc-review"]').waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(600)
}
async function clickAndAssert(title, expectPage) {
  const row = page.locator('[data-testid^="reader-chapter-"]').filter({ hasText: title }).first()
  await row.click()
  await page.waitForTimeout(700)
  const pv = (await inputVal()).trim()
  const cv = await canvasPage()
  assert(pv === String(expectPage), 'click "' + title + '" -> reader-page-input = ' + expectPage + ' (got ' + pv + ')')
  assert(cv === 'PDF 第 ' + expectPage + ' 页', 'click "' + title + '" -> canvas aria-label PDF 第 ' + expectPage + ' 页 (got ' + cv + ')')
}

// --- save then click immediately (no reload) ---
await seedAndSave()
const roots = await page.locator('[data-testid^="reader-chapter-"]').allTextContents()
assert(roots.some(t => t.includes('第一部分 方法论')), 'AI TOC root saved (got ' + JSON.stringify(roots) + ')')
await clickAndAssert('第一部分 方法论', 8)
await page.locator('[data-testid^="reader-toc-toggle-"]').first().click()
await page.waitForTimeout(400)
await clickAndAssert('第六节 常见失误', 31)

// --- reload -> reopen -> click again (persistence) ---
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid^="doc-open-"]').filter({ hasText: 'many-pages.pdf' }).first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
// expand the nested parent to reveal the child, then click both
await page.locator('[data-testid^="reader-toc-toggle-"]').first().click()
await page.waitForTimeout(400)
await clickAndAssert('第一部分 方法论', 8)
await clickAndAssert('第六节 常见失误', 31)

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && pageErrors === '(none)' ? 0 : 1)
