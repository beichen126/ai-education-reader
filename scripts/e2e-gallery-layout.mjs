// Browser contract for the responsive web gallery. The seeded image ids intentionally
// omit binaries: loading/error placeholders must use the exact same grid geometry as
// decoded thumbnails, while keeping this layout test fast and deterministic.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 2048, height: 1000 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))

const imageIds = Array.from({ length: 13 }, (_, index) => 'gallery-image-' + (index + 1))
await seedAndBoot(page, {
  convs: [{
    id: 'gallery-layout', title: '网页图库测试', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [msg('gallery-user', 'user', '查看这一组图片', imageIds)],
  }],
  settings: { lastConversationId: 'gallery-layout' },
})

await page.locator('[data-testid="sidebar-entry-images"], [data-testid="rail-images"]').first().click()
const gallery = page.locator('[data-testid="gallery"]')
await gallery.waitFor({ state: 'visible', timeout: 10000 })
await page.waitForFunction(() => document.querySelectorAll('[data-testid="gallery-thumbnail"]').length === 13)

assert((await page.locator('[data-testid="gallery-count"]').innerText()).includes('13 张'), 'the header shows the conversation image count')
assert(await page.locator('[data-testid="gallery-thumbnail"]').first().getAttribute('aria-label') === '查看第 1 张图片', 'thumbnails have useful accessible names')

const desktop = await page.locator('[data-testid="gallery-grid"]').evaluate(element => {
  const grid = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const items = Array.from(element.querySelectorAll('[data-testid="gallery-thumbnail"]')).map(item => item.getBoundingClientRect())
  const rowTops = [...new Set(items.map(item => Math.round(item.top)))]
  return {
    alignContent: style.alignContent,
    gridWidth: Math.round(grid.width),
    viewportWidth: innerWidth,
    columns: items.filter(item => Math.round(item.top) === rowTops[0]).length,
    rows: rowTops.length,
    firstRowTop: rowTops[0],
    secondRowTop: rowTops[1],
  }
})
assert(desktop.alignContent === 'start', 'desktop rows are packed at the top instead of stretching across a tall screen')
assert(desktop.gridWidth <= 1680 && desktop.gridWidth < desktop.viewportWidth, 'wide screens use a centred readable-width gallery canvas')
assert(desktop.columns >= 5 && desktop.columns <= 7, '2048px desktop uses readable thumbnail columns (got ' + desktop.columns + ')')
assert(desktop.rows === 3, 'thirteen desktop thumbnails form compact consecutive rows (got ' + desktop.rows + ')')
assert(desktop.secondRowTop - desktop.firstRowTop < 300, 'the second row follows the first without a large vertical gap')

await page.setViewportSize({ width: 375, height: 812 })
await page.waitForTimeout(150)
const mobile = await page.locator('[data-testid="gallery-grid"]').evaluate(element => ({
  columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
  pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}))
assert(mobile.columns === 2, '375px gallery uses two usable columns')
assert(mobile.pageOverflow <= 2, '375px gallery has no horizontal page overflow')

await page.getByRole('button', { name: '关闭' }).click()
assert(await gallery.count() === 0, 'the gallery close action remains available')
assert(errors.length === 0, 'the responsive gallery produces no page errors')

console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
