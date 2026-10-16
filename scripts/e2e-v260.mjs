import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot, installMockModel, getLastRequestBody } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const now = Date.now()
  await seedAndBoot(page, { convs: [{ id: 'v260', title: 'Web research test', createdAt: now, updatedAt: now, messages: [msg('u1', 'user', 'old', ['one', 'two']), msg('a1', 'assistant', 'first'), msg('u2', 'user', 'new', ['three']), msg('a2', 'assistant', 'second')] }], settings: { apiKey: 'sk-test', model: 'deepseek-chat', uiLanguage: 'en', lastConversationId: 'v260', visionCapability: 'supports-image' } })
  const summary = page.locator('[data-testid="composer-context-usage"]')
  await summary.getByText(/3 images total/).waitFor()
  assert.equal(await summary.getAttribute('title'), null)
  assert.ok(await summary.locator('xpath=ancestor::*[@role="navigation"]').count())
  const mode = page.getByRole('button', { name: 'Switch chat mode', exact: true })
  const route = page.getByRole('button', { name: 'Switch route', exact: true })
  const [m, r, s] = await Promise.all([mode.boundingBox(), route.boundingBox(), summary.boundingBox()])
  assert.ok(Math.abs(m.y - r.y) < 5 && Math.abs(m.y - s.y) < 20)
  assert.ok(m.x < r.x && r.x < s.x)
  await route.click()
  await page.getByRole('menuitem', { name: 'Main', exact: true }).click()
  const textarea = page.getByRole('textbox', { name: 'Message', exact: true })
  assert.equal(await page.locator('[data-testid="composer-status-row"]').count(), 0, 'no empty footer status row')
  assert.ok(await textarea.evaluate(element => {
    const bar = element.parentElement.getBoundingClientRect()
    const composer = element.closest('[data-testid="composer"]').getBoundingClientRect()
    return Math.abs(composer.bottom - bar.bottom) <= 1
  }), 'nothing reserves an empty line below the composer bar')
  assert.ok((await textarea.boundingBox()).height <= 48)
  await textarea.fill('line\n'.repeat(70))
  assert.ok((await textarea.boundingBox()).height <= 225)
  assert.ok((await textarea.boundingBox()).height > 150)
  await textarea.fill('')
  assert.ok((await textarea.boundingBox()).height <= 48)
  await page.locator('[data-testid="composer-attach"]').click()
  const local = page.locator('[data-testid="composer-add-local"]')
  const library = page.locator('[data-testid="composer-from-library"]')
  assert.ok(Math.abs((await local.boundingBox()).y - (await library.boundingBox()).y) < 2)
  const toggle = page.getByRole('checkbox', { name: 'Web search', exact: true })
  assert.equal(await toggle.isChecked(), false)
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === true)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('[data-testid="composer-attach"]').click()
  assert.equal(await toggle.isChecked(), true)
  await page.keyboard.press('Escape')
  // Remove fixture-only missing binaries before exercising the real send pipeline.
  await page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('ai-education-reader')
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('conversations', 'readwrite'); const store = tx.objectStore('conversations'); const get = store.get('v260'); get.onsuccess = () => { const chat = get.result; for (const message of chat.messages) message.images = []; store.put(chat) }; tx.oncomplete = () => { db.close(); resolve() } }
  }))
  await page.reload({ waitUntil: 'networkidle' })
  let searches = 0, fetches = 0
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
  await page.route('**/v1/tools/search', route => { if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors }); searches++; return route.fulfill({ json: { results: [{ title: 'Official source', url: 'https://example.org/source', summary: 'Evidence summary' }] }, headers: cors }) })
  await page.route('**/v1/tools/fetch', route => { if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors }); fetches++; return route.fulfill({ json: { title: 'Official source', content: 'Full web evidence.' }, headers: cors }) })
  await installMockModel(page, ['An evidence-based answer.'])
  await textarea.fill('Find current evidence')
  await textarea.press('Enter')
  await page.getByText('Web sources', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(searches, 1); assert.equal(fetches, 1)
  const request = getLastRequestBody()
  assert.equal(request.reasoning_effort, 'max')
  assert.ok(JSON.stringify(request.messages).includes('Full web evidence.'))
  assert.ok(await page.getByRole('link', { name: 'Official source', exact: true }).count())
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
  for (const number of [1, 2]) {
    await installMockModel(page, ['Image batch ' + number + ' understood.'])
    await page.locator('[data-testid="composer-materials-input"]').setInputFiles({ name: 'image-' + number + '.png', mimeType: 'image/png', buffer: png })
    await page.getByText('Added 1 images', { exact: true }).waitFor()
    await textarea.fill('Study image batch ' + number)
    await textarea.press('Enter')
    await page.getByText('Image batch ' + number + ' understood.', { exact: true }).waitFor({ timeout: 15000 })
    await summary.getByText(new RegExp(number + ' images total')).waitFor()
  }
  await page.locator('[data-testid="message-actions"]').nth(2).click()
  await page.locator('[data-testid="message-action-branch"]').click()
  await summary.getByText(/0 images total/).waitFor()
  await page.getByRole('button', { name: 'Switch to Main', exact: true }).click()
  await summary.getByText(/2 images total/).waitFor()
  // Stop while Search is pending: the chat-completions call must never start.
  await page.unroute('**/v1/tools/search')
  let searchStarted
  const started = new Promise(resolve => { searchStarted = resolve })
  await page.route('**/v1/tools/search', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    searchStarted()
    // Cancellation is asserted through the UI and the absence of a completions request.
  })
  const previousRequest = getLastRequestBody()
  await textarea.fill('Cancel this web lookup')
  await textarea.press('Enter')
  await started
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  assert.equal(getLastRequestBody(), previousRequest)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
  assert.deepEqual(errors.filter(error => !/attachment|image/i.test(error)), [])
  const emptyContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const emptyPage = await emptyContext.newPage()
  await seedAndBoot(emptyPage, { settings: { uiLanguage: 'zh-CN' } })
  assert.equal(await emptyPage.locator('[data-testid="composer-status-row"]').count(), 0, 'empty Chinese chat has no reserved status row either')
  await emptyContext.close()
  console.log('PASS v2.6.0: cumulative count after two real image sends and branch switch, one-row header, autosize, two-column menu, persisted Search/Fetch + sources, unchanged max reasoning, Stop during research')
} finally { await browser.close() }
