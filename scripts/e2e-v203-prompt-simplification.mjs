import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [{ id: 'v203-prompt', title: 'v2.0.3 Prompt 测试', createdAt: now, updatedAt: now, messages: [msg('v203-prompt-u1', 'user', '测试'), msg('v203-prompt-a1', 'assistant', '已完成测试回答')] }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'v203-prompt' },
})

const direct = page.locator('[data-testid="sidebar-entry-prompts"]')
if (await direct.isVisible().catch(() => false)) await direct.click()
else { await page.locator('[data-testid="rail-history"]').click(); await direct.click() }
const manager = page.locator('[data-testid="prompt-manager"]')
await manager.waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="prompt-row"]').first().waitFor({ state: 'visible', timeout: 10000 })

await page.locator('[data-testid="prompt-category-conversation-mode"]').click()
assert(await page.locator('[data-testid="prompt-row"]').count() === 1, 'conversation-mode browser catalog exposes only 默认')
assert((await page.locator('[data-testid="prompt-row"]').allTextContents()).join(' ').includes('默认'), 'default conversation mode remains visible')

await page.locator('[data-testid="prompt-category-artifact"]').click()
const artifactText = (await page.locator('[data-testid="prompt-row"]').allTextContents()).join(' ')
assert(await page.locator('[data-testid="prompt-row"]').count() === 2, 'artifact browser catalog exposes only note and quiz')
assert(!/总结|学习指南|自定义处理|自定义/.test(artifactText), 'legacy artifact kinds are absent from the new-create catalog')

await page.locator('[data-testid="prompt-category-all"]').click()
const allText = (await page.locator('[data-testid="prompt-row"]').allTextContents()).join(' ')
assert(!allText.includes('系统协议'), 'protocol definitions are hidden from the default all catalog')
await page.locator('[data-testid="prompt-category-protocol"]').click()
assert(await page.locator('[data-testid="prompt-row"]').count() > 0, 'protocol definitions remain available in their explicit category')
await page.locator('[data-testid="prompt-row"]').first().click()
assert(await page.locator('[data-testid="protocol-inspector"]').count() === 1, 'explicit protocol selection opens protocol detail')
await page.locator('[data-testid="prompt-category-all"]').click()
assert(await page.locator('[data-testid="protocol-inspector"]').count() === 0, 'leaving protocol category clears protocol detail')

await page.locator('[data-testid="prompt-manager-close"]').click()
const messageMenu = page.locator('button[aria-label="消息操作"]').first()
await messageMenu.waitFor({ state: 'visible', timeout: 10000 })
await messageMenu.click()
const artifactMenu = page.locator('[role="menu"][aria-label="消息操作"]')
assert(await artifactMenu.locator('button[role="menuitem"]').filter({ hasText: '整理成笔记' }).count() === 1 && await artifactMenu.locator('button[role="menuitem"]').filter({ hasText: '生成题目' }).count() === 1, 'message artifact actions expose Note and Quiz')
assert(await artifactMenu.locator('button[role="menuitem"]').filter({ hasText: '自定义处理' }).count() === 0, 'message artifact actions do not expose custom processing')
await artifactMenu.locator('button[role="menuitem"]').filter({ hasText: '整理成笔记' }).click()
const artifactDialog = page.locator('[role="dialog"][aria-label="创建学习成果"]')
await artifactDialog.waitFor({ state: 'visible', timeout: 10000 })
assert(await artifactDialog.locator('[role="radiogroup"][aria-label="类型"] [role="radio"]').count() === 2, 'create dialog exposes exactly two artifact types')
assert(await artifactDialog.locator('[data-testid="artifact-kind-custom"]').count() === 0, 'create dialog has no custom processing option')
await artifactDialog.getByRole('button', { name: '取消' }).click()

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter(line => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
