// v1.1.3 Chapter Builder regression e2e: 5-button group (delete separated), delete always
// confirms (leaf AND parent, showing subtree count), a SINGLE unambiguous add-chapter entry,
// and the PDF Reader staying operable while the Builder is docked (same left-panel model as
// the TOC Review). Uses a NO-OUTLINE fixture imported once (no duplicate-conflict dialog).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF = 'test/fixtures/no-outline.pdf'
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
const jumpTo = async (pg) => { await page.locator('[data-testid="reader-page-input"]').fill(String(pg)); await page.locator('[data-testid="reader-page-input"]').press('Enter'); await page.waitForTimeout(350) }

await openLibrary()
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(PDF)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })

// --- A: single unambiguous add entry + clear copy ---
await jumpTo(2)
await page.locator('[data-testid="reader-toc-create"]').click()
await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="cb-add"]').count()) === 1, 'A: exactly ONE add-chapter entry (cb-add)')
assert((await page.locator('[data-testid="cb-add-current"]').count()) === 0, 'A: no duplicate 从当前页添加 entry')
const addText = (await page.locator('[data-testid="cb-add"]').textContent()) || ''
assert(addText.includes('PDF 第') && addText.includes('2'), 'A: add entry copy names the current PDF page (got ' + addText + ')')

// --- B: build a parent + child (第一章 L1 @2, then 第一节 L2 @3 via indent) ---
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('第一章')
await page.locator('[data-testid="cb-page-0"]').fill('2')
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-1"]').fill('第一节')
await page.locator('[data-testid="cb-page-1"]').fill('3')
await page.locator('[data-testid="cb-indent-1"]').click()
const rowCount = await page.locator('[data-testid^="cb-row"]').count()
assert(rowCount === 2, 'B: 2 rows (parent+child) after indent (got ' + rowCount + ')')

// --- C: 5-button group order: up, down, outdent, indent, [gap] delete (delete LAST) ---
const orderC = await page.evaluate(() => {
  const row = document.querySelector('[data-testid="cb-row"]')
  const ops = Array.from(row.querySelectorAll('[data-testid^="cb-up-"], [data-testid^="cb-down-"], [data-testid^="cb-outdent-"], [data-testid^="cb-indent-"], [data-testid^="cb-del-"]'))
  return ops.map(b => b.getAttribute('data-testid').replace(/\-\d+$/, '')).join(',')
})
assert(orderC === 'cb-up,cb-down,cb-outdent,cb-indent,cb-del', 'C: op order up,down,outdent,indent,del (got ' + orderC + ')')
const delAfterIndent = await page.evaluate(() => {
  const row = document.querySelector('[data-testid="cb-row"]')
  const ops = Array.from(row.querySelectorAll('[data-testid^="cb-up-"], [data-testid^="cb-down-"], [data-testid^="cb-outdent-"], [data-testid^="cb-indent-"], [data-testid^="cb-del-"]'))
  const delEl = ops.find(b => b.getAttribute('data-testid').startsWith('cb-del-'))
  const indentEl = ops.find(b => b.getAttribute('data-testid').startsWith('cb-indent-'))
  return delEl.getBoundingClientRect().left > indentEl.getBoundingClientRect().right
})
assert(delAfterIndent, 'C: delete button visually separated to the right of the structure group')

// --- D: leaf delete REQUIRES confirmation (row 1 第一节 is a leaf) ---
await page.locator('[data-testid="cb-del-1"]').click()
await page.locator('[data-testid="cb-confirm"]').waitFor({ state: 'visible', timeout: 5000 })
const leafConfirmText = (await page.locator('[data-testid="cb-confirm"]').textContent()) || ''
assert(leafConfirmText.includes('确认删除'), 'D: leaf delete shows a confirm dialog (got ' + leafConfirmText + ')')
assert(leafConfirmText.includes('第一节'), 'D: leaf confirm names the target chapter 第一节')
assert(!leafConfirmText.includes('子章节'), 'D: leaf confirm does NOT mention subchapters')
// Cancel keeps the draft unchanged.
await page.locator('[data-testid="cb-confirm-no"]').click()
await page.waitForTimeout(200)
assert((await page.locator('[data-testid^="cb-row"]').count()) === 2, 'D: cancel keeps the row (2 rows)')
// Confirm really deletes the leaf.
await page.locator('[data-testid="cb-del-1"]').click()
await page.locator('[data-testid="cb-confirm-yes"]').click()
await page.waitForTimeout(200)
assert((await page.locator('[data-testid^="cb-row"]').count()) === 1, 'D: confirm deletes the leaf (1 row)')

// --- E: parent delete shows the subtree count ---
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-1"]').fill('第二节')
await page.locator('[data-testid="cb-page-1"]').fill('4')
await page.locator('[data-testid="cb-indent-1"]').click()
assert((await page.locator('[data-testid^="cb-row"]').count()) === 2, 'E: parent + new child (2 rows)')
await page.locator('[data-testid="cb-del-0"]').click()
await page.locator('[data-testid="cb-confirm"]').waitFor({ state: 'visible', timeout: 5000 })
const parentConfirmText = (await page.locator('[data-testid="cb-confirm"]').textContent()) || ''
assert(parentConfirmText.includes('及其 1 个子章节'), 'E: parent confirm states it deletes 1 subchapter (got ' + parentConfirmText + ')')
await page.locator('[data-testid="cb-confirm-yes"]').click()
await page.waitForTimeout(200)
assert((await page.locator('[data-testid^="cb-row"]').count()) === 0, 'E: confirm deletes the whole subtree (0 rows)')

// --- F: PDF stays operable while the Builder is docked (item 11) ---
await page.locator('[data-testid="cb-add"]').click()
await page.locator('[data-testid="cb-title-0"]').fill('章')
const base = (await inputVal()).trim()
await page.locator('[data-testid="reader-next"]').click()
await page.waitForTimeout(350)
const afterNext = (await inputVal()).trim()
assert(afterNext === String(Number(base) + 1), 'F: PDF 下一页 clickable while builder open (' + base + ' -> ' + afterNext + ')')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(300)
const afterArrow = (await inputVal()).trim()
assert(afterArrow === String(Number(afterNext) + 1), 'F: ArrowRight pages PDF while builder open (focus not in input) (' + afterNext + ' -> ' + afterArrow + ')')
await page.locator('[data-testid="cb-title-0"]').focus()
const beforeArrow = (await inputVal()).trim()
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(250)
assert((await inputVal()).trim() === beforeArrow, 'F: ArrowLeft inside builder title input does NOT page the PDF')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && pageErrors === '(none)' ? 0 : 1)
