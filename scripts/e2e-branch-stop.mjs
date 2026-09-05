import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { msg, seedAndBoot, createBranchFromMessage } from './e2e-fixture.mjs'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const MOCK = 'http://localhost:5298'

// A REAL local SSE mock server (not route.fulfill): streams staggered deltas, responds to abort.
const DELTAS = ['第一段', '第二段', '第三段']
let target = null
const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' }); res.end(); return }
  if (String(req.url).includes('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    let i = 0
    const writeNext = () => {
      if (res.destroyed || i >= DELTAS.length) { return }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: DELTAS[i] }, finish_reason: null }] }) + '\n\n')
      i++
      setTimeout(writeNext, 450)
    }
    writeNext()
    req.on('close', () => {})
  } else if (String(req.url).includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ data: [] })) }
  else { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(5298, () => r()))

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

const conv = { id: 's', title: '停止对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [
  msg('U1', 'user', '停问一'), msg('A1', 'assistant', '停答一'), msg('U2', 'user', '停问二'), msg('A2', 'assistant', '停答二'),
] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: MOCK, lastConversationId: 's' } })

// Enter Branch A.
await createBranchFromMessage(page, 0)
assert((await page.textContent('body')).includes('当前路线'), 'BranchBar visible after branching')

// Send a branch message -> generation starts streaming from the real SSE server.
await page.locator('textarea[class*="composerText"]').fill('分支停止测试')
await page.keyboard.press('Enter')
// Status bar should show 正在生成 + a real 停止生成 button (branch streaming now drives global status).
await page.locator('text=停止生成').waitFor({ state: 'visible', timeout: 8000 })
assert(true, '停止生成 button appears during branch streaming')
// Wait for the first delta to land, then record the partial assistant content (from the branch record).
await page.waitForTimeout(700)
const branchId = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result; const g = db.transaction('conversationBranches','readonly').objectStore('conversationBranches').getAll(); g.onsuccess = () => { try { db.close() } catch {}; resolve((g.result||[]).map(b => b.id)[0] || null) }; g.onerror = () => resolve(null) }
  req.onerror = () => resolve(null)
}))
const readAssistant = async () => page.evaluate((bid) => new Promise((resolve) => {
  const req = indexedDB.open('ai-education-reader', 5)
  req.onsuccess = () => { const db = req.result; const g = db.transaction('conversationBranches','readonly').objectStore('conversationBranches').get(bid); g.onsuccess = () => { try { db.close() } catch {}; const b = g.result; const a = (b?.messages||[]).find(m => m.role === 'assistant'); resolve(a ? a.content : '') }; g.onerror = () => resolve('') }
  req.onerror = () => resolve('')
}), branchId)
const partialBeforeStop = await readAssistant()
assert(partialBeforeStop.includes('第一段'), 'partial assistant content streamed (got ' + JSON.stringify(partialBeforeStop) + ')')

// Click the real 停止生成 button.
await page.locator('text=停止生成').click()
await page.waitForTimeout(2000) // wait well past the mock's remaining deltas
const partialAfterStop = await readAssistant()
assert(partialAfterStop === partialBeforeStop, 'assistant content did NOT grow after stop (' + JSON.stringify(partialAfterStop) + ')')
const stopBtnGone = await page.locator('text=停止生成').count()
assert(stopBtnGone === 0, '停止生成 button disappeared after stop (status returned to idle)')

// reload -> partial persists.
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
const partialAfterReload = await readAssistant()
assert(partialAfterReload === partialBeforeStop, 'partial assistant content persisted after reload (got ' + JSON.stringify(partialAfterReload) + ')')

// Main unaffected: switch to Main and confirm no branch partial there.
await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(700)
const mainBody = await page.textContent('body')
assert(!mainBody.includes('第一段'), 'Main does NOT contain the branch partial (无污染)')

server.close()
await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
