// Stage 3 browser gate: historical prompt snapshots stay inspectable while a
// new branch message captures the one canonical default mode.
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
  snapshot: { kind: 'conversation-mode', profileId: 'builtin-conversation-default', name: '默认', content: '', revision: 1, source: 'builtin', capturedAt: now },
}
const rootSocraticMode = {
  id: 'stage14-root-socratic',
  afterMessageId: 'stage14-a1',
  createdAt: now + 1,
  snapshot: { kind: 'conversation-mode', profileId: 'builtin-conversation-socratic', name: '苏格拉底式学习', content: '你是一位苏格拉底式学习教练。', revision: 1, source: 'builtin', capturedAt: now + 1 },
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

await seedAndBoot(page, {
  convs: [{
    id: conversationId,
    title: 'Stage 3 分支提示词时间线',
    createdAt: now,
    updatedAt: now,
    messages: [
      msg('stage14-u1', 'user', '先学习这个概念'),
      msg('stage14-a1', 'assistant', '这是主线的初始回答。'),
      msg('stage14-u2', 'user', '请继续说明'),
      msg('stage14-a2', 'assistant', '这是历史模式下的主线回答。'),
    ],
    promptTransitions: [rootMode, rootSocraticMode],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})
await installMockModel(page, ['这是默认分支回答'])

assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '苏格拉底式学习', 'root route displays the historical mode snapshot without rewriting it')
assert(await page.locator('[data-testid="mode-transition-divider"]').count() === 2, 'root route renders both historical mode boundaries')
await page.locator(`[data-testid="mode-transition-divider"][data-transition-id="${rootSocraticMode.id}"]`).getByRole('button').click()
const inspector = page.locator('[data-testid="prompt-inspector"]')
await inspector.waitFor({ state: 'visible', timeout: 5000 })
assert((await inspector.innerText()).includes('苏格拉底式学习') && (await inspector.locator('[data-testid="prompt-inspector-content"]').inputValue()).includes('苏格拉底式学习教练'), 'historical deprecated snapshot remains inspectable with its original name and content')
await page.getByRole('button', { name: '关闭' }).click()
assert(await page.locator('button[aria-label="切换对话模式"]').count() === 1, 'root route keeps the mode switch control for future messages')
await page.locator('button[aria-label="切换对话模式"]').click()
assert(await page.locator('[role="menu"][aria-label="模式"]').getByRole('menuitemradio', { name: /默认/ }).count() === 1, 'mode menu keeps the canonical default selectable while deprecated history stays compatibility-only')
await page.keyboard.press('Escape')

await createBranchFromMessage(page, 1)
assert((await page.textContent('body')).includes('这是主线的初始回答。'), 'new branch keeps the inherited message path')
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '苏格拉底式学习', 'branch route inherits the historical mode snapshot')
assert(await page.locator('button[aria-label="切换对话模式"]').count() === 1, 'branch route keeps the mode switch control')

await page.locator('textarea[aria-label="输入消息"]').fill('继续学习')
await page.locator('textarea[aria-label="输入消息"]').press('Enter')
await page.getByText('这是默认分支回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const request = getLastRequestBody()
const serialized = JSON.stringify(request || {})
const timelineFrame = request?.messages?.find((message) => message.role === 'system' && String(message.content).startsWith('Prompt Timeline'))
let parsedTimeline = null
try { parsedTimeline = JSON.parse(String(timelineFrame?.content || '').slice('Prompt Timeline\n'.length)) } catch {}
assert(serialized.includes('messages') && parsedTimeline?.currentMode?.name === '默认' && parsedTimeline?.currentMode?.content === '' && parsedTimeline?.segments?.some((segment) => segment.name === '苏格拉底式学习'), 'new branch request uses default for current response while retaining old mode only as historical context')
assert((await page.textContent('body')).includes('继续学习'), 'branch message completes under the canonical default')

const branchRows = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAll()
    get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result || []) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
const activeBranch = branchRows.find((branch) => branch.conversationId === conversationId)
assert(activeBranch?.promptTransitions?.at(-1)?.snapshot?.profileId === 'builtin-conversation-default', 'branch persistence captures the canonical default snapshot')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
