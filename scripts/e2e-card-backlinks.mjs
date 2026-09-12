// v2.2.0 Stage 7 browser gate: card <-> conversation <-> PDF backlinks, and 关于此页.
// Every jump is validated against real structure: nothing is guessed from titles, and a
// deleted source stays readable but is never faked.
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, openMessageActions } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'
import { openDocumentLibrary } from './e2e-navigation.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const fixture = 'test/.playwright/backlink.pdf'
const safe = async (fn, fallback = null) => { try { return await fn() } catch { return fallback } }

if (!existsSync(fixture)) {
  mkdirSync('test/.playwright', { recursive: true })
  const generated = spawnSync(process.execPath, ['scripts/make-outline-pdf.mjs', fixture, '12'], { stdio: 'inherit' })
  if (generated.status !== 0) throw new Error('failed to generate the backlink fixture')
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
await seedAndBoot(page, {
  convs: [
    { id: 'bl-chat', title: '回链会话', createdAt: now, updatedAt: now, messages: [msg('bl-u1', 'user', '先看这几页'), msg('bl-a1', 'assistant', '# 回链回答\n\n这是要被保存为卡片的回复。')] },
    { id: 'bl-other', title: '同名会话', createdAt: now - 1, updatedAt: now - 1, messages: [msg('bl-u2', 'user', '另一条'), msg('bl-a2', 'assistant', '另一条回答')] },
  ],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'bl-chat' },
})

// ---- import a real PDF and attach pages 3–5 to the conversation ----
await openDocumentLibrary(page)
await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(fixture)
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 60000 })
const documentId = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const rows = await new Promise((resolve, reject) => { const request = db.transaction('documents', 'readonly').objectStore('documents').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  db.close()
  return rows[0]?.id ?? null
})
assert(typeof documentId === 'string' && documentId.length > 0, 'the imported PDF is a real document row')

// Give the reply real PDF provenance (pages 3,4,5) exactly like a user context selection.
await page.evaluate(async ({ documentId }) => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const tx = db.transaction('conversations', 'readwrite')
  const store = tx.objectStore('conversations')
  const get = store.get('bl-chat')
  get.onsuccess = () => {
    const conversation = get.result
    conversation.messages[0].pdfContexts = [{ documentId, pageNumbers: [3, 4, 5], createdAt: Date.now() }]
    store.put(conversation)
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
  db.close()
}, { documentId })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })

// ---- save the reply as a card ----
await openMessageActions(page, 0)
await page.locator('[data-testid="message-action-save-card"]').click()
await page.waitForTimeout(700)
const cards = await openAppDb(page, { store: 'studyCards' })
assert(cards.length === 1 && cards[0].documentIds.length === 1, 'the saved card records the real document id')
assert(cards[0].documentRefs[0].pageNumbers.join('|') === '3|4|5', 'the card keeps the real page set')

// ---- 1. card -> exact conversation message ----
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="card-back-to-conversation"]').count() === 1, 'a live source offers 返回原会话')
await page.locator('[data-testid="card-back-to-conversation"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })
const exactMessage = page.locator('[data-message-id="bl-a1"]').first()
await exactMessage.waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-message-id="bl-a1"]').count() >= 1, 'returning to the source renders the exact assistant message')
assert(await page.locator('[data-message-id="bl-a2"]').count() === 0, 'the other conversation is not rendered instead')
const highlighted = await page.evaluate(() => {
  const element = document.querySelector('[data-message-id="bl-a1"]')
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.top < window.innerHeight && rect.bottom > 0
})
assert(highlighted, 'the exact message is scrolled into view')

