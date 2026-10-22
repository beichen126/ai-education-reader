import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'
process.env.E2E_BASE ||= 'http://127.0.0.1:5173/ai-education-reader/'
const browser = await launchBrowser()
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await seedAndBoot(page, { convs: [{ id: 'local-latency', title: 'Local latency test', createdAt: 1, updatedAt: 1, messages: [msg('before', 'assistant', 'Ready')] }], settings: { lastConversationId: 'local-latency', chatProvider: 'openai-local', openaiLocalModel: 'mock-model', webSearchEnabled: false } })
  let release, statusCalls = 0, chats = 0
  const gate = new Promise(resolve => { release = resolve })
  await page.route('**/__reader_local/status', async route => { statusCalls++; await gate; await route.fulfill({ json: { provider: 'openai-local', ready: true, auth: 'authorized', models: ['mock-model'], images: false } }) })
  await page.route('**/__reader_local/chat', route => { chats++; return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"Latency test OK"}\n\ndata: {"type":"completed"}\n\n' }) })
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('send once')
  await page.getByTestId('composer-send-stop').dblclick()
  await page.getByTestId('composer-send-stop').filter({ hasText: '准备中' }).waitFor()
  assert.equal(statusCalls, 1); assert.equal(chats, 0)
  assert.equal(await page.getByRole('alert').count(), 0)
  release()
  await page.getByText('Latency test OK', { exact: true }).waitFor()
  await page.getByTestId('composer-send-stop').filter({ hasText: '发送' }).waitFor()
  assert.equal(statusCalls, 1); assert.equal(chats, 1)
  assert.equal(await page.getByRole('alert').count(), 0)
  await context.close()
  console.log('PASS: real browser double-click keeps one delayed preflight, immediate Preparing state, one text stream, no false authorization error')
} finally { await browser.close() }
