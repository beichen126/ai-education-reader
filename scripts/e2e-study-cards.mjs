// v2.2.0 Stage 5 browser gate: the message menu and saving one completed reply as a card.
// No model call, no prompt, no whole-conversation snapshot — and the same reply never
// becomes two cards.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getRouteHits, openMessageActions } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'

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

const REPLY = '# 特征值\n\n矩阵 A 的特征值满足 det(A-λI)=0。'
const now = Date.now()
await seedAndBoot(page, {
  convs: [{
    id: 'cards-chat', title: '线性代数复习', createdAt: now, updatedAt: now,
    messages: [
      msg('c-u1', 'user', '讲讲特征值'),
      msg('c-a1', 'assistant', REPLY),
      { ...msg('c-u2', 'user', '失败的一轮'), createdAt: now, updatedAt: now },
      { ...msg('c-a2', 'assistant', '失败内容'), status: 'failed', error: 'boom', createdAt: now, updatedAt: now },
      { ...msg('c-u3', 'user', '空的一轮'), createdAt: now, updatedAt: now },
      { ...msg('c-a3', 'assistant', '   '), createdAt: now, updatedAt: now },
    ],
  }],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'cards-chat' },
})

// ---- 1. menu structure ----
await openMessageActions(page, 0)
const menu = page.locator('[data-testid="message-action-menu"]')
await menu.waitFor({ state: 'visible', timeout: 10000 })
const firstLevel = await menu.locator('> button[role="menuitem"]').allTextContents()
assert(firstLevel.length === 3, 'the message menu has exactly three first-level entries (got ' + firstLevel.length + ')')
assert(firstLevel[0].includes('从这里分支'), 'entry 1 is 从这里分支')
assert(firstLevel[1].includes('开启特殊分支'), 'entry 2 is 开启特殊分支')
assert(firstLevel[2].includes('保存本轮回复为学习卡片'), 'entry 3 is 保存本轮回复为学习卡片')
assert(await page.locator('[data-testid="message-action-special-menu"]').count() === 0, 'the special-branch submenu stays closed until asked for')
await page.locator('[data-testid="message-action-special"]').click()
const special = page.locator('[data-testid="message-action-special-menu"]')
await special.waitFor({ state: 'visible', timeout: 5000 })
const specialLabels = await special.locator('button[role="menuitem"]').allTextContents()
assert(specialLabels.map(text => text.trim()).join('|') === '整理成笔记|生成题目|自定义提示词…', 'the submenu is 整理成笔记 / 生成题目 / 自定义提示词… (got ' + specialLabels.join('|') + ')')
assert(await page.locator('[data-testid="message-action-special"]').getAttribute('aria-haspopup') === 'menu', 'the special-branch entry is a real menu parent')
assert(await page.locator('[data-testid="message-action-special"]').getAttribute('aria-expanded') === 'true', 'the special-branch entry reports its expanded state')

