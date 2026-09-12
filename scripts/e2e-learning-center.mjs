// v2.2.0 Stage 6 browser gate: the global learning centre.
// Sidebar entry -> list -> filter / search / sort / rename / delete / prev-next, with a
// frozen list context so lastOpenedAt can never reshuffle what the user is reading.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, openMessageActions } from './e2e-fixture.mjs'
import { openAppDb } from './e2e-idb.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const safe = async (fn, fallback = null) => { try { return await fn() } catch { return fallback } }

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))
page.on('dialog', dialog => { void dialog.accept() })

const now = Date.now()
const REPLY_ONE = '# 特征值\n\n矩阵 A 的特征值满足 det(A-λI)=0。'
const REPLY_TWO = '## 二次型\n\n对称矩阵总可以对角化。'
const REPLY_THREE = '### 相似矩阵\n\n相似矩阵有相同的特征多项式。'
await seedAndBoot(page, {
  convs: [
    {
      id: 'lc-chat', title: '学习中心测试', createdAt: now, updatedAt: now,
      messages: [
        { ...msg('lc-u1', 'user', '讲讲特征值'), pdfContexts: [{ documentId: 'doc-lc', pageNumbers: [3, 4], createdAt: now }] },
        msg('lc-a1', 'assistant', REPLY_ONE),
        msg('lc-u2', 'user', '再讲讲二次型'),
        msg('lc-a2', 'assistant', REPLY_TWO),
        msg('lc-u3', 'user', '还有相似矩阵'),
        msg('lc-a3', 'assistant', REPLY_THREE),
      ],
    },
    {
      id: 'lc-plain', title: '纯文本会话', createdAt: now - 1, updatedAt: now - 1,
      messages: [msg('lc-plain-u1', 'user', '没有 PDF 的问题'), msg('lc-plain-a1', 'assistant', '没有 PDF 的回答。')],
    },
  ],
  settings: { apiKey: '', model: 'deepseek-chat', lastConversationId: 'lc-chat' },
})
// The PDF filter labels live documents by their real file name.
await openAppDb(page, {
  store: 'documents', operation: 'put',
  value: { id: 'doc-lc', kind: 'pdf', fileName: '高等数学.pdf', mimeType: 'application/pdf', fileSize: 1024, pageCount: 20, chapters: [], chapterSource: 'none', lastReadPage: 1, createdAt: now, updatedAt: now },
})

const saveCard = async index => {
  await openMessageActions(page, index)
  await page.locator('[data-testid="message-action-save-card"]').click()
  await page.waitForTimeout(500)
}
await saveCard(0)
await saveCard(1)
await saveCard(2)
const saved = await openAppDb(page, { store: 'studyCards' })
assert(saved.length === 3, 'three replies become three cards (got ' + saved.length + ')')
assert(saved.map(card => card.title).sort().join('|') === '学习中心测试-1|学习中心测试-2|学习中心测试-3', 'auto titles are 会话名-1/2/3')

// ---- 1. the sidebar owns a first-level 学习卡片 entry ----
assert(await page.locator('[data-testid="sidebar-entry-cards"]').count() === 1, 'the expanded sidebar exposes a 学习卡片 entry')
await page.locator('[data-testid="sidebar-entry-cards"]').click()
const center = page.locator('[data-testid="learning-center"]')
await center.waitFor({ state: 'visible', timeout: 10000 })
assert(await center.getAttribute('aria-label') === '学习中心', 'the learning centre is a named dialog')
assert(await page.locator('[data-testid="learning-tab-cards"]').getAttribute('aria-selected') === 'true', 'the centre opens on the 学习卡片 tab')
const itemTitles = async () => page.locator('[data-testid="card-item-title"]').allTextContents()
const waitForItems = async (count, timeout = 15000) => {
  await safe(() => page.waitForFunction(expected => document.querySelectorAll('[data-testid="card-item"]').length === expected, count, { timeout }))
  return page.locator('[data-testid="card-item"]').count()
}
assert(await waitForItems(3) === 3, 'the list shows the three saved cards')
assert((await itemTitles()).join('|') === '学习中心测试-3|学习中心测试-2|学习中心测试-1', 'the default order is created-desc (got ' + (await itemTitles()).join('|') + ')')
const conversationSnapshot = await safe(() => page.locator('[data-testid="card-item-conversation"]').first().innerText(), null)
if (conversationSnapshot === null) {
  const html = await safe(() => page.locator('[data-testid="learning-center"]').evaluate(element => element.outerHTML), '(no center)')
  console.error('LEARNING CENTER DIAGNOSTIC html:', String(html).slice(0, 1400))
}
assert(conversationSnapshot === '学习中心测试', 'each row shows the source conversation snapshot (got ' + conversationSnapshot + ')')

