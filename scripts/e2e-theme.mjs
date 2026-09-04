// Theme e2e (Stage 9.5, v1.0.0, block 0.6/0.7): ONE reactive source in the Settings store,
// selected-mode indication (aria-pressed/data-selected), and system media-change semantics
// after an explicit light/dark choice (an explicit choice must NOT be overridden by a later
// system change; only system mode re-follows the media query).
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
const openSettings = async () => { await page.locator('[data-testid="sidebar-settings"]').first().click(); await page.waitForTimeout(500) }
const appearReady = async () => await page.locator('[data-testid="settings-appearance"]').waitFor({ state: 'visible', timeout: 10000 }).then(()=>true).catch(()=>false)
// The currently selected appearance button (aria-pressed=true / data-selected=true).
const selectedAppearance = () => page.evaluate(() => {
  const btns = document.querySelectorAll('[data-testid="settings-appearance"] button');
  for (const b of btns) { if (b.getAttribute('aria-pressed') === 'true' || b.getAttribute('data-selected') === 'true') return b.getAttribute('data-testid'); }
  return null;
})

// 1. system mode (default), system=light -> effective light (headless default).
await page.emulateMedia({ colorScheme: 'light' })
await openSettings(); await appearReady()
let t = await theme()
assert(t.h === 'light' && t.body === false, '1: system mode + system=light -> effective light (got ' + t.h + ')')
assert(await selectedAppearance() === 'appearance-system', '1: system button is the selected one (aria-pressed)')

// 2. while system mode, system changes to dark -> effective dark (listener active).
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(600)
t = await theme()
assert(t.h === 'dark' && t.body === true, '2: system=dark -> effective dark (got ' + t.h + ')')

// 3. choose explicit light; then system dark/light changes -> STAYS light.
await page.locator('[data-testid="appearance-light"]').click()
await page.waitForTimeout(300)
t = await theme()
assert(t.h === 'light', '3: explicit light -> effective light (got ' + t.h + ')')
assert(await selectedAppearance() === 'appearance-light', '3: light button is the selected one')
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(600)
t = await theme()
assert(t.h === 'light', '3b: explicit light NOT overridden by system dark (got ' + t.h + ')')

// 4. choose explicit dark; then system change -> STAYS dark.
await page.locator('[data-testid="appearance-dark"]').click()
await page.waitForTimeout(300)
t = await theme()
assert(t.h === 'dark' && t.body === true, '4: explicit dark -> effective dark (got ' + t.h + ')')
assert(await selectedAppearance() === 'appearance-dark', '4: dark button is the selected one')
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(600)
t = await theme()
assert(t.h === 'dark', '4b: explicit dark NOT overridden by system light (got ' + t.h + ')')

// 5. reload -> persisted explicit dark remains.
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(500)
t = await theme()
assert(t.h === 'dark', '5: reload keeps persisted explicit dark (got ' + t.h + ')')

// 6. switch back to system -> follows current media query again (light).
await openSettings(); await appearReady()
await page.locator('[data-testid="appearance-system"]').click()
await page.waitForTimeout(300)
t = await theme()
assert(t.h === 'light', '6: switch back to system -> follows media (got ' + t.h + ')')
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(600)
t = await theme()
assert(t.h === 'dark', '6b: system mode re-follows media after dark (got ' + t.h + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)