// ---- 2. keyboard: Arrow opens the submenu, Escape closes one level at a time ----
await page.locator('[data-testid="message-action-special"]').focus()
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(120)
assert(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'message-action-note', 'ArrowRight opens the submenu and focuses its first item')
await page.keyboard.press('Escape')
await page.waitForTimeout(120)
assert(await page.locator('[data-testid="message-action-special-menu"]').count() === 0, 'Escape closes only the submenu first')
assert(await page.locator('[data-testid="message-action-menu"]').count() === 1, 'the parent menu survives the first Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(120)
assert(await page.locator('[data-testid="message-action-menu"]').count() === 0, 'the second Escape closes the menu')

// ---- 3. custom prompt entry confirms the result format ----
await openMessageActions(page, 0)
await page.locator('[data-testid="message-action-special"]').click()
await page.locator('[data-testid="message-action-custom"]').click()
const dialog = page.locator('[role="dialog"][aria-label="创建学习成果"]')
await dialog.waitFor({ state: 'visible', timeout: 10000 })
assert(await dialog.locator('[data-testid="artifact-custom-format-hint"]').count() === 1, '自定义提示词 asks for the result format before generating')
assert(await dialog.locator('[role="radiogroup"][aria-label="类型"] [role="radio"]').count() === 2, 'only Markdown (笔记) and Quiz (题目) are offered')
assert(await dialog.locator('[data-testid="artifact-kind-note"]').getAttribute('aria-checked') === 'true', 'the format choice is explicit in the dialog')
await page.keyboard.press('Escape')
await dialog.waitFor({ state: 'detached', timeout: 10000 })

// ---- 4. save one completed reply: no network, exact body, status ----
const before = getRouteHits().completions
await safe(async () => { await openMessageActions(page, 0); return true })
await page.locator('[data-testid="message-action-save-card"]').click()
await page.locator('[data-testid="card-save-status"]').waitFor({ state: 'visible', timeout: 10000 })
assert(getRouteHits().completions === before, 'saving a card makes ZERO model requests')
assert((await page.locator('[data-testid="card-save-status"]').innerText()).includes('已保存为学习卡片'), 'a non-blocking status reports the save')

const cards = await openAppDb(page, { store: 'studyCards' })
assert(cards.length === 1, 'exactly one card row exists (got ' + cards.length + ')')
assert(cards[0].bodyMarkdown === REPLY, 'the card body is exactly the assistant reply')
assert(cards[0].source.assistantMessageId === 'c-a1', 'the card records the exact assistant message')
assert(cards[0].source.userMessageId === 'c-u1', 'the card records the user turn it answers')
assert(cards[0].title === '线性代数复习-1', 'the auto title uses the conversation name and ordinal (got ' + cards[0].title + ')')
assert(!cards[0].bodyMarkdown.includes('讲讲特征值'), 'the card never copies the whole conversation')
assert(cards[0].source.branchId === undefined, 'a root reply records no branch id')

// ---- 5. the menu now offers to view the saved card, and never duplicates it ----
await openMessageActions(page, 0)
const saveButton = page.locator('[data-testid="message-action-save-card"]')
assert((await saveButton.innerText()).includes('查看已保存卡片'), 'a saved reply offers 查看已保存卡片 instead of creating a duplicate')
assert(await saveButton.getAttribute('data-card-state') === 'saved', 'the button reflects the saved state')
await saveButton.click()
await page.waitForTimeout(600)
assert((await openAppDb(page, { store: 'studyCards' })).length === 1, 're-opening the saved card never creates a second one')

// ---- 6. streaming / failed / empty replies cannot be saved ----
for (const index of [1, 2]) {
  const menuAvailable = await safe(async () => { await openMessageActions(page, index); return true }, false)
  assert(menuAvailable === false, 'a failed/empty assistant reply exposes no message menu (index ' + index + ')')
}
await page.waitForTimeout(200)

// ---- 7. saving works without an API key and the composer draft is untouched ----
const composer = page.locator('textarea[aria-label="输入消息"]')
await composer.fill('未发送的草稿')
await openMessageActions(page, 0)
await page.locator('[data-testid="message-action-save-card"]').click()
await page.waitForTimeout(600)
assert(await composer.inputValue() === '未发送的草稿', 'saving a card never clears the composer draft')
assert((await openAppDb(page, { store: 'studyCards' })).length === 1, 'saving without an API key still creates exactly one card')

// ---- 8. a branch reply records the real branch ----
// The no-key steps above proved saving needs no API key; branching needs one to send.
await openAppDb(page, { store: 'settings', operation: 'put', value: { key: 'apiKey', value: 'sk-test' } })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await safe(async () => {
  const guide = page.locator('[data-testid="product-guide"]')
  if (await guide.isVisible().catch(() => false)) { await page.locator('[data-testid="product-guide-later"]').click(); await guide.waitFor({ state: 'hidden', timeout: 10000 }) }
  return true
})
await installMockModel(page, ['分支回答正文'])
await openMessageActions(page, 0)
await page.locator('[data-testid="message-action-branch"]').click()
await page.waitForTimeout(700)
const composerBranch = page.locator('textarea[aria-label="输入消息"]')
await composerBranch.fill('分支提问')
await composerBranch.press('Enter')
const branchMenuAppeared = await safe(async () => {
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label="消息操作"]').length >= 2, null, { timeout: 20000 })
  return true
}, false)
assert(branchMenuAppeared === true, 'the branch reply exposes its own message menu')
if (branchMenuAppeared) {
  const branchMenus = await page.locator('button[aria-label="消息操作"]').count()
  await openMessageActions(page, branchMenus - 1)
  await page.locator('[data-testid="message-action-save-card"]').click()
  await page.waitForTimeout(800)
  const afterBranch = await openAppDb(page, { store: 'studyCards' })
  assert(afterBranch.length === 2, 'the branch reply becomes a second card (got ' + afterBranch.length + ')')
  const branchCard = afterBranch.find(card => card.bodyMarkdown === '分支回答正文')
  assert(!!branchCard, 'the branch card body is the branch reply')
  assert(!!branchCard && typeof branchCard.source.branchId === 'string' && branchCard.source.branchId.length > 0, 'a branch reply records its real branch id, never root')
}

assert(errors.length === 0, 'card saving produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
