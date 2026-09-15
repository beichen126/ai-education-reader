// Desktop sidebar has three drag-controlled states and remembers the committed state:
// normal two-column -> compact one-column -> collapsed rail.
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const results = []
const errors = []
const assert = (condition, message) => results.push((condition ? 'PASS  ' : 'FAIL  ') + message)

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('unhandledrejection', reason => errors.push('unhandledrejection: ' + String(reason)))

const now = Date.now()
await seedAndBoot(page, {
  convs: [{
    id: 'sidebar-resize-chat', title: '侧栏拖动测试', createdAt: now, updatedAt: now,
    messages: [msg('sidebar-u1', 'user', '测试侧栏'), msg('sidebar-a1', 'assistant', '收到。')],
  }],
  settings: { apiKey: 'sk-test', model: 'deepseek-chat', lastConversationId: 'sidebar-resize-chat' },
})

const sidebar = page.locator('[data-testid="sidebar"]')
const handle = page.locator('[data-testid="sidebar-resize-handle"]')
await sidebar.waitFor({ state: 'visible', timeout: 10000 })
await handle.waitFor({ state: 'visible', timeout: 10000 })

const rows = async () => {
  const [image, file, fullscreen, settings] = await Promise.all([
    page.locator('[data-testid="sidebar-entry-images"]').boundingBox(),
    page.locator('[data-testid="sidebar-entry-files"]').boundingBox(),
    page.locator('[data-testid="sidebar-fullscreen"]').boundingBox(),
    page.locator('[data-testid="sidebar-settings"]').boundingBox(),
  ])
  return { image, file, fullscreen, settings }
}

const dragBoundaryBy = async dx => {
  const box = await handle.boundingBox()
  if (!box) throw new Error('sidebar resize handle has no box')
  const x = box.x + box.width / 2
  const y = box.y + Math.min(300, box.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 8 })
  await page.mouse.up()
}

const readPreferences = () => page.evaluate(() => new Promise(resolve => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => resolve(null)
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('settings', 'readonly').objectStore('settings').get('layoutPreferences')
    get.onsuccess = () => { try { db.close() } catch {}; resolve(get.result?.value ?? null) }
    get.onerror = () => { try { db.close() } catch {}; resolve(null) }
  }
}))

const initialWidth = (await sidebar.boundingBox())?.width ?? 0
const initialRows = await rows()
assert(initialWidth >= 244, 'default sidebar starts in the normal width range (got ' + initialWidth + ')')
assert(!await sidebar.getAttribute('data-compact'), 'normal width uses the two-column layout')
assert(Math.abs(initialRows.image.y - initialRows.file.y) < 2, 'normal width keeps 图片 and 文件 side by side')
assert(Math.abs(initialRows.fullscreen.y - initialRows.settings.y) < 2, 'normal width keeps 全屏 and 设置 side by side')

// Move from the 280px default into the compact 184-243px range.
await dragBoundaryBy(-60)
await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.hasAttribute('data-compact'))
const compactWidth = (await sidebar.boundingBox())?.width ?? 0
const compactRows = await rows()
assert(compactWidth >= 184 && compactWidth < 244, 'dragging left reaches the adjustable compact width range (got ' + compactWidth + ')')
assert(compactRows.file.y > compactRows.image.y, 'compact width stacks 图片 above 文件')
assert(compactRows.settings.y > compactRows.fullscreen.y, 'compact width stacks 全屏 above 设置')

await page.waitForFunction(() => new Promise(resolve => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => resolve(false)
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('settings', 'readonly').objectStore('settings').get('layoutPreferences')
    get.onsuccess = () => { const value = get.result?.value; try { db.close() } catch {}; resolve(value?.sidebar >= 184 && value?.sidebar < 244) }
    get.onerror = () => { try { db.close() } catch {}; resolve(false) }
  }
}))
await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="sidebar"][data-compact]').waitFor({ state: 'visible', timeout: 10000 })
const restoredCompactWidth = (await page.locator('[data-testid="sidebar"]').boundingBox())?.width ?? 0
assert(Math.abs(restoredCompactWidth - compactWidth) < 2, 'reload restores the committed compact width (got ' + restoredCompactWidth + ')')

// Pull through the snap boundary. The expanded panel remains mounted while dragging and
// becomes the rail only when the pointer is released.
await dragBoundaryBy(-80)
await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="sidebar"]').count() === 0, 'dragging past the collapse boundary snaps to the icon rail')
await page.waitForFunction(() => new Promise(resolve => {
  const request = indexedDB.open('ai-education-reader')
  request.onerror = () => resolve(false)
  request.onsuccess = () => {
    const db = request.result
    const get = db.transaction('settings', 'readonly').objectStore('settings').get('layoutPreferences')
    get.onsuccess = () => { const value = get.result?.value; try { db.close() } catch {}; resolve(value?.sidebar === 0 && value?.lastExpandedSidebar >= 184) }
    get.onerror = () => { try { db.close() } catch {}; resolve(false) }
  }
}))
const collapsedPreferences = await readPreferences()
assert(collapsedPreferences?.sidebar === 0, 'collapsed state is persisted locally')

await page.reload({ waitUntil: 'networkidle' })
await page.locator('[data-testid="rail-history"]').waitFor({ state: 'visible', timeout: 10000 })
assert(await page.locator('[data-testid="sidebar"]').count() === 0, 'reload restores the collapsed rail')

// The collapsed boundary remains draggable. A short pull stays collapsed;
// crossing the threshold restores an expanded panel at the dragged width.
await dragBoundaryBy(60)
assert(await page.locator('[data-testid="sidebar"]').count() === 0, 'a short pull on the rail stays collapsed')
await dragBoundaryBy(164)
await page.locator('[data-testid="sidebar"][data-compact]').waitFor({ state: 'visible', timeout: 10000 })
const reopenedWidth = (await page.locator('[data-testid="sidebar"]').boundingBox())?.width ?? 0
assert(Math.abs(reopenedWidth - compactWidth) < 2, 'dragging the rail right restores the compact width (got ' + reopenedWidth + ')')

assert(errors.length === 0, 'sidebar resize flow produced no page errors or unhandled rejections')
console.log(results.join('\n'))
console.log('PAGEERRORS:', errors.length ? errors.join(' | ') : '(none)')
console.log(`SUMMARY ${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`)
await context.close()
await browser.close()
if (results.some(line => line.startsWith('FAIL')) || errors.length) process.exitCode = 1