// ---- 2. card -> exact PDF page ----
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="card-source-pdf-open"]').count() === 1, 'a live source PDF offers 打开第 N 页')
assert(await page.locator('[data-testid="card-source-pdf-page"]').count() === 3, 'non-contiguous-capable page chips are offered per real page')
await page.locator('[data-testid="card-source-pdf-open"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="learning-center"]').count() === 0, 'jumping to a PDF closes the learning centre so the page is visible')
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '3', 'the card opens the first real source page')
// A specific chip jumps to that exact page (close the Reader first: it covers the sidebar).
await page.locator('[data-testid="reader-close"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-source-pdf-page"][data-page="5"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '5', 'a page chip jumps to that exact page')
await page.locator('[data-testid="reader-close"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })

// ---- 3. Reader 关于此页 lists conversations AND cards, independently ----
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-source-pdf-open"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-related-toggle"]').click()
await page.locator('[data-testid="reader-related-cards-group"]').waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(900)
assert((await page.locator('[data-testid="reader-related-cards-group"]').innerText()).includes('（1）'), '关于此页 counts the card that really cites this page')
assert(await page.locator('[data-testid="reader-related-card"]').count() === 1, 'the card category lists the card')
assert(await page.locator('[data-testid="reader-related-conversations-group"]').count() === 1, 'the conversation category is a separate group')
assert((await page.locator('[data-testid="reader-related-conversations-group"]').innerText()).includes('（1）'), 'the conversation category counts the message that really cites this page')
assert(await page.locator('[data-testid="reader-related-item"]').count() >= 1, 'the conversation category lists its own hits')
// A page the card does not cite has no card hit.
await page.locator('[data-testid="reader-page-input"]').fill('9')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(1200)
assert(await page.locator('[data-testid="reader-related-card"]').count() === 0, 'a page the card does not cite shows no card hit')
assert((await page.locator('[data-testid="reader-related-cards-group"]').innerText()).includes('（0）'), 'the card count follows the current page')
await page.locator('[data-testid="reader-page-input"]').fill('4')
await page.locator('[data-testid="reader-page-input"]').press('Enter')
await page.waitForTimeout(1200)
await page.locator('[data-testid="reader-related-card"]').waitFor({ state: 'visible', timeout: 10000 })

// Card click opens the global card detail over the reader, and closing returns to the reader.
await page.locator('[data-testid="reader-related-card"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="learning-center"]').isVisible(), 'a Reader card hit opens the global learning centre')
assert(await page.locator('[data-testid="document-reader"]').count() === 1, 'the Reader stays open behind the learning centre')
await page.locator('[data-testid="card-back"]').click()
await page.locator('[data-testid="learning-center-close"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })
assert(await page.locator('[data-testid="document-reader"]').isVisible(), 'closing the learning centre returns to the Reader')
await page.locator('[data-testid="reader-close"]').click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })

// ---- 4. a deleted conversation keeps the card readable, but never fakes a backlink ----
await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const tx = db.transaction('conversations', 'readwrite')
  tx.objectStore('conversations').delete('bl-chat')
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
  db.close()
})
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="card-viewer"]').innerText()).includes('这是要被保存为卡片的回复'), 'the card body is still readable after its conversation is deleted')
assert(await page.locator('[data-testid="card-source-deleted"]').count() === 1, 'the deleted conversation is reported instead of faked')
assert(await page.locator('[data-testid="card-back-to-conversation"]').count() === 0, 'a deleted source offers no back link')
assert((await page.locator('[data-testid="card-source-conversation"]').innerText()) === '回链会话', 'the conversation title snapshot is preserved')
await page.locator('[data-testid="learning-center-close"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })

// ---- 5. a deleted document keeps the snapshot and disables the jump ----
await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const tx = db.transaction('documents', 'readwrite')
  const getAll = tx.objectStore('documents').getAll()
  getAll.onsuccess = () => { for (const row of getAll.result) tx.objectStore('documents').delete(row.id) }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
  db.close()
})
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="card-source-pdf-missing"]').count() === 1, 'a deleted PDF shows a snapshot marker')
assert(await page.locator('[data-testid="card-source-pdf-open"]').count() === 0, 'a deleted PDF offers no jump')
assert((await page.locator('[data-testid="card-sources"]').innerText()).includes('第 3–5 页'), 'the page snapshot survives deletion')
await page.locator('[data-testid="learning-center-close"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })

// ---- 6. the card still exists: deleting sources never deletes cards ----
assert((await openAppDb(page, { store: 'studyCards' })).length === 1, 'deleting the conversation and the PDF never deletes the card')

assert(errors.length === 0, 'backlinks produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
