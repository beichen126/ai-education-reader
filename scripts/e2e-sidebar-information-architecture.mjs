// v2.2.0 Stage 3 browser gate: one clear information architecture.
// Sidebar: 资料 / 会话 / footer, no first-level prompt entry, Help last and always reachable.
// Prompts are reached from Settings -> 提示词管理 (four entries, no system-protocol entry),
// and closing the manager returns to Settings with the origin control focused.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const safe = async (fn, fallback = null) => { try { return await fn() } catch { return fallback } }

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [
    { id: 'ia-chat-a', title: '信息架构测试 A', createdAt: now, updatedAt: now, messages: [msg('ia-u1', 'user', '你好'), msg('ia-a1', 'assistant', '你好。')] },
    { id: 'ia-chat-b', title: '信息架构测试 B', createdAt: now - 1, updatedAt: now - 1, messages: [msg('ia-u2', 'user', '第二条')] },
  ],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'ia-chat-a' },
})

const testIdsOf = selector => page.locator(selector).evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))

// ---- expanded sidebar: no tool box, no prompt entry, Help last ----
assert(await page.locator('[data-testid="sidebar-entry-prompts"]').count() === 0, 'expanded sidebar has no first-level prompt entry')
assert((await page.getByText('工具', { exact: true }).count()) === 0, 'expanded sidebar no longer renders a 工具 section')
assert(await page.locator('[data-testid="sidebar-entry-images"]').isVisible() && await page.locator('[data-testid="sidebar-entry-files"]').isVisible(), 'expanded sidebar keeps the 资料 entries')
assert(await page.locator('[data-testid="sidebar-entry-cards"]').isVisible(), 'expanded sidebar exposes the 学习卡片 entry that opens the global learning centre (got ' + (await testIdsOf('[data-testid^="sidebar-entry-"]')).join('|') + ')')
const sidebarButtons = await testIdsOf('[data-testid="sidebar"] button, [data-testid="mobile-history-drawer"] button, .sidebar button')
const expandedOrder = await page.locator('button[data-testid^="sidebar-"], button[data-testid^="help-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
assert(expandedOrder[expandedOrder.length - 1] === 'help-product-guide', 'Help is the last visible sidebar action (got ' + expandedOrder[expandedOrder.length - 1] + ')')
assert(expandedOrder.indexOf('help-product-guide') > expandedOrder.indexOf('sidebar-settings'), 'Help sits below 设置 in the footer')
assert(!expandedOrder.includes('sidebar-entry-prompts'), 'the removed prompt entry is absent from the DOM order')
assert(sidebarButtons.length > 0 || expandedOrder.length > 0, 'sidebar controls were enumerated')

// The conversation list scrolls; the footer (Help) stays reachable.
await page.evaluate(() => {
  const list = document.querySelector('[class*="sidebarList"]')
  if (list) list.scrollTop = list.scrollHeight
})
assert(await page.locator('[data-testid="help-product-guide"]').isVisible(), 'Help stays visible while the conversation list is scrolled')

// ---- collapsed rail order ----
await page.locator('[data-testid="sidebar-collapse"]').click()
await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 10000 })
const railOrder = await testIdsOf('[data-testid^="rail-"]')
assert(railOrder.join('|') === 'rail-history|rail-new-chat|rail-images|rail-files|rail-cards|rail-fullscreen|rail-settings|rail-help', 'collapsed rail order is 历史/新建/图片/文件/学习卡片/全屏/设置/帮助 (got ' + railOrder.join('|') + ')')
assert(await page.locator('[data-testid="rail-prompts"]').count() === 0, 'collapsed rail has no prompt button')
const railNames = await page.locator('[data-testid^="rail-"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
assert(railNames.every(name => typeof name === 'string' && name.trim().length > 0), 'every collapsed rail button has an accessible name')

// ---- Settings owns prompt management ----
await page.locator('[data-testid="rail-settings"]').click()
await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'visible', timeout: 10000 })
const promptEntries = await testIdsOf('[data-testid^="settings-prompts-"]')
assert(promptEntries.join('|') === 'settings-prompts-all|settings-prompts-conversation-mode|settings-prompts-artifact|settings-prompts-quick-follow-up', 'Settings exposes exactly four prompt entries in order (got ' + promptEntries.join('|') + ')')
const entryLabels = await page.locator('[data-testid^="settings-prompts-"]').allTextContents()
assert(entryLabels.map(text => text.trim()).join('|') === '全部提示词|会话模式|学习成果|快捷追问', 'prompt entry labels are the frozen vocabulary (got ' + entryLabels.join('|') + ')')
const settingsButtonLabels = await page.locator('[role="dialog"][aria-label="设置"] button').allTextContents()
assert(!settingsButtonLabels.some(text => text.includes('系统协议')), 'system protocol is not a Settings button (got ' + settingsButtonLabels.join('|') + ')')
assert(await page.locator('[data-testid="settings-prompts-protocol"]').count() === 0, 'Settings has no protocol prompt button')

