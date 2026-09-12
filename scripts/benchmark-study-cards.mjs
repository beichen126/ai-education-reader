// v2.2.0 §12.3 performance telemetry (NON-BLOCKING numbers; the structural limits are
// asserted by the browser gates instead). Seeds 5000 cards straight into IndexedDB and
// measures the real user paths through the UI, from the driver's wall clock.
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const CARD_COUNT = Number(process.env.BENCH_CARDS || 5000)
const SAMPLES = Number(process.env.BENCH_SAMPLES || 7)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('dialog', dialog => { void dialog.accept() })
const errors = []
page.on('pageerror', error => errors.push('pageerror: ' + error.message))

const now = Date.now()
await seedAndBoot(page, {
  convs: [
    { id: 'bench-chat', title: '性能会话', createdAt: now, updatedAt: now, messages: [{ id: 'bench-u1', role: 'user', content: '问题', images: [], createdAt: now, updatedAt: now }, { id: 'bench-a1', role: 'assistant', content: '# 性能回答\n\n这是要保存的正文。', images: [], createdAt: now, updatedAt: now }] },
    { id: 'bench-other', title: '另一会话', createdAt: now, updatedAt: now, messages: [{ id: 'bench-u2', role: 'user', content: '问题二', images: [], createdAt: now, updatedAt: now }] },
  ],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'bench-chat' },
})

// Seed N validated cards (two documents so the PDF filter has real targets).
const seedMs = await page.evaluate(async ({ count }) => {
  const started = performance.now()
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['studyCards', 'studyCardPageRefs', 'documents'], 'readwrite')
    const cards = tx.objectStore('studyCards')
    const refs = tx.objectStore('studyCardPageRefs')
    const documents = tx.objectStore('documents')
    documents.put({ id: 'bench-doc-a', kind: 'pdf', fileName: '性能文档A.pdf', mimeType: 'application/pdf', fileSize: 1024, pageCount: 100, chapters: [], chapterSource: 'none', lastReadPage: 1, createdAt: 1, updatedAt: 1 })
    documents.put({ id: 'bench-doc-b', kind: 'pdf', fileName: '性能文档B.pdf', mimeType: 'application/pdf', fileSize: 1024, pageCount: 100, chapters: [], chapterSource: 'none', lastReadPage: 1, createdAt: 1, updatedAt: 1 })
    for (let index = 0; index < count; index++) {
      const withPdf = index % 2 === 0
      const documentId = index % 4 === 0 ? 'bench-doc-a' : 'bench-doc-b'
      const card = {
        schemaVersion: 1,
        id: 'bench-card-' + index,
        title: '性能卡片-' + index,
        titleMode: 'auto',
        autoTitleOrdinal: index + 1,
        bodyMarkdown: '# 标题 ' + index + '\n\n' + '正文内容用于搜索与摘要。'.repeat(8),
        source: { conversationId: 'bench-chat', assistantMessageId: 'bench-msg-' + index, conversationTitleSnapshot: '性能会话', capturedAt: 1 },
        documentRefs: withPdf ? [{ documentId, fileNameSnapshot: documentId === 'bench-doc-a' ? '性能文档A.pdf' : '性能文档B.pdf', pageNumbers: [1 + (index % 90)], relation: 'turn' }] : [],
        documentIds: withPdf ? [documentId] : [],
        createdAt: 1000 + index,
        updatedAt: 1000 + index,
      }
      cards.put(card)
      if (withPdf) refs.put({ id: documentId + ':' + card.documentRefs[0].pageNumbers[0] + ':' + card.id, documentId, pageNumber: card.documentRefs[0].pageNumbers[0], cardId: card.id })
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return Math.round(performance.now() - started)
}, { count: CARD_COUNT })

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { median: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] ?? 0 }
}
const measure = async fn => { const started = Date.now(); await fn(); return Date.now() - started }

