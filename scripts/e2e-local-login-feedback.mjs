import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'

// Runs against the existing local Vite server. All local API/auth requests are
// intercepted in a separate browser context: no real pairing or login is used.
process.env.E2E_BASE = 'http://127.0.0.1:5173/ai-education-reader/'
const browser = await launchBrowser()
try {
  const context = await browser.newContext()
  let paired = false, authFails = true, starts = 0
  const mockApi = async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/__reader_local/, '')
    const headers = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }
    const reply = (status, body) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
    if (path === '/pair') {
      if (request.postDataJSON().code !== 'correct-code') { await reply(403, { error: { code: 'pairing_expired' } }); return }
      paired = true; await reply(200, { paired: true }); return
    }
    if (!paired) { await reply(401, { error: { code: 'pairing_required' } }); return }
    if (path === '/auth/start') {
      starts++
      await reply(authFails ? 503 : 200, authFails ? { error: { code: 'openai_network_unavailable' } } : { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=test-only' }); return
    }
    if (path === '/auth/cancel') { await reply(200, { cancelled: true }); return }
    await reply(200, { provider: 'openai-local', ready: false, auth: 'authorization-not-verified', models: [], images: false, login: 'signed-out' })
  }
  await context.route('http://127.0.0.1:8091/**', mockApi)
  await context.route('http://127.0.0.1:5173/__reader_local/**', mockApi)
  await context.route('https://auth.openai.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Mock sign-in page; no credentials</p>' }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await seedAndBoot(page, { settings: { uiLanguage: 'zh-CN', chatProvider: 'openai-local' } })
  await openSettings(page, 'api')
  const panel = page.getByTestId('local-provider-settings'), login = panel.getByRole('button', { name: 'Continue with ChatGPT', exact: true })
  await panel.getByRole('status').getByText(/尚未连接本机服务/).waitFor()
  assert.equal(await login.isDisabled(), true)
  assert.equal(starts, 0)
  if (await panel.locator('input[type=password]').count()) {
    await panel.locator('input[type=password]').fill('expired-code')
    await panel.getByRole('button', { name: '配对', exact: true }).click()
    await panel.getByRole('status').getByText(/配对码已过期或已使用/).waitFor()
    assert.equal(await login.isDisabled(), true)
    assert.equal(context.pages().length, 1, 'unpaired flow never opens a blank popup')
    await panel.locator('input[type=password]').fill(' correct-code ')
    await panel.getByRole('button', { name: '配对', exact: true }).click()
    await panel.getByRole('status').getByText(/配对成功/).waitFor()
  } else {
    paired = true
    await panel.getByRole('button', {name:'检查本机状态',exact:true}).click()
    await panel.getByRole('status').getByText(/已自动连接本机服务/).waitFor()
    await page.reload({waitUntil:'networkidle'})
    await openSettings(page,'api')
    await panel.getByRole('status').getByText(/已自动连接本机服务/).waitFor()
    assert.equal(await panel.locator('input[type=password]').count(),0,'same-origin reconnect never asks for a pairing code')
  }
  assert.equal(await login.isEnabled(), true)
  await login.click()
  await panel.getByRole('status').getByText(/本机服务无法连接 OpenAI/).waitFor()
  assert.equal(context.pages().length, 1, 'failed auth preparation never opens/closes a window')
  authFails = false
  const popupPromise = context.waitForEvent('page')
  await login.click()
  const popup = await popupPromise
  await popup.waitForURL('https://auth.openai.com/**')
  assert.ok(await panel.getByRole('link', { name: /前往 OpenAI 登录/ }).isVisible())
  assert.equal(await login.isDisabled(), true)
  await panel.getByRole('button', { name: '取消登录', exact: true }).click()
  await panel.getByRole('status').getByText('已取消登录。', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: unpaired sign-in blocked, precise expiry feedback, no transient blank popup on failure, successful URL only and fallback link')
} finally { await browser.close() }
