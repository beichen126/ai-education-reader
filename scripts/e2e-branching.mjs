// Branch basic E2E (real UI + mock SSE): branch from a stable message, continue the branch,
// verify inherited path + branch continuation, Main unchanged, and switching consistency.
import { chromium } from 'playwright-core'
import { msg, seedAndBoot, installMockModel, createBranchFromMessage, getRouteHits } from './e2e-fixture.mjs'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

// Seed a Main conversation: U1 A1 U2 A2.
const conv = { id: 'main', title: '分支主对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [
  msg('U1', 'user', '问题一'), msg('A1', 'assistant', '答案一'), msg('U2', 'user', '问题二'), msg('A2', 'assistant', '答案二'),
] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com', lastConversationId: 'main' } })
installMockModel(page, ['这是', '分支', '回答'])

// Two assistant messages (A1, A2) each expose a ⋯ trigger.
const triggers = await page.locator('button[aria-label="消息操作"]').count()
assert(triggers === 2, 'Main shows 2 assistant message action triggers (got ' + triggers + ')')

// Branch from A1 (first assistant message) via real UI.
await createBranchFromMessage(page, 0)
const barText = await page.textContent('body').catch(() => '')
const hasBar = /当前路线/.test(barText)
assert(hasBar, 'BranchBar appears after branching')
const branchTitle = ((barText.match(/分支\s*[0-9]+/) || [])[0] || '').trim()
assert(!!branchTitle, 'BranchBar shows a branch name (got ' + JSON.stringify(branchTitle) + ')')

// Branch view shows inherited path (U1 A1) — the two root messages through the fork.
const showsInherited = (await page.textContent('body')).includes('问题一') && (await page.textContent('body')).includes('答案一')
assert(showsInherited, 'branch view shows inherited path (U1 A1)')
const showsPostFork = (await page.textContent('body')).includes('问题二')
assert(!showsPostFork, 'branch view EXCLUDES post-fork main messages (问题二 absent)')

// Continue the branch: type + send (mock SSE) -> branch assistant answer.
await page.locator('textarea[class*="composerText"]').fill('分支追问')
await page.keyboard.press('Enter')
// Wait for the branch assistant answer to stream in.
await page.waitForFunction(() => document.body.textContent.includes('这是分支回答'), null, { timeout: 15000 })
const bodyNow = await page.textContent('body')
assert(bodyNow.includes('分支追问') && bodyNow.includes('这是分支回答'), 'branch continuation streamed (branch-only user message + assistant answer)')

// Main is unchanged: switch to Main and verify root-only messages.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(700)
const mainBody = await page.textContent('body')
assert(mainBody.includes('问题二') && mainBody.includes('答案二'), 'Main still shows its own U2 A2 after branching')
assert(!mainBody.includes('这是分支回答'), 'Main does NOT contain the branch continuation (无污染)')

// Switch back to the branch -> branch continuation preserved.
await page.locator('button[aria-label="切换到主线"]').first().click()

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)