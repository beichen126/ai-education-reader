// Sidebar + Composer closure E2E (A1 collapsed-rail history-first, A2 unified attach trigger).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

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



await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
