import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push('console.error: ' + message.text()) })

const now = Date.now()
const failed = msg('failed', 'assistant', '部分失败回答')
failed.status = 'failed'; failed.error = '服务失败'
const aborted = msg('aborted', 'assistant', '部分停止回答')
aborted.status = 'aborted'; aborted.error = '已停止生成'
const emptyFailed = msg('empty-failed', 'assistant', '')
emptyFailed.status = 'failed'; emptyFailed.error = '空回答失败'
await seedAndBoot(page, {
  convs: [{ id: 'v202-message-state', title: 'v202 message state', createdAt: now, updatedAt: now, messages: [
    msg('user-1', 'user', '问题'), msg('completed', 'assistant', '已完成回答'), failed, aborted, emptyFailed,
  ] }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: 'v202-message-state' },
})

await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error || new Error('IDB open failed'))
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('prompts', 'readwrite')
    tx.objectStore('prompts').put({ id: 'v202-quick', kind: 'quick-follow-up', name: '继续', description: '', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '继续', userPrompt: '继续解释', pinned: false, sortOrder: 1 })
    tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
    tx.onerror = () => reject(tx.error || new Error('prompt seed failed'))
  }
}));
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 15000 })

const triggerIds = await page.locator('button[aria-label="消息操作"]').evaluateAll((buttons) => buttons.map((button) => button.closest('[data-message-id]')?.getAttribute('data-message-id')))
assert(triggerIds.length === 1 && triggerIds[0] === 'completed', 'completed assistant alone exposes branch/artifact actions')
const bars = page.locator('[data-testid="quick-follow-up-bar"]')
assert(await bars.count() === 1, 'completed assistant alone exposes Quick Follow-up bar')
assert(await bars.first().evaluate((bar) => bar.previousElementSibling?.getAttribute('data-message-id') === 'completed'), 'Quick Follow-up bar belongs to the completed assistant')
assert(await page.locator('[data-testid="assistant-generation-error"]').count() === 3, 'failed/aborted messages keep all failure banners visible')
const bannerText = await page.locator('[data-testid="assistant-generation-error"]').allTextContents()
assert(bannerText.some((text) => text.includes('生成失败：服务失败')), 'failed partial assistant keeps its failure banner')
assert(bannerText.some((text) => text.includes('已停止生成：已停止生成')), 'aborted partial assistant keeps its stopped banner')
assert(bannerText.some((text) => text.includes('生成失败：空回答失败')), 'failed empty assistant keeps its failure banner')

await context.close()
await browser.close()
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
