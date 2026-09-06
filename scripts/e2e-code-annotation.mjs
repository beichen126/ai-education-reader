// Code / inline-code selection + reload persistence/render-restoration e2e.
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
  ],
}

await seedAndBoot(page, { convs: [conversation], settings: { lastConversationId: conversation.id } })
const message = page.locator('[data-message-id="code-assistant"]').first()
await message.waitFor({ state: 'visible', timeout: 15000 })
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

const readAnnotations = () => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('ai-education-reader')
  req.onerror = () => resolve([])
  req.onsuccess = () => {
    const db = req.result
    const get = db.transaction('annotations', 'readonly').objectStore('annotations').getAll()
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result || []) }
    get.onerror = () => resolve([])
  }
}))

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

const beforeReload = await readAnnotations()
assert(expected.every((exact) => beforeReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === exact)), 'all code and inline-code annotations persist before reload')
const beforeHighlights = await readHighlightSnapshot()
assert(beforeHighlights.supported && expected.every((exact) => beforeHighlights.ranges.some(range => range.text === exact && range.width > 0 && range.height > 0)), 'all saved selections have visible CSS Highlights before reload')

// Math remains atomic: its own action creates a math annotation, not a text range.
await message.locator('[data-math][data-annotatable="false"]').evaluate((el) => el.click())
await page.getByRole('button', { name: '标记公式', exact: true }).click()
const withMath = await readAnnotations()
assert(withMath.some(a => a.messageId === 'code-assistant' && a.target?.type === 'math'), 'math annotation remains an atomic math target')

// The table action remains wired after the expanded code coverage.
await message.locator('[data-table-action]').click()
const withTable = await readAnnotations()
assert(withTable.some(a => a.messageId === 'code-assistant' && a.target?.type === 'table'), 'table annotation action still persists a table target')

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
const afterReload = await readAnnotations()
assert(expected.every((exact) => afterReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'text' && a.target.quote?.exact === exact)), 'reload preserves every code and inline-code annotation')
assert(afterReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'math'), 'reload preserves the atomic math annotation')
assert(afterReload.some(a => a.messageId === 'code-assistant' && a.target?.type === 'table'), 'reload preserves the table annotation')
assert(await message.locator('[data-math][data-annotatable="false"]').count() === 1, 'reload keeps math atomic')
assert(await message.locator('[data-table-id]').count() === 1, 'reload keeps table rendering')

await browser.close()
for (const line of results) console.log(line)
for (const error of errors) console.error(error)
if (errors.length || results.some(line => line.startsWith('FAIL'))) process.exitCode = 1
console.log('\nRESULT ' + results.filter(line => line.startsWith('PASS')).length + '/' + results.length + ' passed')
