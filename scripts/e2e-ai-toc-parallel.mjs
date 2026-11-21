import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' }
try {
  for (const cancel of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    let completedOcr = 0, activeOcr = 0, peakOcr = 0
    const requests = []
    let releaseModel
    const modelHeld = new Promise(resolve => { releaseModel = resolve })
    await page.route('**/v1/tools/ocr', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      peakOcr = Math.max(peakOcr, ++activeOcr)
      await new Promise(resolve => setTimeout(resolve, 150))
      activeOcr--
      completedOcr++
      await route.fulfill({ headers: cors, json: { object: 'ocr.result', page_count: 1, pages: [{ index: 0, text: 'Recognized directory text', finish_reason: 'stop' }] } })
    })
    await page.route('**/chat/completions', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      const body = route.request().postDataJSON()
      requests.push(body)
      assert.equal(completedOcr, 20)
      assert.equal(body.model, 'deepseek-flash')
      assert.equal(body.stream, false)
      const pages = JSON.parse(body.messages.at(-1).content.split('\n').at(-1))
      assert.deepEqual(pages.map(item => item.sourceImageIndex), Array.from({ length: 20 }, (_, i) => i + 1))
      assert.ok(pages.every(item => item.text === 'Recognized directory text'))
      const rows = pages.map(({ sourceImageIndex }, index) => ({
        title: 'Outline entry ' + (index + 1), pageLabel: String(index + 1), sourceImageIndex, level: [1, 2, 3, 2][index % 4],
      }))
      await modelHeld
      await route.fulfill({ headers: cors, json: { choices: [{ message: { content: JSON.stringify({ rows }) }, finish_reason: 'stop' }] } }).catch(error => { if (!cancel) throw error })
    })
    await seedAndBoot(page, { settings: { apiKey: 'sk-test', uiLanguage: 'en' } })
    await page.getByTestId('sidebar-entry-files').click()
    await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/.playwright/outline-big.pdf')
    await page.getByTestId('reader-page-img').waitFor({ timeout: 30000 })
    await page.getByTestId('reader-toc-ai').click()
    await page.getByTestId('toc-picker-range-start').fill('1')
    await page.getByTestId('toc-picker-range-end').fill('20')
    await page.getByTestId('toc-picker-range-apply').click()
    const modelStarted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/chat/completions'))
    await page.getByTestId('toc-picker-start').click()
    await modelStarted
    assert.match(await page.getByTestId('ai-toc-progress-step').textContent(), /Identifying titles, hierarchy/)
    assert.ok(peakOcr >= 2 && peakOcr <= 3, 'OCR is parallel and bounded')
    if (cancel) {
      await page.getByTestId('ai-toc-progress-cancel').click()
      await page.getByTestId('ai-toc-progress-error').waitFor()
      assert.equal(await page.getByTestId('toc-review').count(), 0)
      releaseModel()
    } else {
      releaseModel()
      await page.getByTestId('toc-review').waitFor()
      const items = await page.locator('[data-testid^="toc-review-item-"]').allTextContents()
      assert.equal(items.length, 20)
      assert.match(items[2], /Outline entry 3.*L3/)
    }
    assert.equal(requests.length, 1)
    console.log('PASS parallel OCR, single complete model request, cancel=' + cancel)
    await page.close()
  }
} finally { await browser.close() }
