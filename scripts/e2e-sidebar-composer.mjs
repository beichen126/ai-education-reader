// Sidebar + Composer closure E2E (A1 collapsed-rail history-first, A2 unified attach trigger).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 25000 })

// ===== A1: COLLAPSED sidebar — rail-history must be the FIRST interactive rail control ======
// Collapse the sidebar via the collapse button.
const collapseBtn = page.locator('[data-testid="sidebar-collapse"]')
if (await collapseBtn.count()) {
  await collapseBtn.click()
} else {
  // Narrow-viewport fallback: open the rail then collapse via Escape is not available; skip desktop assumption.
}
await page.waitForTimeout(400)
// Collect the collapsed-rail interactive buttons (data-testid^="rail-") in DOM order.
// The rail-* testids appear ONLY in the collapsed rail; the expanded sidebar uses sidebar-*/entry*.
const railOrder = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-testid^="rail-"]')].filter(b => b.tagName === 'BUTTON')
  return btns.map(b => b.getAttribute('data-testid'))
})
assert(railOrder.length >= 2, 'A1: collapsed rail exposes interactive buttons (got ' + railOrder.length + ')')
assert(railOrder[0] === 'rail-history', 'A1: rail-history is the FIRST rail control (got ' + railOrder[0] + ')')
assert(railOrder.indexOf('rail-new-chat') > railOrder.indexOf('rail-history'), 'A1: rail-new-chat comes AFTER rail-history')
assert(railOrder[railOrder.length - 1] === 'rail-settings' || railOrder[railOrder.length - 1] === 'rail-fullscreen', 'A1: bottom utility controls stay at the bottom (last = ' + railOrder[railOrder.length - 1] + ')')

// Clicking rail-history restores the expanded sidebar.
await page.locator('[data-testid="rail-history"]').click()
await page.waitForTimeout(500)
const expanded = await page.locator('[data-testid="sidebar-collapse"]').count()
assert(expanded === 1, 'A1: clicking rail-history restores the expanded sidebar')


// ===== A2: COMPOSER — exactly ONE visible attachment trigger, unified menu ======
{
  // The old dual-button UI (composer-attach-image / composer-attach-pdf) must be gone.
  const oldImageBtn = await page.locator('[data-testid="composer-attach-image"]').count()
  const oldPdfBtn = await page.locator('[data-testid="composer-attach-pdf"]').count()
  assert(oldImageBtn === 0 && oldPdfBtn === 0, 'A2: old dual-button image/PDF controls gone (img=' + oldImageBtn + ', pdf=' + oldPdfBtn + ')')
  // Exactly one unified trigger.
  const attachCount = await page.locator('[data-testid="composer-attach"]').count()
  assert(attachCount === 1, 'A2: exactly ONE visible attachment trigger (got ' + attachCount + ')')
  // Open the unified menu.
  await page.locator('[data-testid="composer-attach"]').click()
  await page.locator('[data-testid="composer-add-file-menu"]').waitFor({ state: 'visible', timeout: 5000 })
  assert(await page.locator('[data-testid="composer-add-image"]').count() === 1, 'A2: unified menu exposes 图片 action')
  assert(await page.locator('[data-testid="composer-add-pdf"]').count() === 1, 'A2: unified menu exposes 打开本地 PDF action')
  assert(await page.locator('[data-testid="composer-from-library"]').count() === 1, 'A2: unified menu exposes 从文件资料库选择 action')
  // Escape closes the menu.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert(await page.locator('[data-testid="composer-add-file-menu"]').count() === 0, 'A2: Escape closes the unified menu')

  // Click outside closes the menu.
  await page.locator('[data-testid="composer-attach"]').click()
  await page.locator('[data-testid="composer-add-file-menu"]').waitFor({ state: 'visible', timeout: 5000 })
  await page.mouse.click(700, 200)
  await page.waitForTimeout(200)
  assert(await page.locator('[data-testid="composer-add-file-menu"]').count() === 0, 'A2: click-outside closes the unified menu')

  // Composer-side visual state: trigger has a non-native (reset) background/border.
  const triggerStyle = await page.locator('[data-testid="composer-attach"]').evaluate(el => {
    const s = getComputedStyle(el)
    return { appearance: s.appearance, border: s.borderTopWidth, background: s.backgroundColor }
  })
  assert(triggerStyle.appearance === 'none', 'A2: attach trigger resets native appearance (got ' + triggerStyle.appearance + ')')
  assert(triggerStyle.border === '0px', 'A2: attach trigger has no native border (got ' + triggerStyle.border + ')')
}




