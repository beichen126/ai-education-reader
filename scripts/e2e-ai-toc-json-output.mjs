import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
try {
  for (const scenario of ['truncation', 'unsupported-json', 'length-error', 'missing-deepseek-key']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const requests = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    let transcriptionCalls = 0
    await page.route('**/chat/completions', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      assert.equal(new URL(route.request().url()).hostname, 'api.deepseek.com')
      assert.equal(route.request().headers().authorization, 'Bearer deepseek-test-key')
      const body = route.request().postDataJSON()
      assert.equal(body.model, 'deepseek-flash')
      requests.push(body)
      const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])
      if (!images.length) return route.fulfill({ headers: cors, json: { choices: [{ message: { content: JSON.stringify({ levels: Array(250).fill(1) }) }, finish_reason: 'stop' }] } })
      transcriptionCalls++
      if (scenario === 'unsupported-json' && transcriptionCalls === 1) return route.fulfill({ status: 400, headers: cors, json: { error: { message: 'response_format is unsupported' } } })
      const rows = Array.from({ length: scenario === 'truncation' ? (images.length === 2 ? 250 : 125) : 250 }, (_, index) => ({ title: 'Chapter ' + transcriptionCalls + '-' + index, pageLabel: String(index + 1), sourceImageIndex: 1 }))
      const truncated = scenario === 'length-error' || (scenario === 'truncation' && images.length === 2)
      const content = truncated ? rows.map(row => JSON.stringify(row)).join('\n') + '\n{"title":"unfinished' : JSON.stringify({ rows })
      return route.fulfill({ headers: cors, json: { choices: [{ message: { content }, finish_reason: truncated ? 'length' : 'stop' }] } })
    })
    const apiProfiles = scenario === 'missing-deepseek-key' ? [] : [{ id: 'official', name: 'DeepSeek',
      config: { apiBaseUrl: 'https://api.deepseek.com/v1', apiKey: 'deepseek-test-key', model: 'deepseek-v4-pro', visionCapability: 'text-only' } }]
    await seedAndBoot(page, { settings: { apiKey: 'gateway-test-key', model: 'gemini-3.8-flash',
      apiBaseUrl: 'https://api.teamorouter.com/v1', uiLanguage: 'en', visionCapability: 'text-only', apiProfiles } })
    await page.locator('[data-testid="sidebar-entry-files"]').click()
    await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/no-outline.pdf')
    await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('[data-testid="reader-toc-ai"]').click()
    await page.locator('[data-testid="toc-thumb-7"]').click()
    if (scenario !== 'length-error' && scenario !== 'missing-deepseek-key') await page.locator('[data-testid="toc-thumb-8"]').click()
    await page.locator('[data-testid="toc-picker-start"]').click()
    if (scenario === 'missing-deepseek-key') {
      const notice = page.locator('[data-testid="ai-toc-progress-error"]')
      await notice.waitFor({ state: 'visible' })
      assert.match(await notice.textContent(), /official DeepSeek API key/i)
      assert.equal(requests.length, 0)
      console.log('PASS outline detection requests an official DeepSeek key before sending')
      await context.close()
      continue
    }
    if (scenario === 'length-error') {
      const notice = page.locator('[data-testid="ai-toc-progress-error"]')
      await notice.waitFor({ state: 'visible', timeout: 30000 })
      assert.match(await notice.textContent(), /truncated.*output-token limit/i)
      assert.match(await notice.textContent(), /PDF page\(s\) 7/)
      assert.equal(await page.locator('[data-testid="toc-review"]').count(), 0)
    } else {
      await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 30000 })
      assert.equal(await page.locator('[data-testid^="toc-review-item-"]').count(), 250, 'every returned row is retained, not just a valid prefix')
      if (scenario === 'truncation') {
        assert.equal(transcriptionCalls, 3, 'truncated two-image batch immediately splits into two single-image requests')
        assert.equal(requests.at(-1).reasoning_effort, 'high')
        assert.equal(requests.at(-1).thinking.type, 'enabled')
      } else {
        assert.equal(transcriptionCalls, 2)
        assert.equal(requests[1].response_format, undefined, 'the response format can be retried without JSON mode')
      }
    }
    assert.equal(requests[0].response_format.type, 'json_object')
    assert.equal(requests[0].max_tokens, 8192)
    assert.equal(requests[0].thinking.type, 'disabled')
    assert.equal(requests[0].reasoning_effort, undefined)
    assert.deepEqual(errors, [])
    console.log('PASS outline JSON: ' + scenario + ', 250-row output, schema options, complete review / explicit failure')
    await context.close()
  }
} finally { await browser.close() }
