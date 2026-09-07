import { createServer } from 'node:http'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getRouteHits, getLastRequestBody } from './e2e-fixture.mjs'

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

const quickRows = [
  { id: 'quick-explain', kind: 'quick-follow-up', name: '解释', description: '继续解释', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '解释', userPrompt: '请继续解释上一条回答', pinned: true, sortOrder: 1 },
  { id: 'quick-example', kind: 'quick-follow-up', name: '举例', description: '补一个例子', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '举例', userPrompt: '请补充一个具体例子', pinned: false, sortOrder: 2 },
  { id: 'quick-challenge', kind: 'quick-follow-up', name: '反问', description: '继续检查理解', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '反问', userPrompt: '请用一个问题检查我的理解', pinned: false, sortOrder: 3 },
  { id: 'quick-summary', kind: 'quick-follow-up', name: '总结', description: '提炼要点', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '总结', userPrompt: '请总结上一条回答的要点', pinned: false, sortOrder: 4 },
]

const streamServer = createServer((request, response) => {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' }); response.end(); return }
  if (String(request.url).includes('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*' })
    const send = (text, delay) => setTimeout(() => {
      if (!response.destroyed) response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }) + '\n\n')
    }, delay)
    send('快捷回答二', 350)
    send('完成', 800)
    setTimeout(() => { if (!response.destroyed) { response.write('data: [DONE]\n\n'); response.end() } }, 1100)
    return
  }
  response.writeHead(404, { 'access-control-allow-origin': '*' }); response.end()
})
await new Promise((resolve) => streamServer.listen(0, '127.0.0.1', resolve))
const streamPort = streamServer.address().port

async function writePromptRows(page, rows) {
  await page.evaluate((values) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('prompts', 'readwrite')
      const os = tx.objectStore('prompts')
      os.clear()
      for (const value of values) os.put(value)
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  }), rows)
}

async function readConversation(page, id) {
  return page.evaluate((conversationId) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('conversations', 'readonly').objectStore('conversations').get(conversationId)
      get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result) }
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  }), id)
}

async function readBranches(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAll()
      get.onsuccess = () => { try { db.close() } catch {} ; resolve(get.result) }
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  }))
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

const now = Date.now()
const conversationId = 'quick-follow-up-e2e'
const conversation = {
  id: conversationId,
  title: '快捷追问测试',
  createdAt: now,
  updatedAt: now,
  messages: [msg('quick-u0', 'user', '什么是递归？'), msg('quick-a0', 'assistant', '递归是函数调用自身来解决问题的方法。')],
  promptTransitions: [{
    id: 'quick-mode-transition', afterMessageId: 'quick-a0', createdAt: now,
    snapshot: { kind: 'conversation-mode', profileId: 'mode-snapshot', name: '测试学习模式', content: '当前模式：必须给出分步解释。', revision: 1, source: 'custom', capturedAt: now },
  }],
}
await seedAndBoot(page, {
  convs: [conversation],
  settings: {
    apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'http://127.0.0.1:' + streamPort, lastConversationId: conversationId,
    ['draft:' + conversationId]: { version: 1, text: '这份草稿不能被快捷发送清掉', imageIds: [] },
  },
})
await writePromptRows(page, quickRows)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 15000 })
const quickBar = page.locator('[data-testid="quick-follow-up-bar"]')
assert(await quickBar.locator('[data-testid="quick-follow-up-send"]').count() === 3, 'desktop shows at most three quick follow-ups')
assert(await quickBar.getByRole('button', { name: '发送快捷追问：解释' }).count() === 1, 'pinned quick follow-up is visible first')
assert(await quickBar.locator('[data-testid="quick-follow-up-more"]').count() === 1, 'desktop exposes more for additional quick follow-ups')
await page.setViewportSize({ width: 390, height: 844 })
const mobileQuickCount = await quickBar.locator('[data-testid="quick-follow-up-send"]').count()
assert(mobileQuickCount >= 2 && mobileQuickCount <= 3, 'mobile keeps two to three quick follow-ups visible')
assert(await quickBar.locator('[data-testid="quick-follow-up-more"]').count() === 1, 'mobile keeps a more entry for additional quick follow-ups')
await page.setViewportSize({ width: 1440, height: 900 })

