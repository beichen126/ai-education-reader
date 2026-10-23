import { selectSettingsSection } from './e2e-navigation.mjs'
// Code / inline-code selection + reload persistence/render-restoration e2e.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { mathComparison } from './fixtures/math-comparison.mjs'
import { mathSummary } from './fixtures/math-summary.mjs'
import { leverageParagraph } from './fixtures/currency.mjs'
import { multilineDollarMath } from './fixtures/multiline-dollar-math.mjs'

const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' })
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
    msg('code-assistant', 'assistant', [
      '普通 Markdown 文本，用于确认普通消息渲染没有回归。',
      '',
      '行内代码：`内联 code 😀  空格`。',
      '',
      '数学公式：$x^2 + y^2 = z^2$',
      '',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| CJK | 42 |',
      '',
      '```text',
      '    return True',
      '```',
      '',
      '```text',
      '    整行 CJK',
      '```',
      '',
      '```text',
      '第一行 😀  空格',
      '    第二行 中文',
      '第三行',
      '```',
      '',
      '```text',
      '完整区块 😀',
      '  缩进 CJK',
      '```',
    ].join('\n')),
    msg('comparison-assistant', 'assistant', mathComparison + '\n\n> 引用中的公式\n> \\[\n> x^2\n> \\]\n> 引用结尾'),
    msg('summary-assistant', 'assistant', mathSummary),
    msg('markdown-user', 'user', mathSummary + '\n\n\\[\nx^2 + y^2 = z^2\n\\]\n\n```js\nconst value = 42\n```'),
    msg('currency-assistant', 'assistant', leverageParagraph + '\n\nPay $100 and calculate $x^2$ or $100 + 20$.'),
    msg('currency-user', 'user', leverageParagraph),
    msg('multiline-dollar-assistant', 'assistant', multilineDollarMath),
  ],
}

conversation.messages[1].createdAt = Date.UTC(2026, 9, 15, 6, 8, 36)
await seedAndBoot(page, { convs: [conversation], settings: { lastConversationId: conversation.id } })
const message = page.locator('[data-message-id="code-assistant"]').first()
await message.waitFor({ state: 'visible', timeout: 15000 })
const shortBubble = await page.locator('[data-message-id="code-user"]').evaluate(row => {
  const bubble = row.firstElementChild
  const paragraph = bubble.querySelector('p')
  const style = getComputedStyle(bubble)
  return { height: bubble.getBoundingClientRect().height, expected: paragraph.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) }
})
assert(Math.abs(shortBubble.height - shortBubble.expected) < 2, 'single-line user bubble has only its original padding, without extra Markdown margins')
const codeBlocks = message.locator('pre[data-block-type="code"][data-annotatable="true"]')
assert(await codeBlocks.count() === 4, 'four code blocks are rendered as annotatable')
assert(await message.locator('p code').count() === 1, 'inline code is rendered')
assert(await message.locator('[data-math][data-annotatable="false"]').count() === 1, 'math remains atomic and non-text-annotatable')
assert(await message.locator('[data-table-id]').count() === 1, 'table remains rendered')
assert(await message.locator('[data-table-action]').count() === 1, 'table annotation action remains available')

