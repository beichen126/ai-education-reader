// Stage 13 browser gate: conversation mode switching, confirmation, persistence,
// and the next-message request using the selected mode.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getLastRequestBody } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitFor = async (read, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await read()) return true } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

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
const dialogs = []
page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.accept() })

const now = Date.now()
const conversationId = 'stage13-conversation-modes'
await seedAndBoot(page, {
  convs: [{
    id: conversationId,
    title: 'Stage 13 会话模式验收',
    createdAt: now,
    updatedAt: now,
    messages: [
      msg('stage13-mode-u1', 'user', '请解释这个概念'),
      msg('stage13-mode-a1', 'assistant', '这是一个初始回答。'),
    ],
    promptTransitions: [{
      id: 'stage13-default-mode',
      afterMessageId: 'stage13-mode-a1',
      createdAt: now,
      snapshot: {
        kind: 'conversation-mode',
        profileId: 'builtin-conversation-default',
        name: '默认',
        content: '',
        revision: 1,
        source: 'builtin',
        capturedAt: now,
      },
    }],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})
await installMockModel(page, ['切换后的回答'])
const composer = page.locator('textarea[aria-label="输入消息"]')
await composer.waitFor({ state: 'attached', timeout: 20000 })

const contextBar = page.locator('[role="navigation"][aria-label="会话上下文"]')
await contextBar.waitFor({ state: 'visible', timeout: 10000 })
assert(await contextBar.locator('[data-testid="conversation-context-row"]').count() === 2, 'conversation context keeps route and mode rows separate')

const modeTrigger = page.locator('button[aria-label="切换对话模式"]')
assert(await modeTrigger.getAttribute('aria-haspopup') === 'menu' && await modeTrigger.getAttribute('aria-expanded') === 'false', 'mode switch exposes menu button state')
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '默认', 'new conversation starts in the default mode')

await modeTrigger.click()
const modeMenu = page.locator('[role="menu"][aria-label="模式"]')
await modeMenu.waitFor({ state: 'visible', timeout: 5000 })
const selected = modeMenu.locator('[role="menuitemradio"][aria-checked="true"]')
const target = modeMenu.getByRole('menuitemradio', { name: '苏格拉底式学习' })
assert(await selected.count() === 1 && await selected.innerText() === '默认 · 当前', 'mode menu announces the selected mode')
assert(await target.getAttribute('aria-checked') === 'false', 'mode menu exposes an unselected target')

const dialogCount = dialogs.length
await target.click()
assert(await waitFor(() => dialogs.length > dialogCount), 'mode switch requests confirmation after conversation history exists')
assert(dialogs[dialogs.length - 1]?.includes('下一条消息') === true && dialogs[dialogs.length - 1]?.includes('苏格拉底式学习') === true, 'confirmation explains that the selected mode starts with the next message')
assert(await waitFor(() => modeMenu.count().then((count) => count === 0)), 'confirmed mode switch closes the menu')
assert(await waitFor(() => page.locator('[data-testid="active-conversation-mode"]').innerText().then((text) => text === '苏格拉底式学习')), 'confirmed mode becomes the active mode')

const storedAfterSwitch = await readConversation(page, conversationId)
assert(storedAfterSwitch.promptTransitions?.some((transition) => transition.snapshot?.profileId === 'builtin-conversation-socratic') === true, 'mode transition is persisted on the conversation')

await page.reload({ waitUntil: 'networkidle' })
await contextBar.waitFor({ state: 'visible', timeout: 10000 })
assert(await waitFor(() => page.locator('[data-testid="active-conversation-mode"]').innerText().then((text) => text === '苏格拉底式学习')), 'reload restores the persisted active mode')

await composer.fill('请继续说明')
await composer.press('Enter')
await page.getByText('切换后的回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const request = getLastRequestBody()
const serializedRequest = JSON.stringify(request ?? {})
assert(serializedRequest.includes('苏格拉底式学习教练'), 'next-message request contains the selected mode prompt')
assert((await readConversation(page, conversationId)).messages.some((message) => message.role === 'assistant' && message.content === '切换后的回答'), 'next message completes the user -> model response chain')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
