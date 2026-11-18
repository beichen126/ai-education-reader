import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  const base = process.env.E2E_BASE || 'http://127.0.0.1:5320/ai-education-reader/'
  const app = 'https://appassets.androidplatform.net'
  for (const fallback of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, hasTouch: true, isMobile: true })
    await page.route(app + '/**', async route => {
      const url = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, base).href }) })
    })
    await page.addInitScript(fallback => {
      window.composerLayoutReads = 0
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
      Object.defineProperty(Element.prototype, 'scrollHeight', {
        ...descriptor,
        get() {
          if (this.matches('textarea[class*="composerText"]')) window.composerLayoutReads++
          return descriptor.get.call(this)
        },
      })
      if (fallback) {
        const supports = CSS.supports.bind(CSS)
        CSS.supports = (...args) => args[0] === 'field-sizing' ? false : supports(...args)
      }
    }, fallback)
    const messages = Array.from({ length: 240 }, (_, i) => msg('m' + i, i % 2 ? 'assistant' : 'user',
      i % 2 ? `## Reply ${i}\n\nA **Markdown** paragraph with $x^2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |` : 'Question ' + i))
    const previousBase = process.env.E2E_BASE
    process.env.E2E_BASE = app + '/ai-education-reader/'
    try {
      await seedAndBoot(page, { convs: [{ id: 'long-thread', title: 'Long thread', createdAt: 1, updatedAt: 1, messages }],
        settings: { lastConversationId: 'long-thread', apiKey: 'test-key' } })
    } finally {
      if (previousBase) process.env.E2E_BASE = previousBase
      else delete process.env.E2E_BASE
    }
    await page.setViewportSize({ width: 390, height: 840 })
    const composer = page.getByRole('textbox', { name: '输入消息' })
    if (fallback) await page.addStyleTag({ content: 'textarea { field-sizing: fixed !important; }' })
    await composer.click()
    await page.evaluate(() => { window.composerLayoutReads = 0 })
    const before = await composer.evaluate(el => el.getBoundingClientRect().height)
    await composer.pressSequentially('Typing in long histories')
    assert.equal(await composer.inputValue(), 'Typing in long histories')
    const reads = await page.evaluate(() => window.composerLayoutReads)
    assert.ok(fallback ? reads <= 24 : reads === 0, 'typing must avoid synchronous resize reads on modern WebView and batch them on older WebView; got ' + reads)

    await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    assert.equal(await composer.inputValue(), 'Typing in long histories', 'IME confirmation must keep the draft instead of sending')
    await composer.fill('多行输入\n'.repeat(20) + '结尾')
    await page.waitForFunction(before => document.querySelector('textarea').getBoundingClientRect().height > before + 20, before)
    const height = await composer.evaluate(el => el.getBoundingClientRect().height)
    assert.ok(height <= 212, 'multiline draft grows to the viewport cap')
    await composer.fill('Saved draft')
    await page.waitForFunction(before => document.querySelector('textarea').getBoundingClientRect().height <= before + 1, before)
    const saved = await page.evaluate(() => new Promise(resolve => {
      const started = Date.now()
      const request = indexedDB.open('ai-education-reader')
      request.onerror = () => resolve(false)
      request.onsuccess = () => {
        const db = request.result
        const poll = () => {
          const draft = db.transaction('settings').objectStore('settings').get('draft:long-thread')
          draft.onsuccess = () => {
            const ready = draft.result?.value?.text === 'Saved draft'
            if (ready || Date.now() - started > 5000) { db.close(); resolve(ready) }
            else setTimeout(poll, 25)
          }
          draft.onerror = () => { db.close(); resolve(false) }
        }
        poll()
      }
    }))
    assert.ok(saved, 'the debounced draft write must commit before reload')
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelector('[data-testid="composer"] textarea')?.value === 'Saved draft')
    assert.equal(await composer.inputValue(), 'Saved draft')
    await page.close()
    console.log(`PASS 240-message Android viewport, ${fallback ? 'fallback' : 'native sizing'}, resize reads=${reads}, multiline growth, IME and persistent draft`)
  }
} finally { await browser.close() }
