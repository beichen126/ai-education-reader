import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'
const browser = await launchBrowser()
try {
  const page = await browser.newPage({viewport:{width:1280,height:844}})
  await seedAndBoot(page, { convs: [{ id: 'usage-test', title: 'Usage test', createdAt: 1, updatedAt: 1, messages: [
    msg('u1', 'user', 'hello'), { ...msg('a1', 'assistant', 'first'), tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    msg('u2', 'user', 'more'), { ...msg('a2', 'assistant', 'second'), tokenUsage: { inputTokens: 74650, outputTokens: 2114, totalTokens: 76764 } },
  ] }], settings: { lastConversationId: 'usage-test' } })
  for (let i = 0; i < 2; i++) {
    await page.setViewportSize({width:i===0?390:320,height:844})
    await page.getByTestId('official-token-usage').waitFor()
    assert.match(await page.getByTestId('official-token-usage').innerText(), /74\.65k.*2\.11k/)
    assert.equal(await page.getByTestId('cumulative-token-usage').count(),0)
    assert.doesNotMatch(await page.getByTestId('composer-context-usage').innerText(), /估算|约|已占用/)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    await page.setViewportSize({width:320,height:640})
    await page.reload({ waitUntil: 'networkidle' })
  }
  console.log('PASS: official input/output in k with two decimals, no cumulative counter, reload persistence')
} finally { await browser.close() }
