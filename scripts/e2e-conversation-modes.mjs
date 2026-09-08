// Stage 3 browser gate: one visible default conversation entry, deprecated mode
// compatibility, and new sends resolving the canonical default.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getLastRequestBody } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

async function readConversation(page, conversationId) {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('conversations', 'readonly')
      const get = tx.objectStore('conversations').get(id)
      get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result) }
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  }), conversationId)
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
const now = Date.now()
const conversationId = 'stage13-conversation-modes'
await seedAndBoot(page, {
  convs: [{
    id: conversationId,
    title: 'Stage 3 会话模式验收',
    createdAt: now,
    updatedAt: now,
    messages: [
      msg('stage13-mode-u1', 'user', '请解释这个概念'),
      msg('stage13-mode-a1', 'assistant', '这是一个初始回答。'),
    ],
    promptTransitions: [{
      id: 'stage13-deprecated-socratic',
      afterMessageId: 'stage13-mode-a1',
      createdAt: now,
      snapshot: {
        kind: 'conversation-mode',
        profileId: 'builtin-conversation-socratic',
        name: '苏格拉底式学习',
        content: '你是一位苏格拉底式学习教练。',
        revision: 1,
        source: 'builtin',
        capturedAt: now,
      },
    }],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})
await installMockModel(page, ['默认模式回答'])
const composer = page.locator('textarea[aria-label="输入消息"]')
await composer.waitFor({ state: 'attached', timeout: 20000 })

const contextBar = page.locator('[role="navigation"][aria-label="会话上下文"]')
await contextBar.waitFor({ state: 'visible', timeout: 10000 })
assert(await contextBar.locator('[data-testid="conversation-context-row"]').count() === 2, 'conversation context keeps route and static mode rows separate')
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '默认', 'main conversation context always displays 默认')
assert(await page.locator('button[aria-label="切换对话模式"]').count() === 0, 'main conversation has no mode switch trigger')
assert(await page.locator('[role="menu"][aria-label="模式"]').count() === 0, 'main conversation has no empty mode menu')

await composer.fill('请继续说明')
await composer.press('Enter')
await page.getByText('默认模式回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const request = getLastRequestBody()
const serializedRequest = JSON.stringify(request ?? {})
assert(serializedRequest.includes('messages') && !serializedRequest.includes('苏格拉底式学习教练'), 'new message request does not use the deprecated Socratic prompt')
const stored = await readConversation(page, conversationId)
assert(stored.promptTransitions?.at(-1)?.snapshot?.profileId === 'builtin-conversation-default', 'new message persists a canonical default snapshot at the route boundary')
assert(stored.messages.some((message) => message.role === 'assistant' && message.content === '默认模式回答'), 'new message completes the user -> model response chain')

await page.reload({ waitUntil: 'networkidle' })
await contextBar.waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '默认' && await page.locator('button[aria-label="切换对话模式"]').count() === 0, 'reload keeps the static default UI')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