// ---- each entry opens the matching category and returns to Settings with focus ----
const cases = [
  { control: 'settings-prompts-conversation-mode', category: 'conversation-mode' },
  { control: 'settings-prompts-artifact', category: 'artifact' },
  { control: 'settings-prompts-quick-follow-up', category: 'quick-follow-up' },
  { control: 'settings-prompts-all', category: 'all' },
]
for (const item of cases) {
  await page.locator('[data-testid="' + item.control + '"]').click()
  const manager = page.locator('[data-testid="prompt-manager"]')
  await manager.waitFor({ state: 'visible', timeout: 10000 })
  assert(await page.locator('[data-testid="settings-pdf-navigation"]').count() === 0, item.control + ': Settings closes while the manager is open')
  assert(await page.locator('[data-testid="prompt-category-' + item.category + '"]').getAttribute('aria-current') === 'page', item.control + ': manager opens on the ' + item.category + ' category')
  await page.keyboard.press('Escape')
  await manager.waitFor({ state: 'hidden', timeout: 10000 })
  await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'visible', timeout: 10000 })
  const focused = await page.evaluate(control => document.activeElement?.getAttribute('data-testid') === control, item.control)
  assert(focused === true, item.control + ': closing the manager returns to Settings with the origin focused')
}
await page.keyboard.press('Escape')
await page.locator('[data-testid="settings-prompts"]').waitFor({ state: 'hidden', timeout: 10000 })

// ---- mobile drawer keeps 资料 + Settings and always reaches Help ----
await page.setViewportSize({ width: 375, height: 812 })
await page.locator('[data-testid="rail-history"]').click()
const drawer = page.locator('[data-testid="mobile-history-drawer"]')
await drawer.waitFor({ state: 'visible', timeout: 10000 })
assert(await drawer.locator('[data-testid="sidebar-entry-images"]').count() === 1 && await drawer.locator('[data-testid="sidebar-entry-files"]').count() === 1, 'mobile drawer keeps 图片 and 文件')
assert(await drawer.locator('[data-testid="sidebar-entry-cards"]').count() === 1, 'mobile drawer keeps the 学习卡片 entry')
assert(await drawer.locator('[data-testid="sidebar-settings"]').count() === 1, 'mobile drawer keeps 设置 (the prompt entry point)')
const drawerOrder = await drawer.locator('button[data-testid]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))
assert(drawerOrder[drawerOrder.length - 1] === 'help-product-guide', 'Help is the last button in the mobile drawer (got ' + drawerOrder[drawerOrder.length - 1] + ')')
assert(await drawer.locator('[data-testid="help-product-guide"]').isVisible(), 'Help is visible in the mobile drawer without covering the conversation list')
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), '375px navigation has no horizontal overflow')

assert(errors.length === 0, 'information architecture produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
