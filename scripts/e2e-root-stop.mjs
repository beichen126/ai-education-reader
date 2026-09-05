import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)
const MOCK = 'http://localhost:5297'
const DELTAS = ['甲段', '乙段', '丙段']
const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' }); res.end(); return }
  if (String(req.url).includes('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    let i = 0; const writeNext = () => { if (res.destroyed || i >= DELTAS.length) return; res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: DELTAS[i] }, finish_reason: null }] }) + '\n\n'); i++; setTimeout(writeNext, 450) }; writeNext()
  } else { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{}') }
})
await new Promise((r) => server.listen(5297, () => r()))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
const conv = { id: 'r', title: '根停止', createdAt: Date.now(), updatedAt: Date.now(), messages: [ msg('U1','user','根问'), msg('A1','assistant','根答') ] }
await seedAndBoot(page, { convs: [conv], settings: { apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: MOCK, lastConversationId: 'r' } })

// Send a MAIN (root) message -> streaming.
await page.locator('textarea[class*="composerText"]').fill('根追问')
await page.keyboard.press('Enter')
await page.locator('text=停止生成').waitFor({ state: 'visible', timeout: 8000 })
assert(true, 'root stop button appears during streaming')
// Wait for partial content to show in the UI (root renders progressively).
await page.waitForFunction(() => document.body.textContent.includes('甲段'), null, { timeout: 8000 })
const partialBefore = (await page.textContent('body')).match(/甲段[^乙]*/) || []
const partialText = (partialBefore[0] || '甲段').slice(0, 4)
await page.locator('text=停止生成').click()
await page.waitForTimeout(2200)
const bodyAfter = await page.textContent('body')
assert(!bodyAfter.includes('丙段'), 'root assistant content did NOT grow to the 3rd delta after stop')
const stopGone = await page.locator('text=停止生成').count()
assert(stopGone === 0, 'root stop button disappeared (status returned to idle)')
// reload -> partial persists.
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
const bodyReload = await page.textContent('body')
assert(bodyReload.includes('甲段'), 'root partial content persisted after reload')

server.close()
await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)
