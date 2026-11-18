import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, hasTouch: true })
  await page.addInitScript(() => {
    const BrowserAudio = window.Audio
    window.plays = 0
    window.Audio = class extends BrowserAudio {
      async play() { await super.play(); window.plays++ }
    }
  })
  const requests = []
  const pcmLength = 16000 * 2 * 10
  const wav = Buffer.alloc(44 + pcmLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcmLength, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcmLength, 40)
  await page.route('https://api.deepseek.com/v1/tools/tts', async route => {
    requests.push(route.request().postDataJSON().text)
    await route.fulfill({ contentType: 'audio/wav', body: wav })
  })
  const genui = { title: '四大核心特征', items: [{ type: 'card', title: '报复 (Retaliatory)', items: [{ type: 'text', content: '遇到背叛时立刻回击。' }] }] }
  const answer = '这是一段说明正文。\n\n```genui\n' + JSON.stringify(genui) + '\n```'
  await seedAndBoot(page, { convs: [{ id: 'speech-test', title: '朗读选区测试', createdAt: 1, updatedAt: 1, messages: [msg('answer', 'assistant', answer)] }],
    settings: { apiKey: 'test-key', apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', lastConversationId: 'speech-test', speechRepeatCount: '1' } })
  const cardTitle = page.getByText('报复 (Retaliatory)', { exact: true })
  const bodyText = page.getByText('这是一段说明正文。', { exact: true })
  const select = async (locator, text) => {
    await locator.scrollIntoViewIfNeeded()
    return locator.evaluate((el, text) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf(text)
        if (index < 0) continue
        const range = new Range()
        range.setStart(node, index)
        range.setEnd(node, index + text.length)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
      throw new Error('Text not found: ' + text)
    }, text)
  }
  const highlighted = () => page.evaluate(() => Array.from(CSS.highlights.get('spoken-selection') ?? [], range => range.toString()))
  const play = async count => {
    await page.getByTestId('selection-read-aloud').click()
    await page.waitForFunction(count => window.plays === count, count)
    await page.getByTestId('read-aloud-stop').click()
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await cardTitle.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await select(cardTitle, 'Retaliatory')
  await page.getByTestId('selection-read-aloud').waitFor({ state: 'visible' })
  await cardTitle.dispatchEvent('pointercancel', { pointerType: 'touch', isPrimary: true, bubbles: true })
  await play(1)
  assert.deepEqual(requests, ['Retaliatory'], 'only the selected card text is sent even with highlights disabled')
  assert.deepEqual(await highlighted(), [])

  await openSettings(page, 'general')
  const setting = page.getByRole('checkbox', { name: '高亮朗读过的选区' })
  assert.equal(await setting.isChecked(), false)
  await setting.click()
  await page.getByText('双击高亮文字可重播。').waitFor()
  await page.keyboard.press('Escape')
  if (await page.getByTestId('mobile-history-drawer').isVisible()) await page.getByTestId('sidebar-collapse').click()
  const cardPoint = await select(cardTitle, 'Retaliatory')
  await play(2)
  assert.deepEqual(await highlighted(), ['Retaliatory'])
  await page.touchscreen.tap(cardPoint.x, cardPoint.y)
  await page.touchscreen.tap(cardPoint.x, cardPoint.y)
  await page.waitForFunction(() => window.plays === 3)
  await page.getByTestId('read-aloud-stop').click()
  assert.deepEqual(requests, ['Retaliatory'], 'double-tap reuses cached audio')

  await page.setViewportSize({ width: 1100, height: 850 })
  const prosePoint = await select(bodyText, '说明正文')
  await play(4)
  assert.deepEqual((await highlighted()).sort(), ['Retaliatory', '说明正文'].sort())
  for (const [mode, fill] of [['light', 'rgb(203, 220, 255)'], ['dark', 'rgb(52, 84, 132)']]) {
    await openSettings(page, 'general')
    await page.getByTestId('appearance-' + mode).click()
    await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode)
    await page.keyboard.press('Escape')
    for (const text of [bodyText, cardTitle]) {
      assert.equal(await text.evaluate(el => getComputedStyle(el, '::highlight(spoken-selection)').backgroundColor), fill)
    }
  }
  await page.mouse.dblclick(prosePoint.x, prosePoint.y)
  await page.waitForFunction(() => window.plays === 5)
  await page.getByTestId('read-aloud-stop').click()
  assert.deepEqual(requests, ['Retaliatory', '说明正文'])

  await page.getByRole('button', { name: '展开画布' }).click()
  await select(page.getByRole('dialog', { name: 'GenUI 画布' }).getByText('报复 (Retaliatory)', { exact: true }), 'Retaliatory')
  await play(6)
  await page.getByRole('button', { name: '收起画布' }).click()
  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page, 'general')
  assert.equal(await setting.isChecked(), true, 'setting survives reload')
  await setting.click()
  await page.getByText('双击高亮文字可重播。').waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  assert.deepEqual(await highlighted(), [])
  console.log('PASS GenUI and Markdown selection speech, expanded canvas, persisted preference, and cached replay by double-tap/double-click')
} finally { await browser.close() }
