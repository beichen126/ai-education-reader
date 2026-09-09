import { launchBrowser } from './e2e-browser.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'

async function waitForApp(page) {
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))

// Fresh/no-key path: the guide appears after the application is ready, not during boot.
await page.goto(BASE, { waitUntil: 'networkidle' })
await waitForApp(page)
const guide = page.locator('[data-testid="product-guide"]')
await guide.waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('.eink-boot').count() === 0, 'fresh/no-key guide opens after boot ready')
assert(await guide.getByText('第一屏就是 AI 对话').count() === 1, 'guide explains the AI conversation first screen')
assert(await page.locator('[data-testid="product-guide-import"]').count() === 1, 'guide offers 导入 PDF')
assert(await page.locator('[data-testid="product-guide-library"]').count() === 1, 'guide offers 打开资料库')
assert(await page.locator('[data-testid="product-guide-settings"]').count() === 1, 'guide offers 配置 API')
assert(await page.locator('[data-testid^="product-guide-toc-"]').count() >= 5, 'guide exposes a long-document table of contents')
assert(await guide.getAttribute('aria-modal') === 'true', 'guide is an aria-modal dialog')

await page.waitForFunction(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onsuccess = () => { const db = req.result; const r = db.transaction('settings', 'readonly').objectStore('settings').get('productGuideSeenVersion'); r.onsuccess = () => resolve(r.result?.value || null); r.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}), null, { timeout: 10000 })
const marker = await page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onsuccess = () => { const db = req.result; const r = db.transaction('settings', 'readonly').objectStore('settings').get('productGuideSeenVersion'); r.onsuccess = () => resolve(r.result?.value || null); r.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}))
assert(marker === '2.1.0', 'fresh guide writes the current seen-version marker')

// Three action buttons must route to real existing surfaces.
await page.locator('[data-testid="product-guide-import"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="library-import"]').isVisible(), '导入 PDF opens the real library import surface')
await page.locator('[data-testid="library-close"]').click()
await page.locator('[data-testid="help-product-guide"]').click()
await guide.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="product-guide-library"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="document-library"]').isVisible(), '打开资料库 routes to the document library')
await page.locator('[data-testid="library-close"]').click()
await page.locator('[data-testid="help-product-guide"]').click()
await page.locator('[data-testid="product-guide-settings"]').click()
await page.locator('[data-testid="settings-byok"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="settings-byok"]').isVisible(), '配置 API routes to Settings')
await page.keyboard.press('Escape')

// Same-version reload must not auto-open, while the permanent help entry still works.
await page.reload({ waitUntil: 'networkidle' })
await waitForApp(page)
await page.waitForTimeout(400)
assert(await guide.count() === 0, 'same guide version does not auto-open after reload')

// A user with an API key must not receive the first-entry guide even when the
// seen-version marker is absent.
await page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('settings', 'readwrite')
    tx.objectStore('settings').put({ key: 'apiKey', value: 'e2e-api-key' })
    tx.objectStore('settings').delete('productGuideSeenVersion')
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => resolve(false)
  }
  req.onerror = () => resolve(false)
}))
await page.reload({ waitUntil: 'networkidle' })
await waitForApp(page)
await page.waitForTimeout(400)
assert(await guide.count() === 0, 'configured API key suppresses the first-entry guide')
await page.locator('[data-testid="help-product-guide"]').click()
await guide.waitFor({ state: 'visible', timeout: 10000 })
assert(await guide.isVisible(), 'expanded sidebar Help entry always opens the guide')
await page.locator('[data-testid="product-guide-close"]').click()
assert(await guide.count() === 0, 'close action dismisses the guide')

// Mobile full-screen, scroll-to-top and focus/close behavior.
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(500)
const helpEntry = page.locator('[data-testid="help-product-guide"]')
if (await helpEntry.isVisible().catch(() => false)) await helpEntry.click({ timeout: 10000 })
else await page.locator('[data-testid="rail-help"]').click({ timeout: 10000 })
await guide.waitFor({ state: 'visible', timeout: 10000 })
const mobileBox = await guide.boundingBox()
assert(mobileBox && mobileBox.width >= 389 && mobileBox.height >= 843, 'mobile guide uses the full viewport')
assert(await page.locator('[data-testid="product-guide-scroll"]').isVisible(), 'mobile guide keeps a scrollable content region')
await page.locator('[data-testid="product-guide-scroll"]').evaluate(el => { el.scrollTop = el.scrollHeight })
assert(await page.locator('[data-testid="product-guide-top"]').isVisible(), 'long guide exposes 回到顶部')
await page.locator('[data-testid="product-guide-top"]').click()
await page.waitForTimeout(100)
const scrollTop = await page.locator('[data-testid="product-guide-scroll"]').evaluate(el => el.scrollTop)
assert(scrollTop < 8, '回到顶部 returns the guide scroll position to the top')
await page.keyboard.press('Escape')
assert(await guide.count() === 0, 'Escape closes the mobile guide')

// Marker write failure must leave the app usable and may only cause a later repeat.
const failContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await failContext.addInitScript(() => { window.__dshProductGuideMarkerFailure = true })
const failPage = await failContext.newPage()
const failErrors = []
failPage.on('pageerror', error => failErrors.push(error.message))
await failPage.goto(BASE, { waitUntil: 'networkidle' })
await waitForApp(failPage)
await failPage.locator('[data-testid="product-guide"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await failPage.locator('[data-testid="composer-materials-input"]').count() === 1, 'marker write failure does not block the ready app')
assert(failErrors.length === 0, 'marker write failure produces no page error')
await failContext.close()

await context.close()
await browser.close()
const pageErrors = [...errors]
console.log(results.join('\n'))
console.log('PAGEERRORS:', pageErrors.length ? pageErrors.join(' | ') : '(none)')
const passed = results.filter(result => result.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(results.some(result => result.startsWith('FAIL')) || pageErrors.length ? 1 : 0)
