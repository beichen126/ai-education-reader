import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
const conversationId = 'v203-quick-anchor'
const conversation = {
  id: conversationId,
  title: 'v2.0.3 Quick Follow-up 锚点测试',
  createdAt: now,
  updatedAt: now,
  messages: [
    msg('v203-anchor-u1', 'user', '第一个问题'),
    msg('v203-anchor-a1', 'assistant', '第一个回答'),
    msg('v203-anchor-u2', 'user', '第二个问题'),
    { ...msg('v203-anchor-a2', 'assistant', ''), status: 'failed', error: '模拟失败' },
  ],
}

await seedAndBoot(page, {
  convs: [conversation],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: conversationId },
})
await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const transaction = db.transaction('prompts', 'readwrite')
    transaction.objectStore('prompts').put({
      id: 'v203-anchor-quick', kind: 'quick-follow-up', name: '继续', description: '', source: 'custom', enabled: true,
      createdAt: 1, updatedAt: 1, revision: 1, label: '继续', userPrompt: '请继续解释', pinned: true, sortOrder: 1,
    })
    transaction.oncomplete = () => { db.close(); resolve(true) }
    transaction.onerror = () => reject(transaction.error)
  }
  request.onerror = () => reject(request.error)
}))
await page.reload({ waitUntil: 'networkidle' })
await page.locator('text=模拟失败').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="quick-follow-up-bar"]').count() === 0, 'completed→failed tail has no Quick Follow-up anchor')

await page.evaluate((id) => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const transaction = db.transaction('conversations', 'readwrite')
    const store = transaction.objectStore('conversations')
    const get = store.get(id)
    get.onsuccess = () => {
      const row = get.result
      const tail = row.messages[row.messages.length - 1]
      store.put({ ...row, messages: [...row.messages.slice(0, -1), { ...tail, status: 'aborted', error: '模拟中止' }] })
    }
    transaction.oncomplete = () => { db.close(); resolve(true) }
    transaction.onerror = () => reject(transaction.error)
  }
  request.onerror = () => reject(request.error)
}), conversationId)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('text=模拟中止').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="quick-follow-up-bar"]').count() === 0, 'completed→aborted tail has no Quick Follow-up anchor')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
