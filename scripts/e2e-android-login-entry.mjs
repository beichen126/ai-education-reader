import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'
process.env.E2E_BASE ||= 'http://127.0.0.1:5173/ai-education-reader/'
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } })
  await context.addInitScript(() => {
    delete AbortSignal.any
    delete AbortSignal.timeout
    window.AndroidChatGpt = {
      status: () => JSON.stringify({ provider: 'openai-local', ready: false, auth: 'authorization-not-verified', login: 'signed-out', models: [], images: false }),
      beginLogin: () => JSON.stringify({ authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?reader_mock=1' }),
    }
    window.__androidChatGpt = { subscribeStatus: () => () => {}, subscribeChat: () => () => {} }
    window.open = url => { window.__testOpenedAuth = url; return null }
  })
  const page = await context.newPage()
  const servingOrigin = new URL(process.env.E2E_BASE).origin
  const appOrigin = 'https://appassets.androidplatform.net'
  await page.route(appOrigin + '/**', async route => {
    const response = await route.fetch({ url: route.request().url().replace(appOrigin, servingOrigin) })
    await route.fulfill({ response })
  })
  process.env.E2E_BASE = appOrigin + '/ai-education-reader/'
  let desktopRequests = 0
  await page.route('**/__reader_local/**', route => { desktopRequests++; return route.abort() })
  await seedAndBoot(page, { settings: { chatProvider: 'openai-local' } })
  await openSettings(page)
  await page.getByRole('tab', { name: 'API 配置', exact: true }).click()
  const panel = page.getByTestId('local-provider-settings')
  assert.equal(await panel.getByRole('button', { name: '配对', exact: true }).count(), 0)
  assert.equal(await panel.getByRole('checkbox').count(), 0)
  await panel.getByText(/无需配对/).first().waitFor()
  const login = panel.getByRole('button', { name: 'Continue with ChatGPT', exact: true })
  await login.waitFor(); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Continue with ChatGPT')?.disabled)
  await login.click()
  await page.waitForFunction(() => window.__testOpenedAuth?.startsWith('https://auth.openai.com/'))
  assert.equal(desktopRequests, 0)
  await panel.screenshot({ path: 'test-results/android-login-entry.png' })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('mobile-history-drawer').press('Escape')
  await page.getByTestId('composer-attach').click()
  const camera = page.getByTestId('composer-camera')
  await camera.waitFor({ state: 'visible' })
  const chooserPromise = page.waitForEvent('filechooser')
  await camera.click()
  const chooser = await chooserPromise
  assert.equal(await chooser.element().getAttribute('capture'), 'environment')
  await chooser.setFiles([])
  assert.equal(await page.locator('[data-testid="message-user"]').count(), 0)
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8
    canvas.getContext('2d').fillRect(0, 0, 8, 8)
    return canvas.toDataURL('image/jpeg').split(',')[1]
  })
  await page.getByTestId('composer-camera-input').setInputFiles({ name: 'capture.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') })
  await page.getByText('已添加 1 张图片', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-testid="message-user"]').count(), 0)
  console.log('PASS: camera entry requests rear camera, cancellation sends nothing, captured JPEG becomes a draft attachment (Mock)')
  console.log('PASS: Android native bridge shows direct sign-in, hides all pairing controls, opens official auth URL, never contacts desktop service (Mock)')
  await context.close()
} finally { await browser.close() }