// Select through the same DOM Range path used by a real browser drag, then
// activate the existing text annotation bar. Every case is intentionally
// non-overlapping so normalization cannot hide a boundary regression.
const expected = []
const markButton = page.getByRole('button', { name: '标记', exact: true })
const selectAndMark = async (target, exact, label) => {
  await target.scrollIntoViewIfNeeded()
  await target.evaluate((el, wanted) => {
    const span = el.matches('[data-canonical-start]') ? el : el.querySelector('[data-canonical-start]')
    const text = span?.firstChild
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error('annotation text node missing')
    const value = text.textContent || ''
    const start = value.indexOf(wanted)
    if (start < 0) throw new Error('selection text missing: ' + wanted)
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + wanted.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, exact)
  await markButton.waitFor({ state: 'visible', timeout: 5000 })
  await markButton.click()
  expected.push(exact)
  await page.waitForFunction(({ messageId, exact }) => {
    const highlight = typeof CSS !== 'undefined' && CSS.highlights?.get('study-highlight')
    if (!highlight) return false
    return Array.from(highlight).some((range) => range.toString() === exact && range.getBoundingClientRect().width > 0 && range.getBoundingClientRect().height > 0 && document.querySelector(`[data-message-id="${messageId}"]`))
  }, { messageId: 'code-assistant', exact })
  assert(true, label + ' creates and paints a text highlight')
}

await selectAndMark(codeBlocks.nth(0), 'return', 'single-line partial code selection')
await selectAndMark(codeBlocks.nth(1), '    整行 CJK', 'whole code line with indentation and CJK')
await selectAndMark(codeBlocks.nth(2), '第一行 😀  空格\n    第二行 中文', 'multi-line code selection with spaces, indentation, emoji and CJK')
await selectAndMark(codeBlocks.nth(3), '完整区块 😀\n  缩进 CJK', 'whole code block selection')
await selectAndMark(message.locator('p code'), '内联 code 😀  空格', 'inline code selection')
await selectAndMark(message.locator('p[data-block-type="paragraph"]').first(), '普通 Markdown 文本', 'ordinary Markdown text selection')

// v2.3 stores marks canonically on the source StudyCard. The old annotations
// object store is migration input only and must not be used as the persistence
// oracle for marks created by the current UI.
const readUnifiedAnnotations = () => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onerror = () => resolve({ cards: [], annotations: [] })
  req.onsuccess = () => {
    const db = req.result
    const get = db.transaction('studyCards', 'readonly').objectStore('studyCards').getAll()
    get.onsuccess = () => {
      const cards = get.result || []
      const annotations = cards.flatMap(card => Array.isArray(card.annotations) ? card.annotations : [])
      try { db.close() } catch {}
      resolve({ cards, annotations })
    }
    get.onerror = () => resolve({ cards: [], annotations: [] })
  }
}))

const waitForUnifiedTarget = targetType => page.waitForFunction(type => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onerror = () => resolve(false)
  req.onsuccess = () => {
    const db = req.result
    const get = db.transaction('studyCards', 'readonly').objectStore('studyCards').getAll()
    get.onsuccess = () => {
      const found = (get.result || []).some(card => (card.annotations || []).some(annotation => annotation.target?.type === type))
      try { db.close() } catch {}
      resolve(found)
    }
    get.onerror = () => { try { db.close() } catch {}; resolve(false) }
  }
}), targetType, { timeout: 10000 })

const readHighlightSnapshot = () => page.evaluate(() => {
  const highlight = typeof CSS !== 'undefined' && CSS.highlights?.get('study-highlight')
  return {
    supported: !!highlight,
    ranges: highlight ? Array.from(highlight).map((range) => {
      const box = range.getBoundingClientRect()
      return { text: range.toString(), width: box.width, height: box.height }
    }) : [],
  }
})

const beforeReload = await readUnifiedAnnotations()
assert(beforeReload.cards.length === 1 && beforeReload.cards[0]?.collectionMode === 'marked', 'current marks share one marked learning card')
assert(expected.every((exact) => beforeReload.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === exact)), 'all code and inline-code annotations persist on the learning card before reload')
const beforeHighlights = await readHighlightSnapshot()
assert(beforeHighlights.supported && expected.every((exact) => beforeHighlights.ranges.some(range => range.text === exact && range.width > 0 && range.height > 0)), 'all saved selections have visible CSS Highlights before reload')

// Math remains atomic: its own action creates a math annotation, not a text range.
const formula = message.locator('[data-math][data-annotatable="false"]')
const formulaVisual = formula.locator('.katex-html')
const formulaButton = page.getByRole('button', { name: '标记公式', exact: true })
const selectFormula = locator => locator.evaluate(el => {
  const range = document.createRange(); range.selectNodeContents(el)
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
})
await formula.scrollIntoViewIfNeeded()
await selectFormula(formulaVisual)
await formulaButton.waitFor({ state: 'visible' })
const formulaBox = await formula.boundingBox()
const toolbarBox = await formulaButton.boundingBox()
assert(Math.abs(toolbarBox.y - (formulaBox.y + formulaBox.height + 6)) < 2, 'formula toolbar is anchored beside its formula, not the composer')
await formula.evaluate(el => {
  let parent = el.parentElement
  while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement
  parent?.dispatchEvent(new Event('scroll'))
})
assert(await formulaButton.isVisible(), 'a queued scroll notification without movement does not dismiss a newly opened toolbar')
await page.locator('textarea').first().click()
assert(await formulaButton.count() === 0, 'clicking the composer dismisses the formula toolbar')
await selectFormula(formulaVisual)
await formulaButton.waitFor({ state: 'visible' })
await formula.evaluate(el => el.dispatchEvent(new Event('scroll', { bubbles: false })))
await formulaButton.waitFor({ state: 'detached' })
assert(true, 'scrolling dismisses the formula toolbar')
await selectFormula(formulaVisual)
await formulaButton.waitFor({ state: 'visible' })
await page.setViewportSize({ width: 600, height: 900 })
await formulaButton.waitFor({ state: 'detached' })
assert(true, 'resizing dismisses the formula toolbar')
await page.setViewportSize({ width: 1280, height: 900 })
await formula.scrollIntoViewIfNeeded()
await selectFormula(formulaVisual)
await formulaButton.click()
await waitForUnifiedTarget('math')
const withMath = await readUnifiedAnnotations()
assert(withMath.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'math'), 'math annotation remains an atomic math target')

