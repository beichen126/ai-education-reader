import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, createBranchFromMessage } from './e2e-fixture.mjs'

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

const browser = await launchBrowser()
let scenario = ''
const only = process.env.V201_ONLY ? new Set(process.env.V201_ONLY.split(',').map((value) => value.trim()).filter(Boolean)) : null
const shouldRun = (name) => !only || only.has(name)

async function openScenario(id, messages, settings = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(scenario + ' pageerror: ' + error.message))
  page.on('console', (message) => {
    // The browser reports the deliberately mocked HTTP 500 as a resource error.
    // It is the fixture's expected transport signal; application/page errors remain failures.
    if (message.type() === 'error' && !(scenario === 'V200-FCR-02' && message.text().includes('status of 500'))) errors.push(scenario + ' console.error: ' + message.text())
  })
  await seedAndBoot(page, {
    convs: [{ id, title: id, createdAt: Date.now(), updatedAt: Date.now(), messages }],
    settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: id, ...settings },
  })
  return { context, page }
}

async function seedQuickPrompts(page, prompts) {
  await page.evaluate((rows) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onerror = () => reject(request.error || new Error('IDB open failed'))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('prompts', 'readwrite')
      const store = tx.objectStore('prompts')
      store.clear()
      for (const row of rows) store.put(row)
      tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
      tx.onerror = () => reject(tx.error || new Error('prompt seed failed'))
    }
  }), prompts)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 15000 })
}

async function readBranchForConversation(page, conversationId) {
  return page.evaluate((id) => new Promise((resolve) => {
    const request = indexedDB.open('ai-education-reader')
    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAll()
      get.onsuccess = () => { try { db.close() } catch {}; resolve((get.result || []).find((branch) => branch.conversationId === id) || null) }
      get.onerror = () => resolve(null)
    }
  }), conversationId)
}

scenario = 'V200-FCR-01'
if (shouldRun(scenario)) {
  const { context, page } = await openScenario('v201-rail', [msg('rail-u1', 'user', '入口测试')])
  const expanded = page.locator('[data-testid="sidebar-entry-files"]')
  if (await expanded.isVisible().catch(() => false)) await page.locator('[data-testid="sidebar-collapse"]').click()
  await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 10000 })
  const order = await page.locator('[data-testid^="rail-"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid')))
  assert(order.join('|') === 'rail-history|rail-new-chat|rail-images|rail-files|rail-cards|rail-fullscreen|rail-settings|rail-help', 'V200-FCR-01 collapsed rail follows the v2.2.0 order with help last (got ' + order.join('|') + ')')
  assert(await page.locator('[data-testid="rail-prompts"]').count() === 0, 'V200-FCR-01 the collapsed rail no longer carries a prompt entry')
  assert(order[order.length - 1] === 'rail-help', 'V200-FCR-01 help is the last collapsed-rail action')
  await page.locator('[data-testid="rail-settings"]').click()
  await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="settings-prompts-all"]').click()
  assert(await page.locator('[data-testid="prompt-manager"]').isVisible(), 'V200-FCR-01 Settings opens Prompt Manager while the rail stays collapsed')
  assert(await page.locator('[data-testid="rail-history"]').isVisible(), 'V200-FCR-01 direct open keeps the rail collapsed')
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-testid="settings-prompts-all"]').evaluate((element) => element === document.activeElement), 'V200-FCR-01 Escape returns to Settings with the origin button focused')
  await context.close()
}

scenario = 'V200-FCR-03'
if (shouldRun(scenario)) {
  const now = Date.now()
  const transitions = [
    { id: 'initial-red', afterMessageId: null, createdAt: now, snapshot: { kind: 'conversation-mode', profileId: 'builtin-conversation-default', name: '默认', content: 'initial', revision: 1, source: 'builtin', capturedAt: now } },
    { id: 'later-red', afterMessageId: 'timeline-u1', createdAt: now + 1, snapshot: { kind: 'conversation-mode', profileId: 'builtin-conversation-socratic', name: '苏格拉底式学习', content: 'later', revision: 1, source: 'builtin', capturedAt: now + 1 } },
  ]
  const { context, page } = await openScenario('v201-initial', [msg('timeline-u1', 'user', '首条问题'), msg('timeline-a1', 'assistant', '首条回答')])
  await page.evaluate((promptTransitions) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onerror = () => reject(request.error || new Error('IDB open failed'))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('conversations', 'readwrite')
      const get = tx.objectStore('conversations').get('v201-initial')
      get.onsuccess = () => { const conversation = get.result; conversation.promptTransitions = promptTransitions; tx.objectStore('conversations').put(conversation) }
      tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
      tx.onerror = () => reject(tx.error || new Error('transition seed failed'))
    }
  }), transitions)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('[data-testid="mode-transition-divider"]').first().waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="mode-transition-divider"]').count() === 2, 'V200-FCR-03 renders initial and later transition exactly once')
  await page.locator('[data-testid="mode-transition-divider"]').first().click()
  assert(await page.getByText('会话开始', { exact: true }).count() > 0, 'V200-FCR-03 initial divider opens an inspector labeled before the first message')
  await context.close()
}

