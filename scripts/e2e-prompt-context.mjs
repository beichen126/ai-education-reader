// Stage 8 browser gate: Route + Mode context, safe mode switching, mode divider,
// snapshot inspector, streaming lock, branch route switching, and phone layouts.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, installAsyncMockModel, createBranchFromMessage } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
const dialogs = []
page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.accept() })

const now = Date.now()
const conversation = {
  id: 'prompt-context',
  title: '模式上下文测试',
  createdAt: now,
  updatedAt: now,
  messages: [msg('context-u1', 'user', '第一问'), msg('context-a1', 'assistant', '第一答')],
}
await seedAndBoot(page, {
  convs: [conversation],
  settings: {
    apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversation.id,
    ['draft:' + conversation.id]: { version: 1, text: '切换前草稿', imageIds: [] },
  },
})

const modeButton = page.locator('button[aria-label="切换对话模式"]')
await modeButton.waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="active-conversation-mode"]').textContent()).includes('模式未记录'), 'legacy history shows 模式未记录 and does not fabricate a mode')

await modeButton.click()
await page.locator('[role="menuitemradio"]:has-text("苏格拉底式学习")').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[role="menuitemradio"]:has-text("苏格拉底式学习")').click()
assert(dialogs.some((message) => message.includes('从下一条消息开始') && message.includes('草稿将在新模式下发送')), 'historical switch confirms boundary and explains draft behavior')
await page.locator('[data-testid="active-conversation-mode"]:has-text("苏格拉底式学习")').waitFor({ state: 'visible', timeout: 10000 })

await installMockModel(page, ['新模式回答'])
await page.locator('textarea[class*="composerText"]').fill('新模式问题')
await page.keyboard.press('Enter')
await page.getByText('新模式回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const divider = page.locator('[data-testid="mode-transition-divider"]')
assert(await divider.count() === 1 && (await divider.textContent()).includes('苏格拉底式学习'), 'new message renders one lightweight mode divider at the transition boundary')
await divider.locator('button').click()
await page.locator('[data-testid="prompt-inspector"]').waitFor({ state: 'visible', timeout: 5000 })
const inspected = await page.locator('[data-testid="prompt-inspector-content"]').inputValue()
assert(inspected.includes('苏格拉底式学习'), 'Inspector shows the captured snapshot prompt, not a current profile lookup')
await page.keyboard.press('Escape')
await page.locator('[data-testid="prompt-inspector"]').waitFor({ state: 'detached', timeout: 5000 })

const rootTransitionIds = async () => page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversations', 'readonly').objectStore('conversations').get('prompt-context')
    get.onsuccess = () => { try { db.close() } catch {}; resolve((get.result?.promptTransitions || []).map((item) => item.id)) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
const branchIds = async () => page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('conversationBranches', 'readonly').objectStore('conversationBranches').getAllKeys()
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result.map(String).sort()) }
    get.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
}))
const beforeRouteSwitch = await rootTransitionIds()
const branchesBeforeCreate = await branchIds()
await createBranchFromMessage(page, 0)
const branchesAfterCreate = await branchIds()
assert(branchesAfterCreate.length === branchesBeforeCreate.length + 1, 'branch creation creates exactly one route')
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForFunction(() => document.querySelector('button[aria-label="切换路线"]')?.getAttribute('aria-expanded') === 'false', null, { timeout: 5000 })
const afterRouteSwitch = await rootTransitionIds()
const branchesAfterRouteSwitch = await branchIds()
assert(JSON.stringify(beforeRouteSwitch) === JSON.stringify(afterRouteSwitch), 'route switching does not create or mutate a mode snapshot')
assert(JSON.stringify(branchesAfterCreate) === JSON.stringify(branchesAfterRouteSwitch), 'switching back to the root does not create another branch')

const deletedMode = {
  id: 'custom-mode-deleted', kind: 'conversation-mode', name: '已删除模式', description: '删除后仍可审计', source: 'custom',
  enabled: true, createdAt: now, updatedAt: now, revision: 1, systemPrompt: '删除后仍保留的历史提示词内容',
}
const putPrompt = async (row) => page.evaluate((value) => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('prompts', 'readwrite')
    tx.objectStore('prompts').put(value)
    tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
  request.onerror = () => reject(request.error)
}), row)
const deletePrompt = async (id) => page.evaluate((value) => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('prompts', 'readwrite')
    tx.objectStore('prompts').delete(value)
    tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
    tx.onerror = () => reject(tx.error)
  }
  request.onerror = () => reject(request.error)
}), id)
await putPrompt(deletedMode)
await page.reload({ waitUntil: 'networkidle' })
await modeButton.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="active-conversation-mode"]:has-text("苏格拉底式学习")').waitFor({ state: 'visible', timeout: 10000 })
await modeButton.click()
const deletedModeItem = page.locator('[role="menuitemradio"]').filter({ hasText: '已删除模式' })
await deletedModeItem.waitFor({ state: 'visible', timeout: 10000 })
await deletedModeItem.click()
await page.locator('[data-testid="active-conversation-mode"]:has-text("已删除模式")').waitFor({ state: 'visible', timeout: 10000 })
await deletePrompt(deletedMode.id)
await installMockModel(page, ['已删除模式回答'])
await page.locator('textarea[class*="composerText"]').fill('删除模式后的问题')
await page.keyboard.press('Enter')
await page.getByText('已删除模式回答', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
const deletedDivider = page.locator('[data-testid="mode-transition-divider"]').filter({ hasText: '已删除模式' })
await deletedDivider.waitFor({ state: 'visible', timeout: 5000 })
await deletedDivider.locator('button').click()
await page.locator('[data-testid="prompt-inspector"]').waitFor({ state: 'visible', timeout: 5000 })
const deletedSnapshot = await page.locator('[data-testid="prompt-inspector-content"]').inputValue()
assert(deletedSnapshot.includes('删除后仍保留的历史提示词内容'), 'deleted profile snapshot remains inspectable with frozen content')
await page.keyboard.press('Escape')
await page.locator('[data-testid="prompt-inspector"]').waitFor({ state: 'detached', timeout: 5000 })

await installAsyncMockModel(page, [{ text: '流式第一段', delayMs: 350 }, { text: '流式第二段', delayMs: 700 }])
await page.locator('textarea[class*="composerText"]').fill('流式问题')
await page.keyboard.press('Enter')
await page.locator('text=正在生成…').waitFor({ state: 'visible', timeout: 10000 })
assert(await modeButton.isDisabled(), 'mode switch is disabled while streaming')
assert((await page.locator('[data-testid="mode-disabled-reason"]').textContent()).includes('生成中'), 'streaming disabled state explains why mode switching is unavailable')
await page.locator('text=停止生成').click()
await page.waitForFunction(() => !document.querySelector('button[aria-label="切换对话模式"]')?.disabled, null, { timeout: 10000 })

for (const size of [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 412, height: 915 }]) {
  await page.setViewportSize(size)
  await page.waitForTimeout(120)
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