// The table action remains wired after the expanded code coverage.
await message.locator('[data-table-action]').click()
await waitForUnifiedTarget('table')
const withTable = await readUnifiedAnnotations()
assert(withTable.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'table'), 'table annotation action still persists a table target')

await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-message-id="code-assistant"]').first().waitFor({ state: 'visible', timeout: 15000 })
await page.waitForFunction(({ messageId, expected }) => {
  const highlight = typeof CSS !== 'undefined' && CSS.highlights?.get('study-highlight')
  if (!highlight) return false
  const ranges = Array.from(highlight)
  return expected.every((exact) => ranges.some((range) => {
    const box = range.getBoundingClientRect()
    return range.toString() === exact && box.width > 0 && box.height > 0 && document.querySelector(`[data-message-id="${messageId}"]`)
  }))
}, { messageId: 'code-assistant', expected })

const afterReloadHighlights = await readHighlightSnapshot()
assert(afterReloadHighlights.supported && expected.every((exact) => afterReloadHighlights.ranges.some(range => range.text === exact && range.width > 0 && range.height > 0)), 'reload re-registers CSS Highlights covering every exact code selection')
const afterReload = await readUnifiedAnnotations()
assert(afterReload.cards.length === 1, 'reload keeps one canonical learning card for the marked reply')
assert(expected.every((exact) => afterReload.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === exact)), 'reload preserves every code and inline-code annotation')
assert(afterReload.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'math'), 'reload preserves the atomic math annotation')
assert(afterReload.annotations.some(a => a.messageId === 'code-assistant' && a.target?.type === 'table'), 'reload preserves the table annotation')
assert(await message.locator('[data-math][data-annotatable="false"]').count() === 1, 'reload keeps math atomic')
assert(await message.locator('[data-table-id]').count() === 1, 'reload keeps table rendering')

