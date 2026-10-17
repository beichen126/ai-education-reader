import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
const browser = await launchBrowser()
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' }
try {
  for (const cancel of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      const original = window.fetch
      window.__structureBodies = []
      window.fetch = function(input, init) {
        let body
        try { body = JSON.parse(String(init?.body)) } catch {}
        if (String(input).endsWith('/chat/completions') && body?.stream) {
          window.__structureBodies.push(body)
          const attempt = window.__structureBodies.length
          const levels = attempt === 1 ? Array(20).fill(1) : Array.from({length:20}, (_, i) => [1,2,3,2][i % 4])
          const encoder = new TextEncoder()
          const event = content => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
          let timer
          const stream = new ReadableStream({ start(controller) {
            controller.enqueue(event('{"levels":[' + levels.slice(0,3).join(',') + ','))
            timer = setTimeout(() => { controller.enqueue(event(levels.slice(3).join(',') + ']}')); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close() }, 1200)
            init?.signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(new DOMException('Aborted', 'AbortError')) }, { once: true })
          }, cancel() { clearTimeout(timer) } })
          return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
        }
        return original.call(this, input, init)
      }
    })
    const page = await context.newPage(), pending = [], requests = []
    const response = async entry => {
      const parts = entry.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
      const pages = [...parts.filter(part => part.type === 'text').map(part => part.text).join('\n').matchAll(/PDF physical page (\d+)/g)].map(match => Number(match[1]))
      const chapter = Math.floor((pages[0] - 1) / 4) + 1
      const titles = ['Chapter ' + chapter, chapter + '.1 Background', chapter + '.1.1 Scope', chapter + '.2 Method']
      await entry.route.fulfill({ headers: cors, json: { choices: [{ message: { content: JSON.stringify({ rows: titles.map((title, i) => ({ title, pageLabel: String(pages[i]), sourceImageIndex: i + 1, visualIndent: [0,1,2,1][i], numbering: title.split(' ')[0] })) }) }, finish_reason: 'stop' }] } })
    }
    await page.route('**/chat/completions', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      const body = route.request().postDataJSON(); requests.push(body); pending.push({ route, body })
      if (pending.length === 5) {
        for (const entry of [...pending].reverse()) { await response(entry); await new Promise(resolve => setTimeout(resolve, 20)) }
      }
    })
    await seedAndBoot(page, { settings: { apiKey: 'sk-test', uiLanguage: 'en' } })
    await page.locator('[data-testid="sidebar-entry-files"]').click()
    await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/.playwright/outline-big.pdf')
    await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('[data-testid="reader-toc-ai"]').click()
    await page.locator('[data-testid="toc-picker-range-start"]').fill('1')
    await page.locator('[data-testid="toc-picker-range-end"]').fill('20')
    await page.locator('[data-testid="toc-picker-range-apply"]').click()
    await page.locator('[data-testid="toc-picker-start"]').click()
    const progress = page.locator('[data-testid="ai-toc-hierarchy-progress"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="ai-toc-hierarchy-progress"]')?.value === 3, null, { timeout: 30000 })
    assert.equal(await progress.getAttribute('max'), '20')
    assert.match(await page.locator('[data-testid="ai-toc-progress-step"]').textContent(), /3 \/ 20/)
    assert.equal(requests.length, 5, 'five independent vision requests overlap before any response')
    assert.ok(requests.every(body => body.model === 'deepseek-flash' && body.thinking.type === 'disabled' && !body.reasoning_effort))
    if (cancel) {
      await page.locator('[data-testid="ai-toc-progress-cancel"]').click()
      await page.locator('[data-testid="ai-toc-progress-error"]').waitFor({ state: 'visible' })
      assert.equal(await page.locator('[data-testid="toc-review"]').count(), 0)
    } else {
      await page.locator('[data-testid="ai-toc-repair-reason"]').waitFor({ state: 'visible', timeout: 30000 })
      assert.match(await page.locator('[data-testid="ai-toc-repair-reason"]').textContent(), /flattened/)
      await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 30000 })
      const items = await page.locator('[data-testid^="toc-review-item-"]').allTextContents()
      assert.ok(items[0].includes('Chapter 1') && items[4].includes('Chapter 2'), 'reverse completion cannot reorder pages')
      assert.ok(items[2].includes('L3') && items[6].includes('L3'))
      const bodies = await page.evaluate(() => window.__structureBodies)
      assert.equal(bodies.length, 2, 'a format-valid flat result triggers semantic repair')
      assert.ok(bodies.every(body => body.reasoning_effort === 'high' && body.thinking.type === 'enabled'))
      assert.ok(JSON.stringify(bodies[1]).includes('flattened'))
    }
    console.log('PASS parallel outline: five overlapping batches, ordered merge, real 3/20 progress, visible semantic repair reason, Flash default, cancel=' + cancel)
    await context.close()
  }
} finally { await browser.close() }