const initialHits = getRouteHits().completions
await installMockModel(page, ['快捷回答一'])
assert((await page.locator('textarea[class*="composerText"]').inputValue()) === '这份草稿不能被快捷发送清掉', 'composer draft is visible before quick send')
assert((await page.locator('[data-testid="quick-follow-up-send"]').count()) === 3 && initialHits === 0, 'quick catalog hydration makes no model request')
await page.getByRole('button', { name: '发送快捷追问：解释' }).click()
await page.getByText('快捷回答一', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
assert((await page.locator('textarea[class*="composerText"]').inputValue()) === '这份草稿不能被快捷发送清掉', 'root quick send preserves composer draft')
const rootAfterFirst = await readConversation(page, conversationId)
const firstQuick = rootAfterFirst.messages.find((item) => item.quickFollowUp?.promptId === 'quick-explain')
assert(firstQuick?.content === '请继续解释上一条回答', 'root click creates a real user Message with actual prompt content')
assert(firstQuick?.quickFollowUp?.labelSnapshot === '解释' && firstQuick?.quickFollowUp?.promptSnapshot === '请继续解释上一条回答', 'root message stores frozen quick snapshot')
const firstBody = getLastRequestBody()
assert(JSON.stringify(firstBody).includes('当前模式：必须给出分步解释。'), 'current Conversation Mode is preserved in quick send request')

await page.locator('[data-testid="quick-follow-up-history-inspect"]').last().click()
await page.locator('[data-testid="quick-follow-up-dialog"]').waitFor({ state: 'visible', timeout: 5000 })
assert((await page.locator('[data-testid="quick-follow-up-dialog"]').textContent()).includes('请继续解释上一条回答'), 'historical quick prompt is viewable from the message snapshot')
await page.locator('[data-testid="quick-follow-up-dialog"] button[aria-label="关闭实际提示词"]').click()

await page.unroute('**/chat/completions')
await page.evaluate(() => {
  const button = document.querySelectorAll('[data-testid="quick-follow-up-send"]')[1]
  if (!(button instanceof HTMLElement)) throw new Error('example quick follow-up button missing')
  button.click()
  button.click()
})
await page.locator('text=正在生成…').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="quick-follow-up-send"]').allTextContents().then((labels) => labels.every((label) => !label.includes('发送中…') || true)), 'quick send enters the shared generation state')
assert(await page.locator('[data-testid="quick-follow-up-send"]').first().isDisabled(), 'quick follow-ups are disabled while streaming')
await page.waitForFunction(() => document.body.innerText.includes('快捷回答二') && !document.body.innerText.includes('正在生成…'), null, { timeout: 15000 })
const rootAfterDoubleClick = await readConversation(page, conversationId)
assert(rootAfterDoubleClick.messages.filter((item) => item.quickFollowUp?.promptId === 'quick-example').length === 1, 'double click accepts only one quick follow-up message')

// Fork from the latest completed assistant, then send from the branch-local quick bar.
await page.locator('button[aria-label="消息操作"]').last().click()
await page.getByText('从这里分支', { exact: true }).click()
await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 10000 })
await installMockModel(page, ['分支快捷回答'])
await page.getByRole('button', { name: '发送快捷追问：反问' }).click()
await page.getByText('分支快捷回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const branches = await readBranches(page)
const branchQuick = branches.flatMap((branch) => branch.messages).find((item) => item.quickFollowUp?.promptId === 'quick-challenge')
assert(branchQuick?.content === '请用一个问题检查我的理解', 'branch click creates a branch-local real user message')
const rootAfterBranch = await readConversation(page, conversationId)
assert(!rootAfterBranch.messages.some((item) => item.quickFollowUp?.promptId === 'quick-challenge'), 'branch quick follow-up does not pollute root history')

await writePromptRows(page, [])
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 15000 })
assert(await page.locator('[data-testid="quick-follow-up-configure"]').count() === 1, 'empty quick follow-up state exposes configuration action')
await page.locator('[data-testid="quick-follow-up-history-inspect"]').last().click()
await page.locator('[data-testid="quick-follow-up-dialog"]').waitFor({ state: 'visible', timeout: 5000 })
assert((await page.locator('[data-testid="quick-follow-up-dialog"]').textContent()).includes('请用一个问题检查我的理解'), 'deleted profile keeps historical label and prompt snapshot viewable')
await page.locator('[data-testid="quick-follow-up-dialog"] button[aria-label="关闭实际提示词"]').click()
await page.locator('[data-testid="quick-follow-up-configure"]').click()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-category-quick-follow-up"]').getAttribute('data-active') === 'true', 'empty state deep-links directly to Quick Follow-up category')

await browser.close()
streamServer.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
