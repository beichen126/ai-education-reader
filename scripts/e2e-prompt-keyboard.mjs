// CR-Fix Stage 5 browser gate: mode/route popup focus and keyboard contract.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installAsyncMockModel, createBranchFromMessage } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitFor = async (read, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await read()) return true
    } catch {}
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
page.on('dialog', (dialog) => { void dialog.accept() })

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

const modeTrigger = page.locator('button[aria-label="切换对话模式"]')
await modeTrigger.waitFor({ state: 'visible', timeout: 10000 })

await modeTrigger.click()
const modeMenu = page.locator('[role="menu"][aria-label="模式"]')
const modeItems = modeMenu.locator('[role="menuitemradio"]:not([disabled])')
await modeItems.first().waitFor({ state: 'visible', timeout: 5000 })
assert(await modeMenu.locator('[role="menuitemradio"][aria-checked="true"]:not([disabled])').evaluate((el) => el === document.activeElement), 'mode open focuses selected enabled item')
await page.keyboard.press('Escape')
assert(await focusIs('button[aria-label="切换对话模式"]') && await modeTrigger.getAttribute('aria-expanded') === 'false', 'mode Escape closes and returns focus to trigger')

await modeTrigger.press('ArrowDown')
assert(await modeTrigger.getAttribute('aria-expanded') === 'true', 'mode trigger ArrowDown opens the menu')
assert(await focusItem('[role="menuitemradio"]:not([disabled])', 0), 'mode ArrowDown focuses first enabled item')
await page.keyboard.press('Escape')
await modeTrigger.press('ArrowUp')
assert(await modeTrigger.getAttribute('aria-expanded') === 'true', 'mode trigger ArrowUp opens the menu')
assert(await focusItem('[role="menuitemradio"]:not([disabled])', (await modeItems.count()) - 1), 'mode ArrowUp focuses last enabled item')
await page.keyboard.press('Home')
assert(await focusItem('[role="menuitemradio"]:not([disabled])', 0), 'mode Home roves to first enabled item')
await page.keyboard.press('End')
assert(await focusItem('[role="menuitemradio"]:not([disabled])', (await modeItems.count()) - 1), 'mode End roves to last enabled item')
await page.keyboard.press('ArrowUp')
assert(await focusItem('[role="menuitemradio"]:not([disabled])', Math.max(0, (await modeItems.count()) - 2)), 'mode ArrowUp roves within menu')
await page.keyboard.press('Escape')

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

await modeTrigger.click()
const alternateMode = modeItems.nth(Math.min(1, (await modeItems.count()) - 1))
await alternateMode.click()
await page.waitForFunction(() => document.querySelector('button[aria-label="切换对话模式"]')?.getAttribute('aria-expanded') === 'false', null, { timeout: 10000 })
const modeFocusReturned = await page.waitForFunction(() => document.querySelector('button[aria-label="切换对话模式"]') === document.activeElement, null, { timeout: 5000 }).then(() => true).catch(() => false)
assert(modeFocusReturned, 'successful mode selection returns focus to mode trigger')

await installAsyncMockModel(page, [{ text: 'busy', delayMs: 800 }])
await page.locator('textarea[class*="composerText"]').fill('busy request')
await page.keyboard.press('Enter')
await page.locator('text=正在生成…').waitFor({ state: 'visible', timeout: 10000 })
assert(await modeTrigger.isDisabled() && await modeTrigger.getAttribute('aria-expanded') === 'false', 'busy mode trigger is disabled and cannot open')
await page.locator('text=停止生成').click()
await page.waitForFunction(() => !document.querySelector('button[aria-label="切换对话模式"]')?.disabled, null, { timeout: 10000 })

await browser.close()
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((result) => result.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
