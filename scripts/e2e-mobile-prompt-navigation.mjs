// Stage 1 browser gate: mobile navigation, route mode context, inspectors,
// quick chips, keyboard CRUD, accessible names, focus restoration, and overflow.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel } from './e2e-fixture.mjs'

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
  { id: 'stage13-quick-explain', kind: 'quick-follow-up', name: '解释', description: '继续解释', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '解释', userPrompt: '请继续解释上一条回答', pinned: true, sortOrder: 1 },
  { id: 'stage13-quick-example', kind: 'quick-follow-up', name: '举例', description: '补一个例子', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '举例', userPrompt: '请补充一个具体例子', pinned: false, sortOrder: 2 },
  { id: 'stage13-quick-check', kind: 'quick-follow-up', name: '检查', description: '检查理解', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '检查', userPrompt: '请用一个问题检查我的理解', pinned: false, sortOrder: 3 },
  { id: 'stage13-quick-summary', kind: 'quick-follow-up', name: '总结', description: '提炼要点', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '总结', userPrompt: '请总结上一条回答的要点', pinned: false, sortOrder: 4 },
]

async function putPromptRows(page, rows) {
  await page.evaluate((values) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('prompts', 'readwrite')
      for (const value of values) tx.objectStore('prompts').put(value)
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  }), rows)
}

async function measureNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  assert(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, label + ' has no horizontal overflow')
}

async function visibleControlsHaveNames(root) {
  return root.evaluate((element) => {
    const visible = (node) => {
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }
    return [...element.querySelectorAll('input, textarea, select')].filter(visible).every((control) => {
      if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return true
      return control.labels && control.labels.length > 0
    })
  })
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
const dialogs = []
page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.accept() })

const now = Date.now()
const conversationId = 'stage13-mobile-a11y'
const conversation = {
  id: conversationId,
  title: 'Stage 13 移动端验收',
  createdAt: now,
  updatedAt: now,
  messages: [
    msg('stage13-u1', 'user', '第一个问题'),
    msg('stage13-a1', 'assistant', '第一个回答'),
    msg('stage13-u2', 'user', '第二个问题'),
    msg('stage13-a2', 'assistant', '第二个回答'),
  ],
  promptTransitions: [{
    id: 'stage13-transition', afterMessageId: 'stage13-a1', createdAt: now,
    snapshot: { kind: 'conversation-mode', profileId: 'stage13-mode', name: '记录模式', content: '完整的历史系统提示词不应出现在 Markdown 导出中。', revision: 1, source: 'custom', capturedAt: now },
  }],
}
await seedAndBoot(page, {
  convs: [conversation],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})
await putPromptRows(page, quickRows)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('textarea[aria-label="输入消息"]').waitFor({ state: 'attached', timeout: 20000 })
await installMockModel(page, ['移动端回答'])