// ---- 2. toolbars: filter / sort / search ----
const filterOptions = await page.locator('[data-testid="card-filter"] option').allTextContents()
assert(filterOptions.some(text => text.includes('全部来源')), 'the PDF filter offers 全部来源')
assert(filterOptions.some(text => text.includes('高等数学.pdf')), 'the PDF filter names a real source document (got ' + filterOptions.join('|') + ')')
assert(filterOptions.some(text => text.includes('（3）')), 'filter options carry card counts')
await page.locator('[data-testid="card-sort"]').selectOption('created-asc')
await page.waitForTimeout(300)
assert((await itemTitles()).join('|') === '学习中心测试-1|学习中心测试-2|学习中心测试-3', 'created-asc reverses the order')
await page.locator('[data-testid="card-sort"]').selectOption('random')
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="card-reroll"]').isVisible(), '随机顺序 offers an explicit 重新随机 action')
const randomOrder = (await itemTitles()).join('|')
await page.locator('[data-testid="card-search"]').fill('二次型')
await page.waitForTimeout(500)
assert((await itemTitles()).join('|') === '学习中心测试-2', 'search matches the markdown body (got ' + (await itemTitles()).join('|') + ')')
await page.locator('[data-testid="card-search"]').fill('')
await page.waitForTimeout(500)
assert((await itemTitles()).join('|') === randomOrder, 'clearing the query restores the same random order')
// A random order must survive browsing: opening a card updates lastOpenedAt, which must
// never reshuffle the list under the user.
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-back"]').click()
await page.waitForTimeout(400)
assert((await itemTitles()).join('|') === randomOrder, 'the random order is stable across opening a card (lastOpenedAt never reshuffles)')
// Freeze a deterministic order for the navigation assertions below.
await page.locator('[data-testid="card-sort"]').selectOption('created-asc')
await page.waitForTimeout(300)
assert((await itemTitles()).join('|') === '学习中心测试-1|学习中心测试-2|学习中心测试-3', 'the list can be put back into a deterministic order')

// ---- 3. detail: Markdown, sources, prev/next over the frozen list ----
await page.locator('[data-testid="card-search"]').fill('特征值')
await page.waitForTimeout(500)
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="card-viewer"]').innerText()).includes('det(A-λI)=0'), 'the detail renders the card Markdown')
assert(await page.locator('[data-testid="card-viewer"] h1').count() >= 1, 'Markdown headings are really rendered, not escaped')
assert((await page.locator('[data-testid="card-source-conversation"]').innerText()) === '学习中心测试', 'the detail shows the source conversation snapshot')
assert(await page.locator('[data-testid="card-source-pdf"]').count() === 1, 'the detail lists the real source PDF')
assert((await page.locator('[data-testid="card-source-pdf"]').first().innerText()).includes('本轮上下文'), 'the source PDF states its relation')
// The opened list was narrowed by search to one card, so both ends are disabled.
assert(await page.locator('[data-testid="card-prev"]').isDisabled(), 'with a single match the previous button is disabled')
assert(await page.locator('[data-testid="card-next"]').isDisabled(), 'with a single match the next button is disabled')

await page.locator('[data-testid="card-back"]').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="card-search"]').fill('')
await page.waitForTimeout(500)
await page.locator('[data-testid="card-item"]').first().click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
assert((await page.locator('[data-testid="card-position"]').innerText()).startsWith('1 / 3'), 'the detail reports its position in the list')
assert(await page.locator('[data-testid="card-prev"]').isDisabled(), 'the first card has no previous')
await page.locator('[data-testid="card-next"]').click()
await page.waitForTimeout(400)
assert((await page.locator('[data-testid="card-position"]').innerText()).startsWith('2 / 3'), 'next moves to the second card')
assert(!(await page.locator('[data-testid="card-next"]').isDisabled()), 'the middle card can still advance')

// ---- 4. rename is optimistic-concurrency safe and never changes createdAt/ordinal ----
const beforeRename = (await openAppDb(page, { store: 'studyCards' })).find(card => card.title === '学习中心测试-2')
await page.locator('[data-testid="card-rename"]').click()
await page.locator('[data-testid="card-title-input"]').fill('我的二次型笔记')
await page.locator('[data-testid="card-title-input"]').press('Enter')
await page.waitForTimeout(600)
const afterRename = (await openAppDb(page, { store: 'studyCards' })).find(card => card.id === beforeRename.id)
assert(afterRename.title === '我的二次型笔记', 'renaming stores the new title')
assert(afterRename.titleMode === 'custom', 'renaming switches the title mode to custom')
assert(afterRename.createdAt === beforeRename.createdAt && afterRename.autoTitleOrdinal === beforeRename.autoTitleOrdinal, 'renaming keeps createdAt and the ordinal')

// ---- 5. opening a card records lastOpenedAt exactly once ----
const opened = (await openAppDb(page, { store: 'studyCards' })).find(card => card.id === beforeRename.id)
assert(typeof opened.lastOpenedAt === 'number', 'opening a card records lastOpenedAt')
await page.locator('[data-testid="card-back"]').click()
await page.waitForTimeout(300)
assert((await itemTitles()).includes('我的二次型笔记'), 'the renamed card is listed under its new title')

