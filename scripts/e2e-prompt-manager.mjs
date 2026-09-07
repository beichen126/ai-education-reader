// Stage 9 browser gate: local Prompt Manager CRUD, catalog projection and mobile navigation.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitFor = async (read, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await read()) return true } catch {}
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return false
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [{ id: 'prompt-manager-conversation', title: 'Prompt Manager 测试', createdAt: now, updatedAt: now, messages: [msg('pm-u1', 'user', '测试')] }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'prompt-manager-conversation' },
})

const openFromSidebar = async () => {
  const direct = page.locator('[data-testid="sidebar-entry-prompts"]')
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return }
  await page.locator('[data-testid="rail-history"]').click()
  await page.locator('[data-testid="sidebar-entry-prompts"]').click()
}

await openFromSidebar()
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
assert(await manager.getAttribute('aria-label') === '提示词管理', 'Prompt Manager exposes a named dialog')
assert(await page.locator('[data-testid="prompt-category-all"]').count() === 1, 'category: all is available')
assert(await page.locator('[data-testid="prompt-category-conversation-mode"]').count() === 1, 'category: conversation modes is available')
assert(await page.locator('[data-testid="prompt-row"]').count() >= 12, 'catalog loads built-in and migrated prompt definitions')

let externalRequests = 0
const requestListener = (request) => { if (!request.url().startsWith('http://127.0.0.1')) externalRequests++ }
page.on('request', requestListener)

await page.locator('[data-testid="prompt-search"]').fill('苏格拉底')
await page.locator('[data-testid="prompt-row"]').first().click()
assert(await page.locator('[data-source="builtin"]').count() > 0, 'search finds built-in by name')
assert(await page.locator('[data-testid="prompt-editor-content"]').inputValue().then((value) => value.includes('苏格拉底')), 'built-in content is inspectable')
await page.locator('[data-testid="prompt-copy"]').click()
await page.locator('[role="status"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-editor-name"]').inputValue().then((value) => value.includes('副本')), 'copy built-in creates a custom definition')
assert(await page.locator('[data-testid="prompt-save"]').count() === 1, 'copied built-in opens an editable custom form')

const copiedName = await page.locator('[data-testid="prompt-editor-name"]').inputValue()
await page.locator('[data-testid="prompt-manager-close"]').click()
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="composer-materials-input"]').waitFor({ state: 'attached', timeout: 25000 })
await openFromSidebar()
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-search"]').fill(copiedName)
assert(await page.locator('[data-testid="prompt-row"]').count() === 1, 'custom copy survives reload and is searchable')

await page.locator('[data-testid="prompt-search"]').fill('')
await page.locator('[data-testid="prompt-category-artifact"]').click()
assert(await page.locator('[data-testid="prompt-row"]').count() >= 5, 'category filter projects artifact prompts')
await page.locator('[data-testid="prompt-category-all"]').click()
await page.locator('[data-testid="prompt-new"]').click()
await page.locator('[data-testid="prompt-editor-name"]').fill('阶段九自定义模式')
await page.locator('[data-testid="prompt-editor-description"]').fill('用于验证本地 CRUD')
await page.locator('[data-testid="prompt-editor-content"]').fill('只输出可验证的学习步骤。')
await page.locator('[data-testid="prompt-save"]').click()
await page.getByText('提示词已创建。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-editor-name"]').inputValue() === '阶段九自定义模式', 'custom create persists the edited name')

await page.locator('[data-testid="prompt-editor-content"]').fill('保存后的新内容。')
await page.locator('[data-testid="prompt-save"]').click()
await page.getByText('提示词已保存。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="prompt-editor-content"]').inputValue() === '保存后的新内容。', 'custom edit reloads the committed content')

await page.locator('[data-testid="prompt-search"]').fill('')

// Force the real IDB store write to fail. The UI must remain in error state and
// must not claim that a save completed.
await page.evaluate(() => {
  const proto = IDBObjectStore.prototype
  const original = proto.put
  Object.defineProperty(proto, 'put', { configurable: true, value: function (...args) {
    if (this.name === 'prompts' && (window).__failPromptWrites) throw new DOMException('forced prompt write failure', 'UnknownError')
    return original.apply(this, args)
  } })
  ;(window).__failPromptWrites = true
})
await page.locator('[data-testid="prompt-editor-content"]').fill('这次写入应失败。')
await page.locator('[data-testid="prompt-save"]').click()
await page.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[role="alert"]').innerText().then((value) => value.includes('forced prompt write failure')), 'store write failure is shown as an error')
assert(await page.getByText('提示词已保存。', { exact: true }).count() === 0, 'store write failure never claims saved')
await page.evaluate(() => { delete (window).__failPromptWrites })

const customRow = page.locator('[data-testid="prompt-row"]').filter({ hasText: '阶段九自定义模式' })
assert(await customRow.count() === 1, 'failed save keeps the existing custom row')
await page.locator('[data-testid="prompt-delete"]').click()
await waitFor(() => page.locator('[data-testid="prompt-row"]').filter({ hasText: '阶段九自定义模式' }).count() === 0, 10000)
assert(await page.locator('[data-testid="prompt-row"]').filter({ hasText: '阶段九自定义模式' }).count() === 0, 'custom delete removes only the selected definition')

assert(externalRequests === 0, 'opening and using Prompt Manager makes no network request')
page.off('request', requestListener)
await page.locator('[data-testid="prompt-manager-close"]').click()

await page.setViewportSize({ width: 390, height: 844 })
await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="rail-history"]').click()
const nav = page.locator('[data-testid="mobile-history-drawer"]')
assert(await nav.getAttribute('role') === 'navigation' && await nav.getAttribute('aria-label') === '主导航', 'mobile drawer is announced as main navigation')
await nav.locator('[data-testid="sidebar-entry-prompts"]').click()
assert(await manager.getAttribute('data-mobile-step') === 'categories', 'mobile Prompt Manager starts at category step')
await page.locator('[data-testid="prompt-category-conversation-mode"]').click()
assert(await manager.getAttribute('data-mobile-step') === 'list', 'mobile category selection opens the list step')
await page.locator('[data-testid="prompt-row"]').first().click()
assert(await manager.getAttribute('data-mobile-step') === 'detail', 'mobile list selection opens the detail step')
const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
assert(dimensions.scrollWidth <= dimensions.width + 1, 'mobile Prompt Manager has no horizontal overflow')

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
