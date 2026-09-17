import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { dismissProductGuide } from './e2e-navigation.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const requestedChannel = process.env.PLAYWRIGHT_CHANNEL || 'msedge'
const launchOptions = requestedChannel === 'chromium'
  ? { headless: true }
  : { channel: requestedChannel, headless: true }
const browser = await chromium.launch(launchOptions)
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
await dismissProductGuide(page)

// Keep a binary in the unsent draft so the complete backup exercises ZIP v2's separate,
// streamed binary entries instead of only the small manifest path.
const imageInput = page.locator('input[type="file"][accept*="image/"]').first()
await imageInput.setInputFiles({ name: 'portable.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACdM3WQAAAABJRU5ErkJggg==', 'base64') })
await page.waitForTimeout(250)

await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-language"]').waitFor({ state: 'visible' })
await page.locator('[data-testid="language-en"]').click()
await page.waitForFunction(() => document.documentElement.lang === 'en')
assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'English mode sets html lang=en')
assert(await page.getByText('Data and migration', { exact: true }).count() === 1, 'settings copy switches to English')

const keyInput = page.locator('input[placeholder="sk-..."]')
await keyInput.fill('v240-secret-must-not-export')
await page.getByText('Save API settings', { exact: true }).click()
await page.waitForTimeout(250)
const downloadPromise = page.waitForEvent('download')
await page.getByText('Export complete ZIP backup', { exact: true }).click()
const download = await downloadPromise
const downloadPath = await download.path()
assert(download.suggestedFilename().endsWith('.zip'), 'complete backup downloads as ZIP')
const archive = new Uint8Array(await readFile(downloadPath))
const entries = unzipSync(archive)
const names = Object.keys(entries)
const backupText = strFromU8(entries['ai-education-reader-backup.json'])
const manifest = JSON.parse(backupText)
const backup = manifest.backup
assert(manifest.archiveFormat === 'ai-education-reader-portable-zip' && manifest.archiveVersion === 2, 'ZIP has the portable v2 manifest')
assert(names.some(name => name.startsWith('attachments/')), 'ZIP stores attachment bytes in a separate entry')
assert(!backupText.includes('v240-secret-must-not-export'), 'ZIP excludes the API key value')
assert(!Object.hasOwn(backup.settings, 'apiKey'), 'ZIP settings exclude the apiKey field')
assert(backup.settings.uiLanguage === 'en', 'ZIP includes the UI language preference')

await page.getByRole('button', { name: 'Close' }).first().click()
assert(await page.getByText('New chat', { exact: true }).count() >= 1, 'main navigation switches to English')
const collapseBox = await page.locator('[data-testid="sidebar-collapse"]').boundingBox()
assert(!!collapseBox && collapseBox.width <= 34 && collapseBox.height <= 34, 'English collapse control remains a compact icon button')
const mainChrome = await page.locator('body').innerText()
if (/[\u3400-\u9fff]/.test(mainChrome)) console.log('UNTRANSLATED_MAIN: ' + mainChrome.split('\n').filter(line => /[\u3400-\u9fff]/.test(line)).join(' | '))
assert(!/[\u3400-\u9fff]/.test(mainChrome), 'main English chrome contains no visible Chinese text')

await page.locator('[data-testid="sidebar-entry-files"]').click()
await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible' })
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 25000 })
await page.locator('[data-testid="reader-loading"]').waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {})
const readerChrome = await page.locator('[data-testid="document-reader"]').innerText()
assert(!/[\u3400-\u9fff]/.test(readerChrome), 'PDF reader English chrome contains no visible Chinese text')
await page.locator('[data-testid="reader-close"]').click()
await page.reload({ waitUntil: 'networkidle' })
await dismissProductGuide(page)
assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'English lang persists across reload')
assert(await page.getByText('New chat', { exact: true }).count() >= 1, 'English UI persists across reload')

await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-language"]').waitFor({ state: 'visible' })
page.once('dialog', dialog => dialog.accept())
await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(downloadPath)
await page.getByText('Import complete', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'ZIP import restores the language preference')
await page.getByRole('button', { name: 'Close' }).first().click()
await page.locator('[data-testid="sidebar-settings"]').click()
assert(await page.locator('input[placeholder="sk-..."]').inputValue() === '', 'ZIP import never restores an API key')

await browser.close()
const passCount = results.filter(result => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && errors.length === 0 ? 0 : 1)