scenario = 'V200-FCR-05'
if (shouldRun(scenario)) {
  const { context, page } = await openScenario('v201-focus', [msg('focus-u1', 'user', '焦点测试')])
  await page.locator('[data-testid="sidebar-settings"]').click()
  await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid="settings-prompts-conversation-mode"]').click()
  const manager = page.locator('[data-testid="prompt-manager"]')
  await manager.waitFor({ state: 'visible', timeout: 10000 })
  assert(await manager.evaluate((element) => element.contains(document.activeElement)), 'V200-FCR-05 opening Prompt Manager moves focus into the dialog')
  await page.keyboard.press('Shift+Tab')
  assert(await manager.evaluate((element) => element.contains(document.activeElement)), 'V200-FCR-05 Shift+Tab from the first control wraps inside the dialog')
  await page.keyboard.press('Tab')
  assert(await manager.evaluate((element) => element.contains(document.activeElement)), 'V200-FCR-05 first Tab remains inside the dialog')
  for (let i = 0; i < 30; i++) await page.keyboard.press('Tab')
  assert(await manager.evaluate((element) => element.contains(document.activeElement)), 'V200-FCR-05 repeated Tab never escapes to the background')
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-testid="settings-prompts-conversation-mode"]').evaluate((element) => element === document.activeElement), 'V200-FCR-05 Escape returns to Settings with the expanded origin focused')
  await context.close()
}

scenario = 'V200-FCR-07'
if (shouldRun(scenario)) {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: 'red-quick-' + (index + 1),
    kind: 'quick-follow-up',
    name: 'Q' + (index + 1),
    description: '',
    source: 'custom',
    enabled: true,
    createdAt: index + 1,
    updatedAt: index + 1,
    revision: 1,
    label: 'Q' + (index + 1),
    userPrompt: 'prompt Q' + (index + 1),
    pinned: false,
    sortOrder: index + 1,
  }))
  const { context, page } = await openScenario('v201-overflow', [msg('overflow-u1', 'user', '问题'), msg('overflow-a1', 'assistant', '回答')])
  await seedQuickPrompts(page, rows)
  assert(await page.locator('[data-testid="quick-follow-up-send"]').count() === 3, 'V200-FCR-07 seven quick follow-ups keep only three visible actions')
  await page.locator('[data-testid="quick-follow-up-more"]').click()
  const overflowLabels = await page.locator('[data-testid="quick-follow-up-more-list"] [data-testid="quick-follow-up-send"]').evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()))
  assert(overflowLabels.join('|') === 'Q4|Q5|Q6|Q7', 'V200-FCR-07 More contains only ordered overflow items Q4-Q7')
  await page.keyboard.press('Escape')
  assert(await page.locator('[data-testid="quick-follow-up-more-list"]').count() === 0, 'V200-FCR-07 Escape closes More')
  assert(await page.locator('[data-testid="quick-follow-up-more"]').evaluate((element) => element === document.activeElement), 'V200-FCR-07 closing More restores focus to its opener')
  await page.locator('[data-testid="quick-follow-up-more"]').click()
  await page.locator('[data-testid="conversation"]').click({ position: { x: 8, y: 8 } })
  assert(await page.locator('[data-testid="quick-follow-up-more-list"]').count() === 0, 'V200-FCR-07 outside click closes More')
  await context.close()
}

scenario = 'V200-FCR-02'
if (shouldRun(scenario)) {
  const { context, page } = await openScenario('v201-branch-failure', [msg('failure-u1', 'user', '问题'), msg('failure-a1', 'assistant', '回答')])
  await createBranchFromMessage(page, 0)
  await page.locator('text=当前路线').first().waitFor({ state: 'visible', timeout: 10000 })
  let requests = 0
  await page.route('**/chat/completions', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': '*' }, body: '' })
    requests++
    return route.fulfill({ status: 500, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'forced branch failure' } }) })
  })
  await page.locator('textarea[class*="composerText"]').fill('branch failure')
  await page.keyboard.press('Enter')
  await waitFor(() => requests === 1)
  await waitFor(() => page.locator('[role="alert"]').count() > 0)
  const branch = await readBranchForConversation(page, 'v201-branch-failure')
  const hiddenEmptyAssistant = branch?.messages?.some((message) => message.role === 'assistant' && !message.content && !message.status && !message.error)
  assert(await page.locator('[role="alert"]').count() > 0, 'V200-FCR-02 branch HTTP 500 produces an accessible visible error')
  assert(hiddenEmptyAssistant !== true, 'V200-FCR-02 branch HTTP 500 does not leave an unmarked empty assistant')
  await context.close()
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
