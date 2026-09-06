// Stage 2B browser acceptance:
//   existing message -> exact PDF source page
//   current PDF page -> related message -> exact conversation message
// The fixture seeds one canonical multi-document message after importing two real PDFs.
import { launchBrowser } from './e2e-browser.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF_A = 'test/fixtures/outline-sample.pdf'
const PDF_B = 'test/fixtures/outline-tricky.pdf'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message))
page.on('dialog', (dialog) => { void dialog.accept() })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })

const openLibrary = async () => {
  if (await page.locator('[data-testid="document-library"]').count()) return
  await page.locator('[data-testid="sidebar-entry-files"]').click()
  await page.locator('[data-testid="document-library"]').waitFor({ state: 'visible', timeout: 10000 })
}
const importAndOpen = async (file) => {
  await openLibrary()
  await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles(file)
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
}
const closeReader = async () => {
  await page.locator('[data-testid="reader-close"]').click()
  await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
}

await importAndOpen(PDF_A)
await closeReader()
await importAndOpen(PDF_B)
await closeReader()

const seeded = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader', 6)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const readAll = (store) => new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const settings = await readAll('settings')
  const documents = await readAll('documents')
  const last = settings.find((row) => row.key === 'lastConversationId')?.value
  const conversations = await readAll('conversations')
  const conversation = conversations.find((row) => row.id === last) || conversations[0]
  if (!conversation || documents.length < 2) throw new Error('seed prerequisites missing')
  const [documentA, documentB] = documents
  const messageId = 'stage2b-message-multi-document'
  const message = {
    id: messageId,
    role: 'user',
    content: 'Stage 2B multi-document history message',
    images: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pdfContexts: [
      { documentId: documentA.id, pageNumbers: [3, 4], createdAt: Date.now() },
      { documentId: documentB.id, pageNumbers: [3], createdAt: Date.now() },
    ],
  }
  const updated = { ...conversation, title: 'Stage 2B provenance', updatedAt: Date.now(), messages: [...conversation.messages, message] }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['conversations', 'settings'], 'readwrite')
    tx.objectStore('conversations').put(updated)
    tx.objectStore('settings').put({ key: 'lastConversationId', value: conversation.id })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('seed transaction aborted'))
  })
  db.close()
  return { conversationId: conversation.id, messageId, documentA: { id: documentA.id, fileName: documentA.fileName }, documentB: { id: documentB.id, fileName: documentB.fileName } }
})

await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const message = page.locator(`[data-message-id="${seeded.messageId}"]`)
await message.waitFor({ state: 'visible', timeout: 20000 })
const sources = message.locator('[data-testid="message-pdf-source"]')
assert(await sources.count() === 2, 'A: multi-document message exposes both PDF source buttons')

// Direction A: message -> first PDF source -> exact document/page.
await sources.nth(0).click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes(seeded.documentA.fileName), 'A: message source opens document A')
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '3', 'A: message source opens document A page 3')
await closeReader()

// Direction B1: document A page 3 -> related message -> exact target message.
await page.locator(`[data-message-id="${seeded.messageId}"]`).waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="message-pdf-source"]').nth(0).click()
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
await page.locator('[data-testid="reader-related-toggle"]').waitFor({ state: 'visible', timeout: 15000 })
assert((await page.locator('[data-testid="reader-related-toggle"]').textContent()).includes('1'), 'B1: document A page 3 shows one related message')
await page.locator('[data-testid="reader-related-toggle"]').click()
await page.locator('[data-testid="reader-related-item"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="reader-related-item"]').first().textContent()).includes('Stage 2B provenance'), 'B1: related result identifies the conversation')
await page.locator('[data-testid="reader-related-item"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
await message.waitFor({ state: 'visible', timeout: 10000 })
const messageBoxA = await message.boundingBox()
assert(!!messageBoxA && messageBoxA.y < 800 && messageBoxA.y + messageBoxA.height > 0, 'B1: related result returns to the exact message in the viewport')

// Direction B2: second PDF source -> document B page 3 -> same message.
await page.locator(`[data-message-id="${seeded.messageId}"] [data-testid="message-pdf-source"]`).nth(1).click()
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert((await page.locator('[data-testid="reader-title"]').textContent()).includes(seeded.documentB.fileName), 'B2: second source opens document B')
assert((await page.locator('[data-testid="reader-page-input"]').inputValue()).trim() === '3', 'B2: second source opens document B page 3')
await page.locator('[data-testid="reader-related-toggle"]').waitFor({ state: 'visible', timeout: 15000 })
await page.locator('[data-testid="reader-related-toggle"]').click()
await page.locator('[data-testid="reader-related-item"]').first().click()
await page.locator('[data-testid="document-reader"]').waitFor({ state: 'detached', timeout: 10000 })
await message.waitFor({ state: 'visible', timeout: 10000 })
const messageBoxB = await message.boundingBox()
assert(!!messageBoxB && messageBoxB.y < 800 && messageBoxB.y + messageBoxB.height > 0, 'B2: document B related result returns to the same exact message')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter((result) => result.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length && errors.length === 0 ? 0 : 1)
