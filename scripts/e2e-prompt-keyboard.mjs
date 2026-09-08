// Stage 3 browser gate: the deprecated mode menu is absent while the route
// popup keeps its existing focus and keyboard contract.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, createBranchFromMessage } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitFor = async (read, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await read()) return true } catch {}
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return false
}
const focusIs = (selector) => waitFor(() => page.locator(selector).evaluate((el) => el === document.activeElement))
const focusItem = (selector, index) => waitFor(() => page.locator(selector).nth(index).evaluate((el) => el === document.activeElement))
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))

const now = Date.now()
const conversation = {
  id: 'prompt-keyboard',
  title: 'Popup 键盘测试',
  createdAt: now,
  updatedAt: now,
  messages: [msg('keyboard-u1', 'user', '问题'), msg('keyboard-a1', 'assistant', '答案')],
}
await seedAndBoot(page, {
  convs: [conversation],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversation.id },
})

assert(await page.locator('button[aria-label="切换对话模式"]').count() === 0, 'mode switch trigger is absent')
assert(await page.locator('[role="menu"][aria-label="模式"]').count() === 0, 'mode menu is absent rather than empty')
assert(await page.locator('[data-testid="active-conversation-mode"]').innerText() === '默认', 'static mode label is 默认')

await createBranchFromMessage(page, 0)
const routeTrigger = page.locator('button[aria-label="切换路线"]')
await routeTrigger.waitFor({ state: 'visible', timeout: 5000 })
await routeTrigger.click()
const routeMenu = page.locator('[role="menu"][aria-label="路线"]')
const routeItems = routeMenu.locator('[role="menuitem"]:not([disabled])')
await routeItems.first().waitFor({ state: 'visible', timeout: 5000 })
assert(await focusIs('[role="menuitem"][data-selected="true"]'), 'route open focuses selected item')
await page.keyboard.press('Escape')
assert(await focusIs('button[aria-label="切换路线"]') && await routeTrigger.getAttribute('aria-expanded') === 'false', 'route Escape closes and returns focus to trigger')

await routeTrigger.press('ArrowDown')
assert(await routeTrigger.getAttribute('aria-expanded') === 'true', 'route trigger ArrowDown opens the menu')
assert(await focusItem('[role="menuitem"]:not([disabled])', 0), 'route ArrowDown focuses first enabled item')
await page.keyboard.press('End')
assert(await focusItem('[role="menuitem"]:not([disabled])', (await routeItems.count()) - 1), 'route End roves to last enabled item')
await page.keyboard.press('Home')
assert(await focusItem('[role="menuitem"]:not([disabled])', 0), 'route Home roves to first enabled item')
await page.keyboard.press('Escape')

await browser.close()
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((result) => result.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
