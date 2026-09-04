// Theme e2e (Stage 9.5, Part B): system/light/dark. Applies via settings radio, verifies
// documentElement.dataset.theme + body[data-ds-dark-theme], and reload persistence.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const theme = () => page.evaluate(() => ({ h: document.documentElement.dataset.theme || null, body: document.body.hasAttribute('data-ds-dark-theme') }))

// open settings
const openSettings = async () => { await page.locator('[data-testid="sidebar-settings"]').first().click(); await page.waitForTimeout(500) }
const appearReady = async () => await page.locator('[data-testid="settings-appearance"]').waitFor({ state: 'visible', timeout: 10000 }).then(()=>true).catch(()=>false)

// --- explicit dark ---
await openSettings(); await appearReady()
await page.locator('[data-testid="appearance-dark"]').click()
await page.waitForTimeout(200)
let t = await theme()
assert(t.h === 'dark' && t.body === true, 'explicit dark -> data-theme=dark + body dark attr')

// --- reload persistence ---
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(500)
t = await theme()
assert(t.h === 'dark', 'dark persists after reload')

// --- explicit light ---
await openSettings(); await appearReady()
await page.locator('[data-testid="appearance-light"]').click()
await page.waitForTimeout(200)
t = await theme()
assert(t.h === 'light' && t.body === false, 'explicit light -> data-theme=light, no dark attr')

// --- system (resolve via default = light in headless) ---
await page.locator('[data-testid="appearance-system"]').click()
await page.waitForTimeout(200)
t = await theme()
assert(t.h === 'light' || t.h === 'dark', 'system mode resolves to a concrete theme (' + t.h + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)