import { launchBrowser } from './e2e-browser.mjs'
import { openAppDb } from './e2e-idb.mjs'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5299/ai-education-reader/'
const PDF = 'test/fixtures/many-pages.pdf'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-close"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
await openLibrary()

const docs = await openAppDb(page, { store: 'documents' })
const doc = docs[0]
const chapter = { id: 'v210-range-chapter', title: '第一章 绪论', level: 1, startPage: 10, endPage: 19, selectable: true, source: 'manual', children: [] }
doc.chapters = [chapter]
doc.chapterSource = 'mixed'
await openAppDb(page, { store: 'documents', operation: 'put', value: doc })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await openLibrary()
await page.locator('[data-testid="doc-context-' + doc.id + '"]').click()
await page.locator('[data-testid="doc-context-picker"]').waitFor({ state: 'visible', timeout: 10000 })

const actual = page.locator('[data-testid="doc-context-actual-' + chapter.id + '"]')
const mode = page.locator('[data-testid="doc-context-mode-' + chapter.id + '"]')
await mode.waitFor({ state: 'visible', timeout: 10000 })
assert(!(await actual.isVisible().catch(() => false)), 'V210-RED range row removes the visible left-side duplicate range')
const triggerText = (await mode.textContent()) || ''
assert(triggerText.includes('[10,20)') || triggerText.includes('[10,20]'), 'V210-RED range trigger displays complete page numbers')
await mode.click({ force: true })
const popup = page.locator('[role="listbox"]')
assert(await popup.isVisible().catch(() => false), 'V210-RED range opens a real DOM listbox popup')
if (await popup.isVisible().catch(() => false)) {
  const options = popup.locator('[role="option"]')
  const texts = await options.allTextContents()
  assert(texts.some(text => text.includes('左闭右开') && text.includes('[10,20)')), 'V210-RED exclusive option includes semantic name and complete range')
  assert(texts.some(text => text.includes('左闭右闭') && text.includes('[10,20]')), 'V210-RED inclusive option includes semantic name and complete range')
  const metrics = await popup.evaluate(element => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, width: rect.width }
  })
  assert(metrics.fontSize === '11px' && metrics.lineHeight === '16px' && metrics.width <= 176, 'V210-RED popup has compact measured typography and width')
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
