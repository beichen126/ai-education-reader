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
  const guide = page.locator('[data-testid="product-guide"]')
  if (await guide.isVisible().catch(() => false)) {
    await guide.locator('[data-testid="product-guide-close"]').click()
    await guide.waitFor({ state: 'detached', timeout: 10000 })
  }
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
assert(await mode.getAttribute('aria-haspopup') === 'listbox', 'V210-RED range trigger exposes listbox semantics')
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
    const option = element.querySelector('[role="option"]')
    const optionStyle = option ? getComputedStyle(option) : null
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, width: rect.width, optionMinHeight: option ? option.getBoundingClientRect().height : 0, optionLineHeight: optionStyle?.lineHeight }
  })
  assert(metrics.fontSize === '11px' && metrics.lineHeight === '16px' && metrics.width <= 176 && metrics.optionMinHeight >= 26 && metrics.optionLineHeight === '16px', 'V210-RED popup has compact measured typography, width, and option rows')
  assert(await mode.getAttribute('aria-expanded') === 'true' && await mode.getAttribute('aria-controls') === await popup.getAttribute('id'), 'V210-RED trigger controls the open popup')
}

await page.keyboard.press('Escape')
await mode.focus()
await page.keyboard.press('Space')
await popup.waitFor({ state: 'visible', timeout: 5000 })
await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option')
assert(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'option'), 'V210-RED Space opens the range list and focuses an option')
await page.keyboard.press('Home')
await page.waitForFunction(() => document.activeElement?.textContent?.includes('左闭右开') === true)
assert(await page.evaluate(() => document.activeElement?.textContent?.includes('左闭右开') === true), 'V210-RED Home focuses the first range option')
await page.keyboard.press('End')
await page.waitForFunction(() => document.activeElement?.textContent?.includes('左闭右闭') === true)
assert(await page.evaluate(() => document.activeElement?.textContent?.includes('左闭右闭') === true), 'V210-RED End focuses the last range option')
await page.keyboard.press('ArrowUp')
await page.waitForFunction(() => document.activeElement?.textContent?.includes('左闭右开') === true)
assert(await page.evaluate(() => document.activeElement?.textContent?.includes('左闭右开') === true), 'V210-RED ArrowUp moves to the previous range option')
await page.keyboard.press('ArrowDown')
await page.waitForFunction(() => document.activeElement?.textContent?.includes('左闭右闭') === true)
assert(await page.evaluate(() => document.activeElement?.textContent?.includes('左闭右闭') === true), 'V210-RED ArrowDown moves to the next range option')
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid')?.startsWith('doc-context-mode-') === true)
assert(!(await popup.isVisible().catch(() => false)) && await page.evaluate(() => document.activeElement?.getAttribute('data-testid')?.startsWith('doc-context-mode-') === true), 'V210-RED Enter selects and returns focus to the trigger')

await page.waitForFunction(() => document.querySelector('[data-testid^="doc-context-mode-"]')?.getAttribute('aria-expanded') === 'false')
await mode.click({ force: true })
await popup.waitFor({ state: 'visible', timeout: 5000 })
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('[role="listbox"]') && document.activeElement?.getAttribute('data-testid')?.startsWith('doc-context-mode-') === true)
assert(!(await popup.isVisible().catch(() => false)) && await page.evaluate(() => document.activeElement?.getAttribute('data-testid')?.startsWith('doc-context-mode-') === true), 'V210-RED Escape closes and returns focus to the trigger')

await mode.click({ force: true })
await popup.waitFor({ state: 'visible', timeout: 5000 })
await page.locator('[data-testid="doc-context-picker"]').click({ position: { x: 8, y: 8 } })
assert(!(await popup.isVisible().catch(() => false)) && await page.locator('[data-testid="doc-context-picker"]').count() === 1, 'V210-RED outside click closes only the range popup')

for (const viewport of [{ width: 320, height: 240 }, { width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
  await page.setViewportSize(viewport)
  await mode.waitFor({ state: 'visible', timeout: 5000 })
  const before = await page.evaluate(() => ({ documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, width: window.innerWidth }))
  assert(before.documentScrollWidth <= before.width + 1 && before.bodyScrollWidth <= before.width + 1, 'V210-RED ' + viewport.width + 'px has no horizontal overflow before opening popup')
  await mode.click({ force: true })
  await popup.waitFor({ state: 'visible', timeout: 5000 })
  const box = await popup.boundingBox()
  assert(Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height), 'V210-RED ' + viewport.width + 'px popup stays inside the viewport')
  await page.keyboard.press('Escape')
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
