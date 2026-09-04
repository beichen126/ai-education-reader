// Branch-graph E2E: nested branch, canonical inherited-message branch, draft isolation.
import { chromium } from 'playwright-core'
import { msg, seedAndBoot, installMockModel, createBranchFromMessage, getLastRequestBody } from './e2e-fixture.mjs'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

const conv = { id: 'g', title: '图对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [
  msg('U1', 'user', '图问一'), msg('A1', 'assistant', '图答一'), msg('U2', 'user', '图问二'), msg('A2', 'assistant', '图答二'),
] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: 'g' } })
await installMockModel(page, ['A答'])

// ---- Nested branch ----
await createBranchFromMessage(page, 0) // Branch A from A1
await page.locator('textarea[class*="composerText"]').fill('A追问')
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.body.textContent.includes('A答'), null, { timeout: 15000 })
assert((await page.textContent('body')).includes('A追问'), 'branch A continuation (A追问) streamed in Branch A')

// Branch again from A答 (the branch-local assistant message, trigger index 1).
await installMockModel(page, ['B答'])
await createBranchFromMessage(page, 1) // Branch B from A答
await page.locator('textarea[class*="composerText"]').fill('B追问')
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.body.textContent.includes('B答'), null, { timeout: 15000 })
assert((await page.textContent('body')).includes('B追问'), 'Branch B continuation (B追问) streamed in Branch B')

// Nested effective path: Branch B shows inherited U1 A1 + A(追问/答) + B(追问/答).
const bBody = await page.textContent('body')
assert(bBody.includes('图答一') && bBody.includes('A追问') && bBody.includes('A答') && bBody.includes('B追问') && bBody.includes('B答'), 'Branch B effective path correct (inherited + A + B)')
assert(!bBody.includes('图问二'), 'Branch B excludes post-fork main messages (图问二 absent)')

// Switch to Main: only U1 A1 U2 A2.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(700)
const mainBody = await page.textContent('body')
assert(mainBody.includes('图问二') && mainBody.includes('图答二'), 'Main shows its own U2 A2')
assert(!mainBody.includes('A追问') && !mainBody.includes('B追问'), 'Main NOT polluted by A/B messages')

// Canonical inherited-message branch: from Branch B, branch on the INHERITED A1 (trigger index 0).
const showAB = async () => { await page.locator('button[aria-label="切换到主线"]').first().click(); await page.waitForTimeout(400) }
// Return to Branch B (open switcher, click the deepest branch).
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(500)
await page.locator('text=切换').first().click()
const branchItems = await page.locator('[role="menuitem"]').all()
const lastBranchBtn = branchItems[branchItems.length - 1]
if (lastBranchBtn) await lastBranchBtn.click()
await page.waitForTimeout(700)
// Branch on the inherited A1.
await page.locator('button[aria-label="消息操作"]').nth(0).click()
await page.locator('text=从这里分支').waitFor({ state: 'visible', timeout: 5000 })
await page.locator('text=从这里分支').click()
await page.waitForTimeout(700)
const branches = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result; const tx = db.transaction('conversationBranches','readonly'); const g = tx.objectStore('conversationBranches').getAll(); g.onsuccess = () => { try { db.close() } catch {}; resolve((g.result||[]).map(b => ({ title: b.title, parentBranchId: b.parentBranchId || null, fork: b.forkMessageId }))) }; g.onerror = () => resolve([]) }
  req.onerror = () => resolve([])
}))
const newBranch = branches.find(b => b.title === '分支 3')
assert(newBranch && newBranch.parentBranchId === null && newBranch.fork === 'A1', 'canonical inherited-message branch forks from ROOT (parent=null, fork=A1)')

// ---- Draft isolation ----
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(500)
await page.locator('textarea[class*="composerText"]').fill('主线草稿')
await page.waitForTimeout(300)
// Switch to Branch A.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(400)
await page.locator('text=切换').first().click()
await page.locator('[role="menuitem"]:has-text("分支 1")').first().click()
await page.waitForTimeout(400)
await page.locator('textarea[class*="composerText"]').fill('A草稿')
await page.waitForTimeout(300)
// Back to Main -> draft-main preserved.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(400)
const mainDraft = await page.locator('textarea[class*="composerText"]').inputValue()
assert(mainDraft === '主线草稿', 'Main draft preserved after visiting A (got ' + JSON.stringify(mainDraft) + ')')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