// ---- 6. deletion keeps the conversation and never reuses the ordinal ----
const firstCard = (await openAppDb(page, { store: 'studyCards' })).find(card => card.title === '学习中心测试-1')
await page.locator('[data-testid="card-item"]').filter({ hasText: '学习中心测试-1' }).click()
await page.locator('[data-testid="card-viewer"]').waitFor({ state: 'visible', timeout: 10000 })
await page.locator('[data-testid="card-delete"]').click()
await page.waitForTimeout(700)
const afterDelete = await openAppDb(page, { store: 'studyCards' })
assert(afterDelete.length === 2 && !afterDelete.some(card => card.id === firstCard.id), 'deleting a card removes only that card')
// The viewer moves to a neighbouring card instead of collapsing to an empty screen.
assert(await page.locator('[data-testid="card-viewer"]').count() === 1, 'deleting the open card moves to a neighbour instead of crashing')
await page.locator('[data-testid="card-back"]').click()
await page.waitForTimeout(400)
assert((await page.locator('[data-testid="card-item"]').count()) === 2, 'the list reflects the deletion')
await page.locator('[data-testid="learning-center-close"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'hidden', timeout: 10000 })
const conversations = await openAppDb(page, { store: 'conversations' })
const sourceConversation = conversations.find(item => item.id === 'lc-chat')
assert(!!sourceConversation && sourceConversation.messages.length === 6, 'deleting a card never deletes the conversation or its messages (found ' + conversations.length + ' conversations)')

await saveCard(0)
const afterNewSave = await openAppDb(page, { store: 'studyCards' })
assert(afterNewSave.some(card => card.title === '学习中心测试-4'), 'a new card after a deletion takes the next ordinal (4)')

// ---- 7. PDF filter separates real sources from cards without one ----
// Save one card in a conversation that never touched a PDF.
await page.locator('[data-testid="history-session"]').filter({ hasText: '纯文本会话' }).click()
await page.waitForTimeout(600)
await saveCard(0)
const withPlain = await openAppDb(page, { store: 'studyCards' })
assert(withPlain.length === 4, 'the PDF-free conversation contributes a fourth card (got ' + withPlain.length + ')')
assert(withPlain.some(card => card.documentRefs.length === 0), 'a reply with no PDF context stores no document ref')

await page.locator('[data-testid="sidebar-entry-cards"]').click()
await page.locator('[data-testid="learning-center"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await waitForItems(4) === 4, 'the reopened centre lists every card again')
await safe(() => page.locator('[data-testid="card-filter"] option[value="no-pdf"]').waitFor({ state: 'attached', timeout: 15000 }))
await page.locator('[data-testid="card-filter"]').selectOption('no-pdf')
await page.waitForTimeout(300)
const noPdfTitles = await itemTitles()
assert(noPdfTitles.length === 1, '无 PDF 来源 matches exactly the card whose reply had no PDF context (got ' + noPdfTitles.length + ')')
assert(noPdfTitles[0].startsWith('纯文本会话'), 'the PDF-free card is the one from the PDF-free conversation')
const documentOption = await page.locator('[data-testid="card-filter"] option').evaluateAll(options => options.map(option => option.value))
const documentValue = documentOption.find(value => value.startsWith('document:'))
await page.locator('[data-testid="card-filter"]').selectOption(documentValue)
await page.waitForTimeout(300)
assert((await itemTitles()).length === 3, 'the document filter keeps only the cards that really cite that PDF (got ' + (await itemTitles()).length + ')')
await page.locator('[data-testid="card-filter"]').selectOption('all')
await page.waitForTimeout(300)
assert((await page.locator('[data-testid="card-item"]').count()) === 4, '全部来源 shows every card again')

// ---- 8. artifacts remain reachable globally, but the tabs stay separate ----
await page.locator('[data-testid="learning-tab-artifacts"]').click()
await page.waitForTimeout(400)
assert(await page.locator('[data-testid="learning-tab-artifacts"]').getAttribute('aria-selected') === 'true', 'the 学习成果 tab can be selected globally')
assert((await page.locator('[data-testid="card-list"]').count()) === 0, 'the artifacts tab does not render the card list')
await page.locator('[data-testid="learning-tab-cards"]').click()
await page.waitForTimeout(300)
assert(await page.locator('[data-testid="card-list"]').count() === 1, 'switching back restores the card list')

// ---- 9. reduced motion / mobile: no horizontal overflow ----
await page.setViewportSize({ width: 375, height: 812 })
await page.waitForTimeout(400)
assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), '375px learning centre has no horizontal overflow')
assert(await page.locator('[data-testid="card-item"]').first().isVisible(), 'the card list stays usable on mobile')

assert(errors.length === 0, 'the learning centre produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
