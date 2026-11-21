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
  await select(bodyText, '说明正文')
  await page.getByRole('button', { name: '标记', exact: true }).click()
  await page.waitForFunction(() => Array.from(CSS.highlights.get('study-highlight') ?? []).some(range => range.toString() === '说明正文'))
  for (const [mode, fill] of [['light', 'rgb(203, 220, 255)'], ['dark', 'rgb(41, 67, 101)']]) {
    await openSettings(page, 'general')
    await page.getByTestId('appearance-' + mode).click()
    await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode)
    await page.keyboard.press('Escape')
    for (const text of [bodyText, cardTitle]) {
      assert.deepEqual(await text.evaluate(el => ['study-highlight', 'spoken-selection'].map(name =>
        getComputedStyle(el, '::highlight(' + name + ')').backgroundColor)), [fill, fill])
      assert.equal(await text.evaluate(el => getComputedStyle(el, '::selection').backgroundColor), fill)
    }
  }
  await page.mouse.dblclick(prosePoint.x, prosePoint.y)
  await page.waitForFunction(() => window.plays === 5)
  await page.getByTestId('read-aloud-stop').click()
  assert.deepEqual(requests, ['Retaliatory', '说明正文'])

  if (process.env.READER_VISUAL_DIR) {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const mode of ['dark', 'light']) {
      await openSettings(page, 'general')
      await page.getByTestId('appearance-' + mode).click()
      await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode)
      await page.keyboard.press('Escape')
      if (await page.getByTestId('mobile-history-drawer').isVisible()) {
        await page.getByTestId('sidebar-collapse').click()
        await page.getByTestId('mobile-history-drawer').waitFor({ state: 'hidden' })
      }
      await cardTitle.scrollIntoViewIfNeeded()
      await page.screenshot({ path: process.env.READER_VISUAL_DIR + '/highlights-' + mode + '.png' })
      await select(cardTitle, '报复')
      await page.getByTestId('selection-read-aloud').waitFor()
      await page.screenshot({ path: process.env.READER_VISUAL_DIR + '/selection-' + mode + '.png' })
      await page.evaluate(() => getSelection().removeAllRanges())
    }
    await page.setViewportSize({ width: 1100, height: 850 })
  }

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

  const android = await browser.newPage()
  const androidErrors = []
  android.on('pageerror', error => androidErrors.push(error.message))
  await android.addInitScript(() => {
    window.packState = 'missing'
    window.AndroidTTS = {
      offlineOnly: () => true,
      getPackStatus: () => JSON.stringify({state:window.packState,downloaded:50,total:100}),
      downloadPack: () => { window.packState = 'downloading' },
    }
    window.__androidTtsInstalled = true
    window.offlineCalls = []
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text }
    }
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [
        { name: 'Online Japanese', lang: 'ja-JP', localService: false, default: true },
        { name: 'Offline Japanese', lang: 'ja-JP', localService: true },
        { name: 'Offline French', lang: 'fr-FR', localService: true },
      ],
      speak: utterance => {
        window.offlineCalls.push([utterance.text, utterance.lang, utterance.voice.name])
        utterance.onstart()
      },
      cancel() {},
    } })
  })
  const vocabulary = '単語と短い表現。\n\n```genui\n' + JSON.stringify({items:[
    {type:'vocabulary',word:'図書館（としょかん）',lang:'ja',phonetic:'としょかん'},
    {type:'vocabulary',word:'prendre une décision',lang:'fr'},
    {type:'vocabulary',word:'안녕하세요',lang:'ko'},
  ]}) + '\n```'
  const androidRequests = []
  await android.route('https://api.deepseek.com/v1/tools/tts', async route => {
    androidRequests.push(route.request().postDataJSON().text)
    await route.fulfill({contentType:'audio/wav',body:wav})
  })
  await seedAndBoot(android, {
    convs:[{id:'android-speech',title:'Android speech',createdAt:1,updatedAt:1,messages:[msg('vocabulary','assistant',vocabulary)]}],
    settings:{apiKey:'test-key',apiBaseUrl:'https://api.deepseek.com',lastConversationId:'android-speech'},
  })
  const cards = android.getByTestId('genui-word-card')
  await cards.nth(0).getByRole('button',{name:/朗读单词/}).click()
  await android.getByTestId('read-aloud-player').getByRole('status').filter({hasText:'下载离线语音包'}).waitFor()
  assert.deepEqual(await android.evaluate(() => window.offlineCalls), [])
  await openSettings(android, 'general')
  const download = android.getByTestId('download-offline-voice-pack')
  await download.click()
  await download.getByText('正在下载 50%').waitFor()
  await android.evaluate(() => { window.packState = 'ready' })
  await android.getByText('离线语音包已安装').waitFor()
  await android.keyboard.press('Escape')
  await cards.nth(0).getByRole('button',{name:/朗读单词/}).click()
  await cards.nth(1).getByRole('button',{name:/朗读单词/}).click()
  await cards.nth(2).getByRole('button',{name:/朗读单词/}).click()
  await android.getByTestId('read-aloud-player').getByRole('status').filter({hasText:'ko'}).waitFor()
  assert.deepEqual(androidErrors, [])
  assert.deepEqual(await android.evaluate(() => window.offlineCalls), [
    ['としょかん','ja-JP','Offline Japanese'],
    ['prendre une décision','fr-FR','Offline French'],
  ])
  assert.deepEqual(androidRequests, [], 'Android vocabulary playback does not call DeepSeek')
  await Promise.all([
    android.waitForResponse(response => response.url().endsWith('/v1/tools/tts')),
    android.getByTestId('message-read-aloud').click(),
  ])
  assert.deepEqual(androidRequests, [vocabulary], 'Android full-message playback still calls DeepSeek')
  await android.close()
  console.log('PASS Android offline vocabulary and short phrases, missing voice, and DeepSeek full-message routing')
} finally { await browser.close() }
