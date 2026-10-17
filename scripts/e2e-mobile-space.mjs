import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => { window.__imageUrls = 0; const create = URL.createObjectURL; URL.createObjectURL = function(blob) { if (blob.type.startsWith('image/')) window.__imageUrls++; return create.call(this, blob) } })
  const page = await context.newPage()
  await seedAndBoot(page, { convs: [{ id: 'mobile-space', title: 'Mobile space', createdAt: 1, updatedAt: 1, messages: [msg('a', 'assistant', '手机阅读区域测试。English reading area. '.repeat(15))] }], settings: { lastConversationId: 'mobile-space' } })
  for (const width of [320, 375, 390, 412, 760]) {
    await page.setViewportSize({ width, height: 844 })
    const menu = page.locator('[data-testid="mobile-menu-toggle"]')
    await menu.waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-testid="rail-history"]').isVisible(), false)
    const box = await page.locator('[data-testid="conversation"]').boundingBox()
    assert.ok(box.x <= 1 && box.width >= width - 2, 'phone conversation uses the full viewport at ' + width + ': ' + JSON.stringify(box))
    const body = await page.locator('[class*="assistantBody"]').first().boundingBox()
    assert.ok(body.width >= width - 30, 'assistant message does not retain desktop 80% width')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
    await menu.click()
    const drawer = page.locator('[data-testid="mobile-history-drawer"]')
    await drawer.waitFor({ state: 'visible' })
    assert.equal(await menu.getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    assert.equal(await menu.getAttribute('aria-expanded'), 'false')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('ai-education-reader')
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['conversations', 'attachments'], 'readwrite')
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
      const messages = []
      for (let index = 0; index < 40; index++) {
        const id = 'lazy-' + index, blob = new Blob([bytes], { type: 'image/png' })
        tx.objectStore('attachments').put({ id, meta: { id, name: id + '.png', mimeType: 'image/png', size: blob.size, createdAt: 1, updatedAt: 1 }, blob })
        messages.push({ id: 'u-' + index, role: 'user', content: 'Question ' + index, images: [id], createdAt: index, updatedAt: index }, { id: 'a-' + index, role: 'assistant', content: 'Reading paragraph. '.repeat(60), images: [], createdAt: index, updatedAt: index })
      }
      tx.objectStore('conversations').put({ id: 'mobile-space', title: 'Mobile space', createdAt: 1, updatedAt: 1, messages })
      tx.oncomplete = () => { db.close(); resolve() }
    }
  }))
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('[data-testid="message-image-thumb"]').last().scrollIntoViewIfNeeded()
  await page.waitForFunction(() => window.__imageUrls > 0)
  assert.ok(await page.evaluate(() => window.__imageUrls < 20), 'opening a long chat does not eagerly read all 40 originals')
  await page.locator('[data-testid="mobile-menu-toggle"]').click()
  await page.locator('[data-testid="sidebar-entry-images"]').click()
  const last = page.locator('[data-testid="gallery-thumbnail"]').last()
  await last.scrollIntoViewIfNeeded()
  await last.locator('img').waitFor({ state: 'visible' })
  assert.equal(await last.locator('img').getAttribute('decoding'), 'async')
  console.log('PASS phone: full-width at 320/375/390/412/760px, compact margins, menu/Escape, deferred original reads and async decode')
} finally { await browser.close() }
