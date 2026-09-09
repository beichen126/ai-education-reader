// Stage 1 browser gate: historical mode snapshot inspection, route mode
// selection, root/branch switching, and responsive context layout.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, createBranchFromMessage } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitFor = async (read, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await read()) return true } catch {}
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return false
}

const now = Date.now()
const conversationId = 'prompt-context'
const conversation = {
  id: conversationId,
  title: '模式上下文测试',
  createdAt: now,
  updatedAt: now,
  messages: [msg('context-u1', 'user', '第一问'), msg('context-a1', 'assistant', '第一答'), msg('context-u2', 'user', '历史模式问题'), msg('context-a2', 'assistant', '历史模式回答')],
  promptTransitions: [{
    id: 'context-old-mode', afterMessageId: 'context-a1', createdAt: now,
    snapshot: { kind: 'conversation-mode', profileId: 'legacy-mode', name: '历史模式', content: '历史系统提示词只用于旧回答。', revision: 1, source: 'legacy', capturedAt: now },
  }],
}
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
await seedAndBoot(page, {
  convs: [conversation],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId, ['draft:' + conversationId]: { version: 1, text: '发送前草稿', imageIds: [] } },
})

const contextBar = page.locator('[role="navigation"][aria-label="会话上下文"]')
await contextBar.waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').textContent() === '历史模式', 'historical route displays its immutable snapshot name')
assert(await page.locator('button[aria-label="切换对话模式"]').count() === 1 && await page.locator('[role="menu"][aria-label="模式"]').count() === 0, 'historical route exposes a future-message mode trigger without opening the menu')

const transitionButton = page.locator('[data-testid="mode-transition-divider"] button').first()
await transitionButton.waitFor({ state: 'visible', timeout: 10000 })
await transitionButton.click()
const inspector = page.locator('[role="dialog"]').filter({ has: page.locator('[data-testid="prompt-inspector"]') })
await inspector.waitFor({ state: 'visible', timeout: 5000 })
assert(await inspector.getAttribute('aria-label') === '提示词检查器' && (await inspector.locator('[data-testid="prompt-inspector-content"]').inputValue()).includes('历史系统提示词'), 'Inspector exposes the immutable historical snapshot')
await page.keyboard.press('Escape')
await inspector.waitFor({ state: 'detached', timeout: 5000 })

const rootTransitionIds = async () => page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversations', 'readonly').objectStore('conversations').get('prompt-context')
    get.onsuccess = () => { try { db.close() } catch {} ; resolve((get.result?.promptTransitions || []).map((item) => item.id)) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
const beforeSend = await rootTransitionIds()
await installMockModel(page, ['默认回答'])
await page.locator('textarea[class*="composerText"]').fill('新默认问题')
await page.keyboard.press('Enter')
await page.getByText('默认回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').textContent() === '默认', 'new send leaves the visible mode at 默认')
assert((await rootTransitionIds()).length === beforeSend.length + 1, 'new send captures a new default boundary after history under the deprecated mode')

const branchesBefore = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAllKeys()
    get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result.map(String).sort()) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
await createBranchFromMessage(page, 0)
const branchesAfter = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAllKeys()
    get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result.map(String).sort()) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
assert(branchesAfter.length === branchesBefore.length + 1, 'branch creation creates exactly one route')
await page.locator('button[aria-label="切换到主线"]').first().click()
await waitFor(() => page.locator('button[aria-label="切换路线"]').getAttribute('aria-expanded').then((value) => value === 'false'))
assert(JSON.stringify(branchesAfter) === JSON.stringify(await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => { const db = request.result; const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAllKeys(); get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result.map(String).sort()) } }
})) ), 'switching back to the root does not create another branch')

for (const size of [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 412, height: 915 }]) {
  await page.setViewportSize(size)
  const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bars: document.querySelectorAll('[aria-label="会话上下文"]').length }))
  const label = size.width + 'x' + size.height
  assert(layout.scrollWidth <= layout.viewport + 1, label + ': Context Bar has no horizontal overflow')
  assert(layout.bars === 1, label + ': Context Bar remains visible')
}

await browser.close()
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((result) => result.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
