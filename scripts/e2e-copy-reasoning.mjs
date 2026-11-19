import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  for (const gemini of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, hasTouch: true })
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.copiedText = text } },
    }))
    const now = Date.now()
    const conversation = { id: 'reasoning', title: '复制思维链测试', createdAt: now, updatedAt: now, messages: [msg('first', 'user', '准备测试')] }
    await seedAndBoot(page, { convs: [conversation], settings: {
      apiKey: 'test-key', model: gemini ? 'gemini-3.8-flash' : 'deepseek-flash',
      apiBaseUrl: gemini ? 'https://teamorouter.com/' : 'https://api.deepseek.com', lastConversationId: conversation.id,
    } })
    await page.setViewportSize({ width: 390, height: 844 })
    const reasoning = '单独保留的思考内容'
    const answer = '这是可见的回答正文'
    const requests = []
    await page.route(gemini ? 'https://api.teamorouter.com/v1/chat/completions' : '**/chat/completions', async route => {
      const request = route.request().postDataJSON()
      requests.push(request)
      const error = requests.length === 3
      const frames = [
        { choices: [{ delta: { reasoning_content: reasoning } }] },
        { choices: [{ delta: error ? {} : { content: answer }, finish_reason: error ? 'length' : 'stop' }] },
      ]
      await route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') })
    })
    const composer = page.locator('textarea[class*="composerText"]')
    await composer.fill('请给出答案')
    await composer.press('Enter')
    await page.getByText(answer, { exact: true }).waitFor()
    await page.getByTestId('message-actions').click()
    await page.getByTestId('message-action-copy-reasoning').click()
    await page.getByText('已复制思维链', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.copiedText), reasoning)
    assert.equal(await page.getByText(reasoning, { exact: true }).count(), 0)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('message-copy-source').click()
    await page.waitForFunction(expected => window.copiedText === expected, answer)
    await page.getByTestId('message-actions').click()
    await page.getByTestId('message-action-copy-reasoning').click()
    await page.waitForFunction(expected => window.copiedText === expected, reasoning)
    await composer.fill('继续追问')
    await composer.press('Enter')
    await page.getByText(answer, { exact: true }).nth(1).waitFor()
    assert.equal(requests.length, 2)
    assert.ok(JSON.stringify(requests[1]).includes(answer))
    assert.ok(!JSON.stringify(requests[1]).includes(reasoning))
    await composer.fill('测试截断')
    await composer.press('Enter')
    const failedMessage = page.getByTestId('assistant-generation-error').locator('..')
    // The failed reply can still scroll into view as the composer settles.
    // The successful reply above already covers opening the menu by pointer.
    await failedMessage.getByTestId('message-actions').press('Enter')
    await failedMessage.getByTestId('message-action-copy-reasoning').click()
    await failedMessage.getByText('已复制思维链', { exact: true }).waitFor()
    assert.equal(await failedMessage.getByTestId('message-action-branch').count(), 0)
    await composer.fill('截断后再试')
    await composer.press('Enter')
    await page.getByText(answer, { exact: true }).nth(2).waitFor()
    const history = requests[3].messages
    assert.equal(history.filter(entry => entry.role === 'assistant').length, 2)
    await page.close()
  }
  console.log('PASS: DeepSeek and Gemini reasoning can be copied after reload or truncation and stays out of the answer and follow-up context')
} finally { await browser.close() }
