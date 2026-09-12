// v2.2.0 Stage 1 browser gate: the PDF reading mode is committed when it is chosen.
// The user path is exactly: choose -> close (Escape / X / mask) -> reopen -> reload -> Reader.
// No generic "save" click is involved; that button belongs to the API form only.
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const fixture = 'test/.playwright/nav-lifecycle.pdf'

if (!existsSync(fixture)) {
  mkdirSync('test/.playwright', { recursive: true })
  const generated = spawnSync(process.execPath, ['scripts/make-outline-pdf.mjs', fixture, '10'], { stdio: 'inherit' })
  if (generated.status !== 0) throw new Error('failed to generate settings lifecycle fixture')
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [{ id: 'nav-lifecycle-chat', title: 'Reading mode settings', createdAt: now, updatedAt: now, messages: [msg('nav-lifecycle-u1', 'user', 'hello'), msg('nav-lifecycle-a1', 'assistant', 'Please choose a PDF reading mode.')] }],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'nav-lifecycle-chat' },
})

const openSettings = async () => {
  await page.locator('[data-testid="sidebar-settings"]').click()
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
}
const closeWithEscape = async () => {
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'hidden', timeout: 10000 })
}
const closeWithX = async () => {
  await page.locator('[role="dialog"] button[aria-label="关闭"]').click()
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'hidden', timeout: 10000 })
}
const closeWithMask = async () => {
  await page.mouse.click(8, 8)
  await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'hidden', timeout: 10000 })
}
const checked = async () => ({
  paged: await page.locator('[data-testid="pdf-navigation-paged"]').getAttribute('aria-checked'),
  continuous: await page.locator('[data-testid="pdf-navigation-continuous"]').getAttribute('aria-checked'),
})
const durableMode = async () => (await openAppDb(page, { store: 'settings', operation: 'get', key: 'pdfNavigationMode' }))?.value
const durableKey = async key => (await openAppDb(page, { store: 'settings', operation: 'get', key }))?.value

await openSettings()
assert((await checked()).paged === 'true', 'fresh install starts on the paged mode')

// ---- user path 1: choose continuous, close with Escape, no extra save click ----
await page.locator('[data-testid="pdf-navigation-continuous"]').click()
assert((await checked()).continuous === 'true', 'clicking the continuous option selects it immediately')
await closeWithEscape()
await openSettings()
assert((await checked()).continuous === 'true', 'reopening Settings still shows the continuous option')
assert(await durableMode() === 'continuous', 'IndexedDB already holds the continuous mode after the click')

await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await openSettings()
assert((await checked()).continuous === 'true', 'reload keeps the continuous option selected')

// ---- user path 2: choose paged, close with X ----
await page.locator('[data-testid="pdf-navigation-paged"]').click()
await closeWithX()
await openSettings()
assert((await checked()).paged === 'true', 'X close persists the paged mode')

// ---- user path 3: choose continuous, close by mask click ----
await page.locator('[data-testid="pdf-navigation-continuous"]').click()
await closeWithMask()
await openSettings()
assert((await checked()).continuous === 'true', 'mask close persists the continuous mode')

// ---- rapid A -> B keeps the last intent ----
await page.locator('[data-testid="pdf-navigation-paged"]').click()
await page.locator('[data-testid="pdf-navigation-continuous"]').click()
await closeWithEscape()
await openSettings()
assert(await durableMode() === 'continuous', 'rapid paged->continuous leaves the last choice durable')

// ---- the Reader honours the stored mode ----
await closeWithEscape()
await openDocumentLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 60000 })
await page.locator('[data-testid="reader-viewport"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-viewport"]').getAttribute('data-pdf-navigation-mode') === 'continuous', 'Reader opens in the persisted continuous mode')

await page.locator('[data-testid="reader-back"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="library-close"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'hidden', timeout: 10000 })
await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await checked()).continuous === 'true', 'Settings still reports continuous after visiting the Reader')
await page.keyboard.press('Escape')

// ---- the API form must not carry the PDF mode, and PDF clicks must not save API drafts ----
await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-pdf-navigation"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('input[placeholder="sk-..."]').fill('sk-not-saved-draft')
await page.locator('[data-testid="pdf-navigation-paged"]').click()
await page.keyboard.press('Escape')
assert(await durableKey('apiKey') !== 'sk-not-saved-draft', 'choosing a PDF mode does not persist an unsaved API Key draft')

// ---- failure injection: an aborted settings transaction rolls the choice back ----
await openSettings()
const committedBefore = await durableMode()
await page.evaluate(() => {
  const proto = IDBObjectStore.prototype
  const realPut = proto.put
  window.__restoreSettingsPut = () => { proto.put = realPut }
  window.__failSettingsWrites = true
  proto.put = function (...args) {
    if (window.__failSettingsWrites && this.name === 'settings') throw new DOMException('injected settings failure', 'UnknownError')
    return realPut.apply(this, args)
  }
})
const failingTarget = committedBefore === 'continuous' ? 'paged' : 'continuous'
await page.locator('[data-testid="pdf-navigation-' + failingTarget + '"]').click()
await page.locator('[data-testid="settings-pdf-navigation-error"]').waitFor({ state: 'visible', timeout: 10000 })
assert(true, 'a failed commit shows a visible error with a retry')
assert(await durableMode() === committedBefore, 'a failed commit leaves the durable value untouched')
assert(await page.locator('[data-testid="pdf-navigation-' + committedBefore + '"]').getAttribute('aria-checked') === 'true', 'the radio rolls back to the committed value')
assert(errors.length === 0, 'a failed settings commit raises no unhandled rejection')
await page.evaluate(() => { window.__failSettingsWrites = false })
await page.locator('[data-testid="settings-pdf-navigation-retry"]').click()
await page.locator('[data-testid="settings-pdf-navigation-error"]').waitFor({ state: 'hidden', timeout: 10000 })
assert(await durableMode() === failingTarget, 'retry commits the intended value')
assert(await page.locator('[data-testid="pdf-navigation-' + failingTarget + '"]').getAttribute('aria-checked') === 'true', 'the retried choice is selected')
await page.evaluate(() => { window.__restoreSettingsPut?.(); delete window.__failSettingsWrites })
await page.keyboard.press('Escape')

assert(errors.length === 0, 'settings lifecycle produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
