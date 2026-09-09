import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [{ id: 'v210-red-conversation', title: 'v2.1.0 RED 测试', createdAt: now, updatedAt: now, messages: [msg('v210-red-u1', 'user', '测试'), msg('v210-red-a1', 'assistant', '测试回答')] }],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'v210-red-conversation' },
})

const promptEntry = page.locator('[data-testid="sidebar-entry-prompts"], [data-testid="rail-prompts"]').first()
await promptEntry.click()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-conversation-mode"]').click()
await page.locator('[data-testid="prompt-row"]').first().waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-row"]').count() === 1, 'V210-RED clean install Prompt Manager shows only 默认')
assert(await page.locator('[data-testid="prompt-new"]').isEnabled(), 'V210-RED conversation-mode 新建 is enabled')
assert((await page.locator('[data-testid="conversation-mode-new-hint"]').count()) === 0, 'V210-RED singleton prohibition hint is removed')
await page.locator('[data-testid="prompt-new"]').click().catch(() => {})
assert(await page.locator('[data-testid="prompt-editor-kind"]').count() === 1, 'V210-RED user can open custom conversation-mode editor')

await page.locator('[data-testid="prompt-manager-close"]').click()
assert(await page.locator('button[aria-label="切换对话模式"]').count() === 1, 'V210-RED current route exposes a selectable mode control')

await openAppDb(page, {
  store: 'prompts',
  operation: 'put',
  value: { id: 'v210-red-custom-mode', kind: 'conversation-mode', name: '数学证明教练', description: '用证明步骤解释数学问题', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: '先明确命题，再逐步给出证明。' },
})

// The shared fixture suppresses onboarding for unrelated E2E scenarios. Remove that
// marker here because this RED test explicitly verifies the no-key first-entry path.
await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('settings', 'readwrite')
    tx.objectStore('settings').delete('productGuideSeenVersion')
    tx.oncomplete = () => { db.close(); resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
}))

await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
assert(await page.locator('[data-testid="product-guide"]').isVisible().catch(() => false), 'V210-RED no-key first entry opens Product Guide')
assert(await page.locator('[data-testid="help-product-guide"], [data-testid="rail-help"]').count() > 0, 'V210-RED permanent Help entry is reachable')

const promptRows = await openAppDb(page, { store: 'prompts' })
assert(promptRows.some(row => row.id === 'v210-red-custom-mode'), 'V210-RED browser fixture can restore a persisted custom mode')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