// ===== A3: unified material entry semantics (v1.1.3) ======
{
  // Attach trigger semantics: a DOCUMENT icon, aria/title = 添加资料 (not "添加内容"/photo).
  const aria = await page.locator('[data-testid="composer-attach"]').getAttribute('aria-label')
  const title = await page.locator('[data-testid="composer-attach"]').getAttribute('title')
  assert(aria === '添加资料', 'A3: attach trigger aria-label is 添加资料 (got ' + aria + ')')
  assert(title === '添加资料', 'A3: attach trigger title is 添加资料 (got ' + title + ')')
  // Re-open menu and assert every entry's exact accessible text (no emoji, no photo-only label).
  await page.locator('[data-testid="composer-attach"]').click()
  await page.locator('[data-testid="composer-add-file-menu"]').waitFor({ state: 'visible', timeout: 5000 })
  const imgLabel = (await page.locator('[data-testid="composer-add-image"]').textContent()).trim()
  const pdfLabel = (await page.locator('[data-testid="composer-add-pdf"]').textContent()).trim()
  const libLabel = (await page.locator('[data-testid="composer-from-library"]').textContent()).trim()
  assert(imgLabel === '打开本地图片', 'A3: menu image entry is 打开本地图片 (got ' + imgLabel + ')')
  assert(pdfLabel === '打开本地 PDF', 'A3: menu pdf entry is 打开本地 PDF (got ' + pdfLabel + ')')
  assert(libLabel === '从资料库添加', 'A3: menu library entry is 从资料库添加 (got ' + libLabel + ')')
  const menuText = (await page.locator('[data-testid="composer-add-file-menu"]').textContent()) || ''
  assert(menuText.includes('添加资料') && !menuText.includes('添加内容'), 'A3: menu title is 添加资料 (no more 添加内容)')
  assert(!menuText.startsWith('🖼') && !menuText.includes('📚') && !menuText.includes('📄'), 'A3: menu no longer uses emoji icons')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}

// ===== A4: new-chat empty hero — 添加资料 / 打开资料库 ======
await page.locator('[data-testid="sidebar-new-chat"]').click()
await page.waitForTimeout(600)
assert(await page.locator('[data-testid="empty-add-materials"]').count() === 1, 'A4: empty hero has 添加资料')
assert(await page.locator('[data-testid="empty-open-library"]').count() === 1, 'A4: empty hero has 打开资料库')
assert(await page.locator('[data-testid="empty-add-image"]').count() === 0, 'A4: old 添加图片 CTA gone')
assert(await page.locator('[data-testid="empty-open-pdf"]').count() === 0, 'A4: old 打开 PDF CTA gone')
const addMatText = (await page.locator('[data-testid="empty-add-materials"]').textContent()).trim()
const openLibText = (await page.locator('[data-testid="empty-open-library"]').textContent()).trim()
assert(addMatText === '添加资料', 'A4: 添加资料 CTA text (got ' + addMatText + ')')
assert(openLibText === '打开资料库', 'A4: 打开资料库 CTA text (got ' + openLibText + ')')
assert(await page.getByText('还没有学习内容。添加资料，或从资料库开始。').count() >= 1, 'A4: empty hero hint updated')

// ===== A5: 打开资料库 really opens the Document Library (real path) ======
await page.locator('[data-testid="empty-open-library"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="document-library"]').count() === 1, 'A5: 打开资料库 opens the real Document Library')
await page.locator('[data-testid="library-close"]').click().catch(() => {})
await page.waitForTimeout(400)

// ===== A6: 统一材料选择器 (materials input) — images vs PDF dispatch ======
{
  // CASE A: a single PNG → the normal image pipeline (pending thumb + count in the composer).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.locator('[data-testid="composer-materials-input"]').setInputFiles([{ name: 'tiny.png', mimeType: 'image/png', buffer: png }])
  await page.waitForTimeout(600)
  const imgCountText = await page.getByText(/已添加 1 张图片/)
  assert(await imgCountText.count() >= 1, 'A6: a PNG via 添加资料 enters the image pipeline (got count ' + await imgCountText.count() + ')')
}
{
  // CASE B: a single PDF → the real PdfPanel flow (NOT an image attachment).
  await page.locator('[data-testid="composer-materials-input"]').setInputFiles(['test/fixtures/no-outline.pdf'])
  await page.locator('[data-testid="pdf-generate"]').waitFor({ state: 'visible', timeout: 20000 })
  assert(await page.locator('[data-testid="pdf-generate"]').count() === 1, 'A6: a PDF via 添加资料 opens the real PdfPanel flow (pdf-generate visible)')
  // It must NOT have been treated as an image attachment (no "已添加 N 张图片" for a PDF).
  assert(await page.getByText(/已添加 2 张图片/).count() === 0, 'A6: the PDF was not added as an image')
  await page.locator('[data-testid="pdf-done"]').click().catch(() => {})
  await page.waitForTimeout(400)
}

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
