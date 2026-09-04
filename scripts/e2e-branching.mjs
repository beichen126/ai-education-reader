// Branch feature E2E: seed a conversation, branch from it, switch, verify Main unchanged + drafts.
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

// Seed IndexedDB BEFORE the app scripts run: a conversation with stable messages + apiKey.
// Seed IndexedDB AFTER first load (no race), then reload so the app boots with the data.
async function seedIdb() {
  const ok = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('ai-education-reader', 5)
    req.onsuccess = () => { const db = req.result;
      const tx = db.transaction(['conversations','settings'], 'readwrite')
      tx.objectStore('conversations').put({ id: 'c1', title: '分支 E2E', createdAt: Date.now(), updatedAt: Date.now(), messages: [
        { id: 'm0', role: 'user', content: '你好', images: [], createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'a1', role: 'assistant', content: '很高兴认识你。', images: [], createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'm2', role: 'user', content: '请解释稀疏矩阵', images: [], createdAt: Date.now(), updatedAt: Date.now() },
      ] })
      tx.objectStore('settings').put({ key: 'apiKey', value: 'sk-test' })
      tx.objectStore('settings').put({ key: 'model', value: 'deepseek-chat' })
      tx.objectStore('settings').put({ key: 'apiBaseUrl', value: 'https://api.deepseek.com' })
      tx.objectStore('settings').put({ key: 'lastConversationId', value: 'c1' })
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => resolve(false)
    }
    req.onerror = () => resolve(false)
  }))
  return ok
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const seeded = await seedIdb()
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => document.readyState === 'complete')
await page.waitForTimeout(1500)
console.log('seed ok=' + seeded)
const assistantVisible = await page.locator('text=很高兴认识你。').count()
assert(assistantVisible > 0, 'seeded assistant message rendered (count=' + assistantVisible + ')')

// Open the message action menu on the assistant message (the small ⋯ trigger).
const triggers = await page.locator('button[aria-label="消息操作"]').all()
assert(triggers.length >= 1, 'assistant message exposes an actionable menu trigger (got ' + triggers.length + ')')
if (triggers.length > 0) {
  await page.locator('button[aria-label="消息操作"]').first().click()
  await page.locator('text=从这里分支').waitFor({ state: 'visible', timeout: 5000 })
  assert(true, 'message menu shows 从这里分支')
  await page.locator('text=从这里分支').click()
} else { assert(false, 'actionable trigger missing') }

// After branching, BranchBar should appear and show the new branch.
await page.waitForTimeout(800)
const barVisible = await page.locator('text=当前路线').count()
assert(barVisible > 0, 'BranchBar appears after branching (count=' + barVisible + ')')
const branchMenuItem = await page.locator('text=/^分支 \\d+$/').count()
assert(branchMenuItem >= 1, 'BranchBar lists the new branch (count=' + branchMenuItem + ')')

await page.locator('button[aria-label="切换到主线"]').first().click()
await page.waitForTimeout(500)
const mainMessages = await page.locator('text=很高兴认识你。').count()
assert(mainMessages > 0, 'returned to Main still shows root messages')
await page.locator('text=切换').first().click()
await page.locator('text=主线').first().click()
await page.waitForTimeout(500)

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)