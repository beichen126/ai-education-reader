import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

process.env.E2E_BASE ||= 'http://127.0.0.1:5173/ai-education-reader/'
const source = String.raw`\[G(0)=0,\qquad \lim_{h\downarrow0}G(h)=1.\]

Inline: $\lim_{x\to\infty}f(x)=0$.

Monotone limits: $x_n\uparrow x$, $h\downarrow0$; left and right: $x\leftarrow0$, $x\rightarrow0$.

\[\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6},\qquad \limsup_{n\to\infty} a_n.\]`
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  await seedAndBoot(page, { convs: [{ id: 'limits', title: 'Limit rendering regression', createdAt: 1, updatedAt: 1, messages: [msg('limits-assistant', 'assistant', source)] }], settings: { lastConversationId: 'limits' } })
  const root = page.locator('[data-message-id="limits-assistant"]').first()
  await root.locator('.katex-html').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await root.locator('.katex-error').count(), 0)
  assert.equal(await root.locator('[data-math-kind="block"]').count(), 2)
  const glyphs = await root.locator('.katex-html').allTextContents()
  for (const arrow of ['↑', '↓', '←', '→']) assert.ok(glyphs.some(text => text.includes(arrow)), `Arrow ${arrow} remains semantically correct`)
  assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true)
  const first = root.locator('[data-math-kind="block"]').first()
  assert.equal(await first.locator('annotation').textContent(), String.raw`G(0)=0,\qquad \lim_{h\downarrow0}G(h)=1.`)
  assert.equal(await first.locator('.op-limits').count(), 1)
  assert.equal(await first.locator('.op-limits .mrel').textContent(), '↓')
  const fits = await first.evaluate(el => {
    const outer = el.getBoundingClientRect()
    const inner = el.querySelector('.op-limits').getBoundingClientRect()
    return inner.top >= outer.top-1 && inner.bottom <= outer.bottom+1
  })
  assert.ok(fits, 'The limit and its subscript are not vertically clipped')
  await mkdir('test-results', { recursive: true })
  await root.screenshot({ path: 'test-results/math-limits.png' })
  console.log('PASS: up/down/left/right arrows preserve source semantics; limit subscript, KaTeX font and no clipping verified')
  await context.close()
} finally { await browser.close() }
