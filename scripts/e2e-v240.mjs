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
assert(await page.locator('[data-testid="api-setup-checklist"]').count() === 1, 'API configuration checklist is available')
assert(await page.locator('[data-testid="data-safety-center"]').count() === 1, 'local data safety center is available')
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

// Seed app-generated legacy Chinese values exactly as older releases stored them. English
// presentation must localize only these defaults without rewriting the IndexedDB records.
await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction(['conversations', 'conversationBranches', 'settings'], 'readwrite')
    const now = Date.now()
    tx.objectStore('conversations').put({
      id: 'locale-legacy-chat', title: '新会话', createdAt: now, updatedAt: now,
      messages: [
        { id: 'locale-u1', role: 'user', content: 'Question', images: [], createdAt: now, updatedAt: now },
        { id: 'locale-a1', role: 'assistant', content: 'Answer', images: [], createdAt: now, updatedAt: now },
      ],
    })
    tx.objectStore('conversationBranches').put({
      id: 'locale-branch-1', conversationId: 'locale-legacy-chat', forkMessageId: 'locale-a1',
      title: '分支 1', createdAt: now, updatedAt: now, messages: [],
    })
    tx.objectStore('settings').put({ key: 'lastConversationId', value: 'locale-legacy-chat' })
    tx.objectStore('settings').put({ key: 'activeBranch:locale-legacy-chat', value: 'locale-branch-1' })
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
}))
await page.reload({ waitUntil: 'networkidle' })
await dismissProductGuide(page)
await page.getByText('Current route', { exact: true }).waitFor({ state: 'visible' })
const branchChrome = (await page.locator('[data-testid="conversation-context-row"]').allInnerTexts()).join('\n')
assert(branchChrome.includes('Branch 1'), 'legacy generated branch title is localized to Branch 1')
assert(!/[\u3400-\u9fff]/.test(branchChrome), 'branch and mode chrome contain no Chinese in English mode')
const storedLegacyBranchTitle = await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches').objectStore('conversationBranches').get('locale-branch-1')
    get.onsuccess = () => { db.close(); resolve(get.result?.title) }
    get.onerror = () => reject(get.error)
  }
}))
assert(storedLegacyBranchTitle === '分支 1', 'localization leaves the legacy stored branch title unchanged')

await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-prompts-all"]').click()
await page.locator('[data-testid="prompt-manager"]').waitFor({ state: 'visible' })
const promptChrome = await page.locator('[data-testid="prompt-manager"]').innerText()
assert(!/[\u3400-\u9fff]/.test(promptChrome), 'prompt manager English chrome and built-in names contain no Chinese')
await page.locator('[data-testid="prompt-row"]').first().click()
const promptFields = await page.locator('[data-testid="prompt-editor-name"], [data-testid="prompt-editor-description"], [data-testid="prompt-editor-content"]').evaluateAll(nodes => nodes.map(node => node.value).join('\n'))
assert(!/[\u3400-\u9fff]/.test(promptFields), 'built-in prompt detail fields use English presentation copy')
await page.locator('[data-testid="prompt-manager-close"]').click()
await page.locator('[data-testid="prompt-manager"]').waitFor({ state: 'hidden' })
await page.getByRole('button', { name: 'Close' }).first().click()

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
const importReload = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 })
await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(downloadPath)
await page.locator('[data-testid="import-overwrite-warning"]').waitFor({ state: 'visible' })
assert(await page.getByText('Import will replace this browser’s data', { exact: true }).count() === 1, 'ZIP import gives an explicit replacement warning')
assert(await page.locator('[data-testid="confirm-import-overwrite"]').isDisabled(), 'destructive import is disabled until acknowledged')
await page.locator('[data-testid="import-overwrite-warning"] input[type="checkbox"]').check()
assert(!(await page.locator('[data-testid="confirm-import-overwrite"]').isDisabled()), 'acknowledgement enables destructive import')
await page.locator('[data-testid="confirm-import-overwrite"]').click()
await importReload
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await dismissProductGuide(page)
assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'ZIP import restores the language preference')
await page.locator('[data-testid="sidebar-settings"]').click()
assert(await page.locator('input[placeholder="sk-..."]').inputValue() === '', 'ZIP import never restores an API key')

await browser.close()
const passCount = results.filter(result => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && errors.length === 0 ? 0 : 1)