const comparison = page.locator('[data-message-id="comparison-assistant"]').first()
assert(await comparison.locator('[data-math-kind="block"]').count() === 3, 'list and quote display formulas render instead of disappearing')
assert(await comparison.locator('strong').allTextContents().then(texts => texts.includes('收敛') && texts.includes('发散')), 'both conclusions after the display formulas remain visible')
const nestedFormula = comparison.locator('[data-math-kind="block"]').first()
await nestedFormula.scrollIntoViewIfNeeded()
await selectFormula(nestedFormula.locator('.katex-html'))
await page.getByRole('button', { name: '标记公式', exact: true }).click()
await page.waitForFunction(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onsuccess = () => {
    const db = req.result
    const read = db.transaction('studyCards', 'readonly').objectStore('studyCards').getAll()
    read.onsuccess = () => { db.close(); resolve(read.result.some(card => card.sourceAssistantMessageId === 'comparison-assistant' && card.annotations?.some(a => a.target.type === 'math' && a.target.mathKind === 'block'))) }
  }
}))
assert(true, 'nested display formula marking persists on its source learning card')
const summary = page.locator('[data-message-id="summary-assistant"]').first()
assert(await summary.locator('tr').count() === 4 && await summary.locator('tr').last().locator('td').count() === 2, 'summary table retains four rows and two columns')
assert(await summary.locator('td').last().locator('[data-math-kind="inline"]').count() === 2, 'absolute integral and conditional convergence formulas both render inside their cell')
assert(await summary.locator('.katex-error').count() === 0, 'summary formulas render without KaTeX errors')
assert((await summary.locator('td').last().locator('strong').textContent()).includes('绝对收敛'), 'bold text surrounding the absolute integral remains intact')
const absoluteFormula = summary.locator('annotation[encoding="application/x-tex"]').filter({ hasText: String.raw`\int|f|` })
assert(await absoluteFormula.count() === 1, 'absolute-value bars reach the math renderer unchanged')
assert(await summary.locator('ol li').count() === 3, 'follow-up exercises after the table remain visible')
const userMessage = page.locator('[data-message-id="markdown-user"]').first()
assert(await page.locator('[data-message-id="markdown-user"]').count() === 1, 'user message retains one navigation root including text and attachments')
assert(await userMessage.locator('h1').count() === 1 && await userMessage.locator('strong').count() > 0, 'sent user text renders Markdown headings and bold')
assert(await userMessage.locator('[data-math-kind="block"]').count() === 1, 'sent user text renders display LaTeX')
assert(await userMessage.locator('tr').last().locator('td').count() === 2, 'sent user text uses the same math-compatible table parser')
assert((await userMessage.locator('pre code').textContent()).includes('const value = 42'), 'sent user code blocks render without changing their source')
const userFormula = userMessage.locator('[data-math-kind="inline"]').filter({ hasText: String.raw`\int|f|` }).first()
const userCopied = await userFormula.evaluate(el => {
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  const data = new DataTransfer()
  el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
  selection.removeAllRanges()
  return data.getData('text/plain')
})
assert(userCopied === String.raw`\(\int|f|\)`, 'partial copy of a rendered user formula restores its exact LaTeX source')
assert(await userMessage.locator('[data-testid="user-message-copy-source"]').count() === 1, 'sent user message offers full-source copying')
assert(await userMessage.locator('[data-table-action]').count() === 0, 'user rendering does not expose assistant-only study-card actions')
const currencyReply = page.locator('[data-message-id="currency-assistant"]').first()
assert(await currencyReply.locator('p').first().textContent() === leverageParagraph, 'financial paragraph renders every dollar amount and original space')
assert(await currencyReply.locator('p').first().locator('.katex').count() === 0, 'dollar amounts do not turn financial prose into italic math')
assert(await currencyReply.locator('.katex').count() === 2, 'genuine formulas still render alongside currency')
const currencyUser = page.locator('[data-message-id="currency-user"]').first()
assert(await currencyUser.locator('p').textContent() === leverageParagraph && await currencyUser.locator('.katex').count() === 0, 'user messages apply the same dollar-amount handling')
const dollarReply = page.locator('[data-message-id="multiline-dollar-assistant"]').first()
assert(await dollarReply.locator('[data-math-kind="block"]').count() === 9, 'attached multiline dollar formulas render as nine independent blocks')
assert(await dollarReply.locator('.katex-error').count() === 0, 'multiline dollar formulas render without red KaTeX errors')
assert((await dollarReply.locator('p').allTextContents()).some(text => text.includes('部分分式')), 'prose between multiline dollar blocks remains outside formulas')
assert((await dollarReply.locator('strong').allTextContents()).some(text => text.startsWith('总结：')), 'summary after multiline dollar formulas remains formatted Markdown')
const messageTime = message.locator('time')
assert(await messageTime.textContent().then(text => text.trim()) === '10月15日 14:08:36', 'Chinese message time displays local month, day and time down to seconds')
assert(await messageTime.getAttribute('datetime') === '2026-10-15T06:08:36.000Z', 'message time uses saved creation time rather than current time or later updates')
assert(await messageTime.evaluate(el => el.previousElementSibling?.dataset.testid === 'message-copy-source' && !!el.nextElementSibling?.querySelector('[data-testid="message-actions"]')), 'timestamp sits between full-source copy and the message menu')
assert(await userMessage.locator('time').count() === 1, 'user messages also display their saved timestamp')
await page.locator('[data-testid="sidebar-settings"]').click()
await selectSettingsSection(page, 'general'); await page.locator('[data-testid="language-en"]').click()
await page.waitForFunction(() => document.documentElement.lang === 'en')
await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-message-id="code-assistant"] time')).some(el => el.textContent.trim() === '10/15 14:08:36'))
assert((await messageTime.getAttribute('title')).startsWith('Message created: '), 'English mode changes timestamp and hover text immediately')
await selectSettingsSection(page, 'general'); await page.locator('[data-testid="language-zh-cn"]').click()
await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-message-id="code-assistant"] time')).some(el => el.textContent.trim() === '10月15日 14:08:36'))
assert((await messageTime.getAttribute('title')).startsWith('消息创建时间：'), 'switching back restores Chinese timestamp and hover text')
await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')
