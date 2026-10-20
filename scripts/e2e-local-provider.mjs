import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'vite'
import { createLocalService } from '../server/local-server.mjs'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'

// Real browser CORS/cookie test; upstream is injected in-process, never real OpenAI.
let captured
const service = createLocalService({ pairingCode: 'browser-test-code', adapter: {
  status: async () => ({ ready: true, auth: 'authorized', models: ['mock-model'], images: true }),
  stream: async request => {
    captured = request
    return new Response('data: {"type":"response.output_text.delta","delta":"mock answer"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  },
} })
let vite, browser
try {
  service.server.listen(8091, '127.0.0.1'); await once(service.server, 'listening')
  vite = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } }); await vite.listen()
  browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  process.env.E2E_BASE = 'http://127.0.0.1:5173/ai-education-reader/'
  await seedAndBoot(page, { convs: [{ id: 'local-root', title: 'Local provider test', createdAt: 1, updatedAt: 1, messages: [] }], settings: { uiLanguage: 'en', lastConversationId: 'local-root' } })
  await openSettings(page, 'api')
  const panel = page.getByTestId('local-provider-settings')
  await panel.getByRole('combobox', { name: 'Chat provider', exact: true }).selectOption('openai-local')
  await panel.locator('input[type=password]').fill('browser-test-code')
  await panel.getByRole('button', { name: 'Pair', exact: true }).click()
  await panel.getByText('Service ready.', { exact: true }).waitFor()
  await panel.getByRole('combobox', { name: 'Available account models' }).selectOption('mock-model')
  await page.waitForFunction(async () => {
    const { getSettingsSnapshot } = await import('/ai-education-reader/src/engine/settings-store.ts')
    return getSettingsSnapshot().openaiLocalModel === 'mock-model'
  })
  const result = await page.evaluate(async () => {
    const { streamLocalChat } = await import('/ai-education-reader/src/api/openai-local.ts')
    return streamLocalChat({ model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Selected page only' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }], onDelta: () => {} })
  })
  assert.equal(result.content, 'mock answer')
  assert.equal(captured.input[0].content.length, 2)
  assert.equal(captured.input[0].content[1].type, 'input_image')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('textarea[class*="composerText"]').fill('Root question without a browser API key')
  await page.keyboard.press('Enter')
  await page.getByText('mock answer', { exact: true }).first().waitFor()
  await page.waitForFunction(async () => (await import('/ai-education-reader/src/engine/sessions-store.ts')).getSessionsStatus() === 'idle')
  const branchOutcome = await page.evaluate(async () => {
    const { getConversation } = await import('/ai-education-reader/src/storage/storage.ts')
    const { createBranchFromMessage } = await import('/ai-education-reader/src/branches/branch-service.ts')
    const { runBranchReply } = await import('/ai-education-reader/src/engine/branch-thread.ts')
    const conversation = await getConversation('local-root')
    const branch = await createBranchFromMessage('local-root', conversation.messages.at(-1).id)
    return runBranchReply('local-root', branch.id, 'Branch question without a browser API key')
  })
  assert.equal(branchOutcome.kind, 'completed')
  await openSettings(page, 'api')
  // HttpOnly local session must not be exposed to page scripts.
  assert.doesNotMatch(await page.evaluate(() => document.cookie), /reader_local/)
  await page.reload({ waitUntil: 'networkidle' }); await openSettings(page, 'api')
  assert.equal(await panel.getByRole('combobox', { name: 'Chat provider', exact: true }).inputValue(), 'openai-local')
  await panel.getByRole('button', { name: 'Check local status', exact: true }).click()
  await panel.getByText('Service ready.', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Disconnect local pairing', exact: true }).click()
  await panel.getByText('Local pairing disconnected; this does not revoke OpenAI authorization.', { exact: true }).waitFor()
  await service.stop()
  await panel.getByRole('button', { name: 'Check local status', exact: true }).click()
  await panel.getByText(/OpenAI local service is unavailable/).waitFor()
  await panel.getByRole('combobox', { name: 'Chat provider', exact: true }).selectOption('deepseek')
  assert.deepEqual(errors, [])
  console.log('PASS browser: local CORS, HttpOnly pairing, UI persistence, mock text/image completion, root and branch sends without API key, disconnect and stopped-service feedback')
} finally {
  await browser?.close(); await vite?.close(); await service.stop()
}
