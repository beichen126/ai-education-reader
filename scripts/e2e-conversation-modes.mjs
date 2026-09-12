// v2.1.0 browser gate: clean default catalog -> custom mode CRUD -> route switch
// -> next message uses the selected immutable snapshot -> reload keeps the mode.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getLastRequestBody } from './e2e-fixture.mjs'
import { closePromptManager } from './e2e-navigation.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

async function readConversation(page, conversationId) {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('conversations', 'readonly').objectStore('conversations').get(id)
      get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result) }
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  }), conversationId)
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
const conversationId = 'v210-conversation-modes'
await seedAndBoot(page, {
  convs: [{
    id: conversationId,
    title: 'v2.1.0 会话模式验收',
    createdAt: now,
    updatedAt: now,
    messages: [msg('v210-mode-u1', 'user', '请解释这个概念'), msg('v210-mode-a1', 'assistant', '这是默认模式回答。')],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})

await page.locator('[data-testid="sidebar-settings"]').click()
await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="settings-prompts-conversation-mode"]').click()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-category-conversation-mode"]').click()
await page.locator('[data-testid="prompt-row"]').first().waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-row"]').count() === 1, 'clean install shows one default conversation mode')
assert(await page.locator('[data-testid="prompt-new"]').isEnabled(), 'conversation-mode 新建 action is enabled')

await page.locator('[data-testid="prompt-new"]').click()
await page.locator('[data-testid="prompt-editor-kind"]').waitFor({ state: 'visible', timeout: 5000 })
await page.locator('[data-testid="prompt-editor-name"]').fill('数学证明教练')
await page.locator('[data-testid="prompt-editor-description"]').fill('先列命题，再逐步证明')
await page.locator('[data-testid="prompt-editor-content"]').fill('你是一位数学证明教练。先明确命题，再逐步给出证明。')
await page.locator('[data-testid="prompt-save"]').click()
await page.locator('[data-testid="prompt-row"]').filter({ hasText: '数学证明教练' }).waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-row"]').count() === 2, 'creating custom mode adds a second management row')
await closePromptManager(page)

const modeTrigger = page.locator('button[aria-label="切换对话模式"]')
await modeTrigger.waitFor({ state: 'visible', timeout: 10000 })
await modeTrigger.click()
const modeMenu = page.locator('[role="menu"][aria-label="模式"]')
await modeMenu.waitFor({ state: 'visible', timeout: 5000 })
assert(await modeMenu.getByRole('menuitemradio', { name: /数学证明教练/ }).count() === 1, 'current route selector refreshes without page reload')
await modeMenu.getByRole('menuitemradio', { name: /数学证明教练/ }).click()
await page.locator('[data-testid="active-conversation-mode"]').getByText('数学证明教练', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '数学证明教练', 'selected custom mode becomes current route mode')

await installMockModel(page, ['数学模式回答'])
const composer = page.locator('textarea[aria-label="输入消息"]')
await composer.fill('请继续证明')
await composer.press('Enter')
await page.getByText('数学模式回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const request = getLastRequestBody()
const requestText = JSON.stringify(request || {})
assert(requestText.includes('数学证明教练。先明确命题，再逐步给出证明。'), 'next request uses the selected custom mode system snapshot')
const stored = await readConversation(page, conversationId)
assert(stored.promptTransitions?.at(-1)?.snapshot?.name === '数学证明教练', 'custom route transition is durable')
assert(stored.messages.some(message => message.role === 'assistant' && message.content === '数学模式回答'), 'next message completes under the selected custom mode')

await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="active-conversation-mode"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '数学证明教练', 'reload preserves the route mode snapshot')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
