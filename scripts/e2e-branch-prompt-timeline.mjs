// Stage 14 browser gate: a branch inherits the root prompt timeline, can make a
// route-local mode transition, and sends the next branch message with that mode.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, createBranchFromMessage, getLastRequestBody } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const now = Date.now()
const conversationId = 'stage14-branch-prompt-timeline'
const rootMode = {
  id: 'stage14-root-default',
  afterMessageId: null,
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
}
const rootSocraticMode = {
  id: 'stage14-root-socratic',
  afterMessageId: 'stage14-a1',
  createdAt: now + 1,
  snapshot: {
    kind: 'conversation-mode',
    profileId: 'builtin-conversation-socratic',
    name: '苏格拉底式学习',
    content: '你是一位苏格拉底式学习教练。',
    revision: 1,
    source: 'builtin',
    capturedAt: now + 1,
  },
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

await seedAndBoot(page, {
  convs: [{
    id: conversationId,
    title: 'Stage 14 分支提示词时间线',
    createdAt: now,
    updatedAt: now,
    messages: [
      msg('stage14-u1', 'user', '先学习这个概念'),
      msg('stage14-a1', 'assistant', '这是主线的初始回答。'),
      msg('stage14-u2', 'user', '请继续说明'),
      msg('stage14-a2', 'assistant', '这是模式切换后的主线回答。'),
    ],
    promptTransitions: [rootMode, rootSocraticMode],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})
await installMockModel(page, ['这是分支模式回答'])

assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '苏格拉底式学习', 'root route exposes the mode active after the root transition')
assert(await page.locator('[data-testid="mode-transition-divider"]').count() === 1, 'root mode transition is visible at the message boundary')

await createBranchFromMessage(page, 0)
assert((await page.textContent('body')).includes('这是主线的初始回答。'), 'new branch keeps the inherited message path')
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '苏格拉底式学习', 'branch inherits the root route mode timeline')

await page.locator('button[aria-label="切换对话模式"]').click()
await page.getByRole('menuitemradio', { name: '深入讲解' }).click()
await page.waitForFunction(() => document.querySelector('[data-testid="active-conversation-mode"]')?.textContent === '深入讲解', null, { timeout: 10000 })
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '深入讲解', 'branch can append a route-local mode transition')

const branchRows = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAll()
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result || []) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
const activeBranch = branchRows.find((branch) => branch.conversationId === conversationId)
assert(activeBranch?.promptTransitions?.some((transition) => transition.snapshot?.profileId === 'builtin-conversation-deep-explanation') === true, 'branch-local mode transition is persisted on the branch row')

await page.locator('textarea[aria-label="输入消息"]').fill('继续用这个模式讲解')
await page.locator('textarea[aria-label="输入消息"]').press('Enter')
await page.getByText('这是分支模式回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const request = getLastRequestBody()
const serialized = JSON.stringify(request || {})
assert(serialized.includes('你是一位擅长深入讲解的学习教师'), 'next branch request uses the route-local mode snapshot')
assert((await page.textContent('body')).includes('继续用这个模式讲解'), 'branch message completes after the route-local transition')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