let keyboardCrudDone = false
for (const size of [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  await page.setViewportSize(size)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('textarea[aria-label="输入消息"]').waitFor({ state: 'attached', timeout: 20000 })

  const rail = page.locator('[data-testid="rail-history"]')
  await rail.waitFor({ state: 'visible', timeout: 10000 })
  await rail.click()
  const nav = page.locator('[data-testid="mobile-history-drawer"]')
  await nav.waitFor({ state: 'visible', timeout: 5000 })
  assert(await nav.getAttribute('role') === 'navigation' && await nav.getAttribute('aria-label') === '主导航', size.width + 'px main navigation drawer has role/name')
  assert(await nav.locator('[data-testid="sidebar-entry-images"]').count() === 1 && await nav.locator('[data-testid="sidebar-entry-files"]').count() === 1 && await nav.locator('[data-testid="sidebar-entry-prompts"]').count() === 1, size.width + 'px drawer keeps direct access to image/file/prompt actions')
  await measureNoOverflow(page, size.width + 'px navigation')

  await nav.locator('[data-testid="sidebar-entry-prompts"]').click()
  const manager = page.locator('[data-testid="prompt-manager"]')
  await manager.waitFor({ state: 'visible', timeout: 10000 })
  assert(await manager.getAttribute('role') === 'dialog' && await manager.getAttribute('aria-label') === '提示词管理', size.width + 'px Prompt Manager has a named dialog')
  assert(await manager.getAttribute('data-mobile-step') === 'categories', size.width + 'px Prompt Manager opens at categories')
  await manager.locator('[data-testid="prompt-category-protocol"]').click()
  await manager.locator('[data-testid="prompt-row"]').first().waitFor({ state: 'visible', timeout: 10000 })
  assert(await manager.locator('[data-testid="prompt-category-protocol"]').getAttribute('aria-current') === 'page', size.width + 'px selected category is announced')
  const firstProtocol = manager.locator('[data-testid="prompt-row"]').first()
  await firstProtocol.click()
  await manager.locator('[data-testid="protocol-inspector"]').waitFor({ state: 'visible', timeout: 10000 })
  assert(await manager.getAttribute('data-mobile-step') === 'detail', size.width + 'px category -> list -> detail navigation works')
  assert((await manager.locator('[data-testid="prompt-editor-content"]').inputValue()).length > 0, size.width + 'px protocol inspector exposes complete prompt content')
  assert((await firstProtocol.getAttribute('data-source')) === 'builtin' && (await firstProtocol.innerText()).includes('内置'), size.width + 'px builtin source is textually announced')
  assert(await visibleControlsHaveNames(manager), size.width + 'px visible Prompt Manager form controls have labels')
  await measureNoOverflow(page, size.width + 'px Prompt Manager')

  if (!keyboardCrudDone) {
    const detailBack = manager.locator('main[aria-label="提示词详情"] > button').first()
    await detailBack.click()
    await manager.getByRole('button', { name: '‹ 分类' }).click()
    await manager.locator('[data-testid="prompt-category-artifact"]').click()
    const newButton = manager.locator('[data-testid="prompt-new"]')
    await newButton.focus()
    await newButton.press('Enter')
    await manager.locator('[data-testid="prompt-editor-name"]').fill('Stage 3 键盘成果')
    await manager.locator('[data-testid="prompt-editor-content"]').fill('键盘 CRUD 测试内容')
    const saveButton = manager.locator('[data-testid="prompt-save"]')
    await saveButton.focus()
    await saveButton.press('Enter')
    await manager.getByText('提示词已创建。', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    await manager.locator('main[aria-label="提示词详情"] > button').first().click()
    await manager.locator('[data-testid="prompt-search"]').fill('Stage 3 键盘成果')
    const customRow = manager.locator('[data-testid="prompt-row"]').filter({ hasText: 'Stage 3 键盘成果' })
    await customRow.waitFor({ state: 'visible', timeout: 10000 })
    assert((await customRow.getAttribute('data-source')) === 'custom' && (await customRow.innerText()).includes('自定义'), 'keyboard-created prompt is visibly marked custom')
    await customRow.click()
    const deleteButton = manager.locator('[data-testid="prompt-delete"]')
    await deleteButton.focus()
    await deleteButton.press('Enter')
    await waitFor(() => customRow.count().then((count) => count === 0), 10000)
    assert(await customRow.count() === 0, 'keyboard CRUD deletes the custom prompt')
    await page.keyboard.press('Escape')
    await waitFor(() => manager.count().then((count) => count === 0), 5000)
    assert(await page.locator('[data-testid="sidebar-entry-prompts"]').evaluate((el) => el === document.activeElement), 'Prompt Manager Escape restores focus to its opener')
    keyboardCrudDone = true
  } else {
    await page.keyboard.press('Escape')
    await waitFor(() => manager.count().then((count) => count === 0), 5000)
  }

  const drawer = page.locator('[data-testid="mobile-history-drawer"]')
  await drawer.locator('[data-testid="sidebar-collapse"]').click()
  const contextBar = page.locator('[role="navigation"][aria-label="会话上下文"]')
  await contextBar.waitFor({ state: 'visible', timeout: 10000 })
  assert(await contextBar.locator('[data-testid="conversation-context-row"]').count() === 2, size.width + 'px Context Bar keeps two semantic rows')
  const modeTrigger = page.locator('button[aria-label="切换对话模式"]')
  const expectedModeName = size.width === 375 ? '记录模式' : '默认'
  assert(await modeTrigger.count() === 1 && await page.locator('[data-testid="active-conversation-mode"]').innerText() === expectedModeName, size.width + 'px mobile context keeps the route snapshot and mode trigger')

  const transitionButton = page.locator('[data-testid="mode-transition-divider"] button').first()
  await transitionButton.waitFor({ state: 'visible', timeout: 10000 })
  await transitionButton.click()
  const inspector = page.locator('[role="dialog"]').filter({ has: page.locator('[data-testid="prompt-inspector"]') })
  await inspector.waitFor({ state: 'visible', timeout: 5000 })
  assert(await inspector.getAttribute('aria-label') === '提示词检查器' && (await inspector.locator('[data-testid="prompt-inspector-content"]').inputValue()).includes('历史系统提示词'), size.width + 'px conversation inspector has a named dialog and frozen prompt')
  await page.keyboard.press('Escape')
  await waitFor(() => transitionButton.evaluate((el) => el === document.activeElement), 5000)
  assert(await transitionButton.evaluate((el) => el === document.activeElement), size.width + 'px inspector Escape restores focus')

  await modeTrigger.click()
  const modeMenu = page.locator('[role="menu"][aria-label="模式"]')
  await modeMenu.waitFor({ state: 'visible', timeout: 5000 })
  assert(await modeMenu.getByRole('menuitemradio', { name: /默认/ }).count() === 1, size.width + 'px mode menu keeps the canonical default option')
  await page.keyboard.press('Escape')
  assert(await modeMenu.count() === 0, size.width + 'px mode Escape closes the menu')

  const quickBar = page.locator('[data-testid="quick-follow-up-bar"]')
  await quickBar.waitFor({ state: 'visible', timeout: 15000 })
  assert(await quickBar.locator('[data-testid="quick-follow-up-send"]').count() >= 2, size.width + 'px quick chips remain available')
  const quickInspect = quickBar.locator('[data-testid="quick-follow-up-inspect"]').first()
  await quickInspect.click()
  const quickDialog = page.locator('[data-testid="quick-follow-up-dialog"]')
  await quickDialog.waitFor({ state: 'visible', timeout: 5000 })
  assert(await quickDialog.getAttribute('role') === 'dialog' && await quickDialog.getAttribute('aria-labelledby') === 'quick-follow-up-dialog-title', size.width + 'px quick inspector has a named dialog')
  await page.keyboard.press('Escape')
  await waitFor(() => quickInspect.evaluate((el) => el === document.activeElement), 5000)
  assert(await quickInspect.evaluate((el) => el === document.activeElement), size.width + 'px quick inspector Escape restores focus')

  const composer = page.locator('textarea[aria-label="输入消息"]')
  const responseText = '移动端回答 ' + size.width
  await installMockModel(page, [responseText])
  await composer.fill('键盘发送 ' + size.width)
  await composer.press('Enter')
  await page.getByText(responseText, { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
  assert(true, size.width + 'px keyboard send completes the user -> model response chain')
  await measureNoOverflow(page, size.width + 'px conversation')
}

await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
