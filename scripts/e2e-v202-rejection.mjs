import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, createBranchFromMessage, getRouteHits } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const waitForAlert = async (page, text) => {
  await page.locator('[role="alert"]').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 10000 })
}
const readBranchRows = (page) => page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => resolve([])
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('conversationBranches', 'readonly')
    const get = tx.objectStore('conversationBranches').getAll()
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result || []) }
    get.onerror = () => resolve([])
  }
}))

const now = Date.now()
const conversationId = 'v202-rejection'
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push('console.error: ' + message.text()) })

await seedAndBoot(page, {
  convs: [{ id: conversationId, title: 'v202 rejection', createdAt: now, updatedAt: now, messages: [
    msg('root-user', 'user', '主线问题'),
    msg('root-answer', 'assistant', '主线回答'),
  ] }],
  settings: { apiKey: '', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: conversationId },
})

// A valid catalog item lets the test exercise the real Quick Follow-up button;
// the rejection is caused by deleting its branch target between render and click.
await page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => reject(request.error || new Error('IDB open failed'))
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('prompts', 'readwrite')
    tx.objectStore('prompts').put({ id: 'v202-rejection-quick', kind: 'quick-follow-up', name: '继续', description: '', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, label: '继续', userPrompt: '请继续解释', pinned: false, sortOrder: 1 })
    tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
    tx.onerror = () => reject(tx.error || new Error('prompt seed failed'))
  }
}))
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="quick-follow-up-bar"]').waitFor({ state: 'visible', timeout: 10000 })
await installMockModel(page, ['分支重试成功'])

// Root and branch use the same no-key rejection policy and keep their drafts.
const rootComposer = page.locator('textarea[aria-label="输入消息"]')
await rootComposer.fill('root draft kept')
await rootComposer.press('Enter')
await waitForAlert(page, '未配置 API Key')
const rootNoKeyText = await page.locator('[role="alert"]').filter({ hasText: '未配置 API Key' }).first().innerText()
assert(await rootComposer.inputValue() === 'root draft kept', 'root no-key rejection keeps the composer draft')

await createBranchFromMessage(page, 0)
const branchComposer = page.locator('textarea[aria-label="输入消息"]')
await branchComposer.fill('branch no-key draft')
await branchComposer.press('Enter')
await waitForAlert(page, '未配置 API Key')
const branchNoKeyText = await page.locator('[role="alert"]').filter({ hasText: '未配置 API Key' }).first().innerText()
assert(branchNoKeyText === rootNoKeyText, 'root and branch no-key rejection use identical visible text')
assert(await branchComposer.inputValue() === 'branch no-key draft', 'branch no-key rejection keeps the composer draft')

// Save a key through the real Settings UI, keeping the branch and its draft alive.
await page.getByRole('button', { name: '打开设置' }).click()
const settings = page.getByRole('dialog', { name: '设置' })
await settings.locator('input').nth(1).fill('sk-test')
await settings.getByRole('button', { name: '保存', exact: true }).click()
await settings.getByRole('button', { name: '关闭' }).click()

// Force the next branch acceptance transaction to fail. This is a browser-only
// storage fault injection; the production path remains the real IDB transaction.
await page.evaluate(() => {
  const proto = IDBDatabase.prototype
  const original = proto.transaction
  let armed = true
  proto.transaction = function (names, mode, options) {
    const list = Array.isArray(names) ? names : [names]
    if (armed && mode === 'readwrite' && list.includes('conversationBranches') && list.includes('settings')) {
      armed = false
      throw new Error('forced acceptance failure')
    }
    return original.call(this, names, mode, options)
  }
})
await branchComposer.fill('branch acceptance draft')
await branchComposer.press('Enter')
await waitForAlert(page, 'forced acceptance failure')
assert(await branchComposer.inputValue() === 'branch acceptance draft', 'branch acceptance failure keeps the composer draft')
const rowsAfterAcceptanceFailure = await readBranchRows(page)
const activeAfterFailure = rowsAfterAcceptanceFailure.find((row) => row.conversationId === conversationId)
assert(activeAfterFailure?.messages.some((message) => message.content === 'branch acceptance draft') !== true, 'branch acceptance failure does not persist the user message')

// Empty input clears the matching rejection without leaving a status/error residue.
await branchComposer.fill('')
await branchComposer.press('Enter')
await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role="alert"]')).some((node) => node.textContent?.includes('forced acceptance failure')), null, { timeout: 5000 })
assert(await page.locator('[role="alert"]').filter({ hasText: 'forced acceptance failure' }).count() === 0, 'empty input clears the prior visible rejection')

// A successful retry accepts and streams normally, clearing any old send error.
await branchComposer.fill('successful retry')
await branchComposer.press('Enter')
await page.getByText('分支重试成功', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
assert(await page.locator('[role="alert"]').count() === 0, 'successful retry clears the old error banner')

// Delete the rendered branch target after the Quick Follow-up bar exists. Clicking
// the real button now exercises a branch rejection with no request/message growth.
const beforeQuickRequests = getRouteHits().completions
await page.evaluate((id) => new Promise((resolve) => {
  const request = indexedDB.open('ai-education-reader')
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction('conversationBranches', 'readwrite')
    tx.objectStore('conversationBranches').delete(id)
    tx.oncomplete = () => { try { db.close() } catch {}; resolve(true) }
    tx.onerror = () => resolve(false)
  }
  request.onerror = () => resolve(false)
}), (await readBranchRows(page)).find((row) => row.conversationId === conversationId)?.id)
await page.locator('[data-testid="quick-follow-up-send"]').first().click()
await waitForAlert(page, '当前分支不存在')
assert(getRouteHits().completions === beforeQuickRequests, 'rejected branch Quick Follow-up makes no model request')
const afterQuickRows = await readBranchRows(page)
assert(afterQuickRows.length === 0, 'rejected branch Quick Follow-up does not resurrect the deleted branch or add a message')

// The branch-target error is not leaked when switching back to Main.
await page.getByRole('button', { name: '切换到主线' }).click()
await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role="alert"]')).some((node) => node.textContent?.includes('当前分支不存在')), null, { timeout: 5000 })
assert(await page.locator('[role="alert"]').filter({ hasText: '当前分支不存在' }).count() === 0, 'branch-target error is hidden after switching to Main')

await context.close()
await browser.close()
for (const line of results) console.log(line)
console.log('PAGEERRORS: ' + (errors.length ? errors.join(' | ') : '(none)'))
const passed = results.filter((line) => line.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
