// Theme computed-style e2e (v1.0.0, dark theme + study-highlight). Validates at the DESIGN-TOKEN
// layer that dark surfaces/primary are NOT light-theme values (the bug: --dsw-alias-brand-primary
// resolved near-white -> white primary button + white user bubble), that the study-highlight
// is a --dsw-specific-* token whose dark value differs from light, and that switch + reload persist.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const openSettings = async () => { await page.locator('[data-testid="sidebar-settings"]').first().click(); await page.waitForTimeout(500) }
const appearReady = async () => await page.locator('[data-testid="settings-appearance"]').waitFor({ state: 'visible', timeout: 10000 }).then(()=>true).catch(()=>false)
const closeSettings = async () => { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300) }

// Read resolved design tokens on <body> (the alias layer keys off body[data-ds-dark-theme]).
const tokens = () => page.evaluate(() => {
  const cs = getComputedStyle(document.body);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    theme: document.documentElement.dataset.theme || null,
    bodyDark: document.body.hasAttribute('data-ds-dark-theme'),
    brand: g('--dsw-alias-brand-primary'),
    fill: g('--dsw-alias-button-primary-fill'),
    foreground: g('--dsw-alias-label-primary-foreground'),
    bg: g('--dsw-alias-bg-base'),
    highlight: g('--dsw-specific-study-highlight'),
  };
})

const setMode = async (mode) => { await openSettings(); await appearReady(); await page.locator('[data-testid="appearance-' + mode + '"]').click(); await page.waitForTimeout(400); await closeSettings() }
const bgOf = (sel) => page.locator(sel).first().evaluate(el => getComputedStyle(el).backgroundColor).catch(() => null)
const fgOf = (sel) => page.locator(sel).first().evaluate(el => getComputedStyle(el).color).catch(() => null)

// --- LIGHT baseline ---
await setMode('light')
const L = await tokens()
assert(L.theme === 'light', 'LIGHT: data-theme=light (got ' + L.theme + ')')
assert(L.bodyDark === false, 'LIGHT: no body[data-ds-dark-theme]')
assert(L.bg === 'rgb(255, 255, 255)', 'LIGHT: bg-base is white (got ' + L.bg + ')')
assert(L.brand !== '' && L.fill !== '', 'LIGHT: brand/fill tokens defined')

// --- DARK: surfaces + primary must differ from light ---
await setMode('dark')
const D = await tokens()
assert(D.theme === 'dark', 'DARK: data-theme=dark (got ' + D.theme + ')')
assert(D.bodyDark === true, 'DARK: body[data-ds-dark-theme] set')
assert(D.bg === 'rgb(21, 21, 23)', 'DARK: bg-base near-black (got ' + D.bg + ')')
assert(D.bg !== L.bg, 'DARK: bg differs from light (not a light-theme value)')
assert(D.brand === 'rgb(72, 104, 178)', 'DARK: brand-primary is DeepSeek blue, NOT near-white (got ' + D.brand + ')')
assert(D.fill === D.brand, 'DARK: primary button fill == brand blue')
assert(D.foreground === 'rgb(255, 255, 255)', 'DARK: foreground on primary is white (got ' + D.foreground + ')')

// --- study-highlight semantic token: single canonical rule, dark differs from light, low-glare ---
assert(D.highlight !== '' , 'DARK: --dsw-specific-study-highlight defined (got ' + D.highlight + ')')
assert(D.highlight !== L.highlight, 'DARK: study-highlight token differs from light (got ' + D.highlight + ')')
assert(L.highlight === 'rgb(217, 217, 217)', 'LIGHT: study-highlight keeps the classic light value (got ' + L.highlight + ')')
assert(D.highlight === 'rgb(66, 84, 106)', 'DARK: study-highlight is low-glare slate, NOT near-white (got ' + D.highlight + ')')

// Exactly one canonical global ::highlight(study-highlight) paint rule (annotations.css).
const ruleCount = await page.evaluate(() => {
  let n = 0;
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) { if (rule.selectorText === '::highlight(study-highlight)') n++ } } catch (e) {}
  }
  return n;
})
assert(ruleCount === 1, 'DARK: exactly ONE canonical ::highlight(study-highlight) rule (got ' + ruleCount + ')')

// --- element-level computed styles in DARK are not light-theme values ---
// Composer send button (primary, uses button-primary-fill).
// Composer send button: a real primary-fill element (button-primary-fill).
const sendBtn = page.getByRole('button', { name: '发送' }).first()
const sendBtnBg = await sendBtn.evaluate(el => getComputedStyle(el).backgroundColor).catch(() => null)
const sendBtnFg = await sendBtn.evaluate(el => getComputedStyle(el).color).catch(() => null)
assert(sendBtnBg === D.fill || sendBtnBg === D.brand, 'DARK: send button bg is the DeepSeek blue primary (got ' + sendBtnBg + ')')
assert(sendBtnFg === D.foreground, 'DARK: send button text is white (got ' + sendBtnFg + ')')

// Sidebar surface via its token (not white in dark).
const sidebarTok = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill').trim())
assert(sidebarTok && sidebarTok !== 'rgb(255, 255, 255)' && sidebarTok !== 'rgb(249, 250, 251)', 'DARK: sidebar token is near-black, not light (got ' + sidebarTok + ')')

// Composer surface token (bg-layer) is near-black in dark.
const composerTok = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-layer-1').trim())
assert(composerTok && composerTok !== 'rgb(255, 255, 255)', 'DARK: composer/layer token is near-black, not white (got ' + composerTok + ')')

// Need a user message to have a .bubble (primary fill). We can't easily fake a conversation;
// instead assert the CSS variable that the bubble consumes equals the dark blue (not white).
assert(D.fill === 'rgb(72, 104, 178)', 'DARK: user-bubble/.bubble bg token is DeepSeek blue, NOT white (got ' + D.fill + ')')

// DocumentContextPicker (modal) surface uses bg-layer tokens, not white, in dark.
const FILES = '[data-testid="sidebar-entry-files"], [data-testid="rail-files"]'
const openLibrary = async () => { if (await page.locator('[data-testid="document-library"]').count()) return; await page.locator(FILES).first().click(); await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 }) }
await openLibrary()
const libBg = await bgOf('[data-testid="document-library"]')
assert(libBg && libBg !== 'rgb(255, 255, 255)', 'DARK: DocumentLibrary overlay is not white (got ' + libBg + ')')
await page.locator('[data-testid="library-close"]').click().catch(() => {})
await page.waitForTimeout(300)

// --- reload persistence (dark stays dark) ---
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await page.waitForTimeout(400)
const R = await tokens()
assert(R.theme === 'dark', 'RELOAD: dark persists after reload (got ' + R.theme + ')')
assert(R.brand === D.brand && R.highlight === D.highlight, 'RELOAD: brand + study-highlight tokens persist')

// --- switch back to system: follows media (emulate light -> light) ---
await setMode('system')
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(400)
const S = await tokens()
assert(S.theme === 'light', 'SYSTEM(light): resolves to light (got ' + S.theme + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)