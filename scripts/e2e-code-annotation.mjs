// Code block selection + reload persistence e2e for the v1.3.0 release gate.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('dialog', d => { void d.accept() })

const conversation = {
  id: 'code-annotation-conversation',
  title: '代码标注测试',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    msg('code-user', 'user', '请解释这段代码'),
    msg('code-assistant', 'assistant', '```python\ndef test():\n    return True\n```'),
  ],
}

await seedAndBoot(page, { convs: [conversation], settings: { lastConversationId: conversation.id } })
const message = page.locator('[data-message-id="code-assistant"]').first()
await message.waitFor({ state: 'visible', timeout: 15000 })
assert(await message.locator('pre[data-block-type="code"][data-annotatable="true"]').count() === 1, 'code block is rendered as annotatable')

// Select the return expression through the same DOM Range path used by a real
// browser drag, then activate the existing text annotation bar.
await page.evaluate(() => {
  const span = document.querySelector('[data-message-id="code-assistant"] pre[data-block-type="code"] [data-canonical-start]')
  const text = span?.firstChild
  if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('code text node missing')
  const value = text.textContent || ''
  const start = value.indexOf('return True')
  if (start < 0) throw new Error('selection text missing')
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, start + 'return True'.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
})
const markButton = page.getByRole('button', { name: '标记', exact: true })
await markButton.waitFor({ state: 'visible', timeout: 5000 })
await markButton.click()

const readAnnotations = () => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader', 6)
  req.onerror = () => resolve([])
  req.onsuccess = () => {
    const db = req.result
    const get = db.transaction('annotations', 'readonly').objectStore('annotations').getAll()
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result || []) }
    get.onerror = () => resolve([])
  }
}))
const beforeReload = await readAnnotations()
assert(beforeReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === 'return True'), 'code selection creates a text annotation')

await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-message-id="code-assistant"]').first().waitFor({ state: 'visible', timeout: 15000 })
const afterReload = await readAnnotations()
assert(afterReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === 'return True'), 'code annotation persists after reload')

await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')
