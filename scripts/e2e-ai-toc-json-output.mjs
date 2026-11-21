import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
try {
  for (const scenario of ['six-pages', 'unsupported-json', 'length-error', 'missing-deepseek-key', 'truncated-ocr']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const requests = [], errors = [], ocrCalls = []
    page.on('pageerror', error => errors.push(error.message))
    let transcriptionCalls = 0
    await page.route('**/v1/tools/ocr', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      assert.equal(route.request().headers().authorization, 'Bearer deepseek-test-key')
      assert.match(route.request().headers()['content-type'], /multipart\/form-data/)
      ocrCalls.push(route.request())
      return route.fulfill({ headers: cors, json: { object: 'ocr.result', page_count: 1, pages: [{ index: 0, text: 'OCR fixture chapter ... 12', finish_reason: scenario === 'truncated-ocr' ? 'length' : 'stop' }] } })
    })
    await page.route('**/chat/completions', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      assert.equal(new URL(route.request().url()).hostname, 'api.deepseek.com')
      assert.equal(route.request().headers().authorization, 'Bearer deepseek-test-key')
      const body = route.request().postDataJSON()
      assert.equal(body.model, 'deepseek-flash')
      requests.push(body)
      assert.ok(body.messages.every(message => typeof message.content === 'string'), 'outline model requests contain text only')
      const text = body.messages.at(-1).content
      const pageCount = text.split('OCR fixture chapter ... 12').length - 1
      assert.equal(pageCount, scenario === 'six-pages' ? 6 : 1)
      assert.equal(ocrCalls.length, pageCount, 'all OCR finishes before calling the model')
      assert.match(body.messages[0].content, /determine its hierarchy across pages/)
      transcriptionCalls++
      if (scenario === 'unsupported-json') return route.fulfill({ status: 400, headers: cors, json: { error: { message: 'response_format is unsupported' } } })
      const rows = Array.from({ length: 250 }, (_, index) => ({ title: 'Entry ' + index, pageLabel: String(index + 1), sourceImageIndex: Math.min(pageCount, 1 + Math.floor(index / 42)), level: index === 0 ? 1 : 2 }))
      const truncated = scenario === 'length-error'
      const content = truncated ? '{"rows":[' : JSON.stringify({ rows })
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
    if (scenario === 'six-pages') for (const n of [3, 4, 5, 6, 8]) await page.getByTestId('toc-thumb-' + n).click()
    await page.locator('[data-testid="toc-picker-start"]').click()
    if (scenario === 'truncated-ocr') {
      const notice = page.getByTestId('ai-toc-progress-error')
      await notice.waitFor({ state: 'visible' })
      assert.match(await notice.textContent(), /PDF page 7 OCR failed: OCR text was truncated/)
      assert.equal(requests.length, 0)
      assert.equal(ocrCalls.length, 1)
      console.log('PASS truncated OCR reports the affected page before calling the model')
      await context.close()
      continue
    }
    if (scenario === 'missing-deepseek-key') {
      const notice = page.locator('[data-testid="ai-toc-progress-error"]')
      await notice.waitFor({ state: 'visible' })
      assert.match(await notice.textContent(), /official DeepSeek API key/i)
      assert.equal(requests.length, 0)
      assert.equal(ocrCalls.length, 0)
      console.log('PASS outline detection requests an official DeepSeek key before sending')
      await context.close()
      continue
    }
    if (scenario === 'length-error' || scenario === 'unsupported-json') {
      const notice = page.locator('[data-testid="ai-toc-progress-error"]')
      await notice.waitFor({ state: 'visible', timeout: 30000 })
      if (scenario === 'length-error') assert.match(await notice.textContent(), /truncated.*output-token limit/i)
      assert.equal(await page.locator('[data-testid="toc-review"]').count(), 0)
    } else {
      await page.locator('[data-testid="toc-review"]').waitFor({ state: 'visible', timeout: 30000 })
      assert.equal(await page.locator('[data-testid^="toc-review-item-"]').count(), 250, 'every returned row is retained, not just a valid prefix')
      assert.equal(await page.locator('[data-testid="toc-review-item-1"]').count(), 1)
    }
    assert.equal(transcriptionCalls, 1, 'only one model call per run, including failures')
    assert.equal(ocrCalls.length, scenario === 'six-pages' ? 6 : 1)
    assert.equal(requests[0].response_format.type, 'json_object')
    assert.equal(requests[0].max_tokens, 8192)
    assert.equal(requests[0].thinking.type, 'disabled')
    assert.equal(requests[0].reasoning_effort, undefined)
    assert.deepEqual(errors, [])
    console.log('PASS outline JSON: ' + scenario + ', 250-row output, schema options, complete review / explicit failure')
    await context.close()
  }
} finally { await browser.close() }