// 1. first list load with CARD_COUNT cards (reopen the centre each sample).
const listLoads = []
for (let sample = 0; sample < Math.min(SAMPLES, 5); sample++) {
  listLoads.push(await measure(async () => {
    await page.locator('[data-testid="sidebar-entry-cards"]').click()
    await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('[data-testid="card-item"]').first().waitFor({ state: 'visible', timeout: 30000 })
  }))
  await page.locator('[data-testid="learning-center-close"]').click()
  await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })
}

// 2. one PDF filter (open the centre, then select the document filter repeatedly).
await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="card-item"]').first().waitFor({ state: 'visible', timeout: 30000 })
const filterValues = await page.locator('[data-testid="card-filter"] option').evaluateAll(options => options.map(option => option.value))
const documentFilter = filterValues.find(value => value.startsWith('document:'))
const filterTimes = []
for (let sample = 0; sample < SAMPLES; sample++) {
  filterTimes.push(await measure(async () => {
    await page.locator('[data-testid="card-filter"]').selectOption(sample % 2 === 0 ? documentFilter : 'all')
    await page.waitForTimeout(60)
  }))
}

// 3. search across 5000 cards.
const searchTimes = []
for (let sample = 0; sample < SAMPLES; sample++) {
  const needle = '标题 ' + (1000 + sample)
  searchTimes.push(await measure(async () => {
    await page.locator('[data-testid="card-search"]').fill(needle)
    // The list must actually narrow down (the seeded bodies are unique per card).
    await page.waitForFunction(() => {
      const titles = document.querySelectorAll('[data-testid="card-item-title"]')
      return titles.length > 0 && titles.length < 50
    }, null, { timeout: 20000 })
  }))
  const hits = await page.locator('[data-testid="card-item-title"]').allTextContents()
  if (sample === 0) console.log('BENCH search hits for "' + needle + '": ' + hits.slice(0, 3).join(', '))
}
await page.locator('[data-testid="card-search"]').fill('')
await page.waitForTimeout(400)

// 4. open one card (Markdown first content) and walk next/prev.
const detailTimes = []
for (let sample = 0; sample < SAMPLES; sample++) {
  await page.locator('[data-testid="card-item"]').nth(sample).click()
  await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('[data-testid="card-back"]').click()
  await page.waitForTimeout(120)
}
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 15000 })
const detailLoad = await measure(async () => {
  await page.locator('[data-testid="card-viewer"] h1').first().waitFor({ state: 'visible', timeout: 15000 })
})
const nextTimes = []
for (let sample = 0; sample < SAMPLES; sample++) {
  const before = await page.locator('[data-testid="card-position"]').innerText()
  nextTimes.push(await measure(async () => {
    await page.locator('[data-testid="card-next"]').click()
    await page.waitForFunction(previous => {
      const element = document.querySelector('[data-testid="card-position"]')
      return !!element && element.textContent !== previous
    }, before, { timeout: 15000 })
  }))
  if (sample === 0) console.log('BENCH card position moved from "' + before + '" to "' + (await page.locator('[data-testid="card-position"]').innerText()) + '"')
}
await page.locator('[data-testid="card-back"]').click()
await page.locator('[data-testid="learning-center-close"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })

// 5. save one card from the message menu (IndexedDB commit).
const saveTimes = []
for (let sample = 0; sample < 3; sample++) {
  await page.locator('button[aria-label="消息操作"]').first().click()
  await page.locator('[data-testid="message-action-save-card"]').click()
  saveTimes.push(await measure(async () => {
    await page.locator('[data-testid="card-save-status"]').waitFor({ state: 'visible', timeout: 15000 })
  }))
  await page.waitForTimeout(200)
}
void detailTimes

const report = {
  cards: CARD_COUNT,
  samples: SAMPLES,
  seedCardsMs: seedMs,
  listFirstLoadMs: stats(listLoads),
  pdfFilterMs: stats(filterTimes),
  searchMs: stats(searchTimes),
  cardDetailFirstContentMs: detailLoad,
  nextCardMs: stats(nextTimes),
  saveCardCommitMs: stats(saveTimes),
  pageErrors: errors,
}
console.log('BENCH ' + JSON.stringify(report))
await context.close()
await browser.close()
if (errors.length) process.exitCode = 1
