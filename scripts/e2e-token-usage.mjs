import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'
const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await seedAndBoot(page, { convs: [{ id: 'usage-test', title: 'Usage test', createdAt: 1, updatedAt: 1, messages: [
    msg('u1', 'user', 'hello'), { ...msg('a1', 'assistant', 'first'), tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    msg('u2', 'user', 'more'), { ...msg('a2', 'assistant', 'second'), tokenUsage: { inputTokens: 140, outputTokens: 30, totalTokens: 170 } },
  ] }], settings: { lastConversationId: 'usage-test' } })
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('official-token-usage').waitFor()
    assert.match(await page.getByTestId('official-token-usage').innerText(), /140.*30/)
    assert.match(await page.getByTestId('cumulative-token-usage').innerText(), /290.*2/)
    assert.doesNotMatch(await page.getByTestId('composer-context-usage').innerText(), /估算|约|已占用/)
    await page.reload({ waitUntil: 'networkidle' })
  }
  console.log('PASS: official input/output, cumulative measured requests, persistence across reload, no estimates')
} finally { await browser.close() }
