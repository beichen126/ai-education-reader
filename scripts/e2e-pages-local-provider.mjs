import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { launchBrowser } from './e2e-browser.mjs'
import { createLocalService } from '../server/local-server.mjs'

// HTTPS origin is fulfilled in an isolated test context. The browser still performs
// real CORS/preflight/loopback requests; upstream inference is Mock, never billable.
let upstreamCalls = 0
const service = createLocalService({ pairingCode: 'test-pages-only', adapter: {
  status: async () => ({ ready: true, auth: 'authorized', models: ['mock-model'], imageModels: ['mock-model'], images: true }),
  stream: async request => {
    upstreamCalls++
    assert.equal(request.input[0].content[1].type, 'input_image')
    return new Response('data: {"type":"response.output_text.delta","delta":"image OK"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  },
} })
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
const endpoint = `http://127.0.0.1:${service.server.address().port}`
const browser = await launchBrowser()
try {
  const bundled = await build({ entryPoints: ['src/api/openai-local.ts'], bundle: true, write: false, format: 'iife', globalName: 'ReaderLocal', define: { 'import.meta.env.MODE': '"production"' }, plugins: [{ name: 'test-port-only', setup(builder) {
    builder.onLoad({ filter: /openai-local\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("'http://127.0.0.1:8091'", JSON.stringify(endpoint)), loader: 'ts' }))
  } }] })
  const context = await browser.newContext()
  // Permission is granted only in this disposable test context, not the user's browser.
  await context.grantPermissions(['local-network-access'], { origin: 'https://beichen126.github.io' })
  await context.route('https://beichen126.github.io/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reader transport test</title><script>' + bundled.outputFiles[0].text + '</script>' }))
  const page = await context.newPage()
  await page.goto('https://beichen126.github.io/ai-education-reader/transport-test')
  const result = await page.evaluate(async () => {
    const api = window.ReaderLocal
    let before
    try { await api.getLocalStatus() } catch (error) { before = error.code }
    await api.pairLocalService('test-pages-only')
    const status = await api.getLocalStatus()
    const reply = await api.streamLocalChat({ model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Selected page only' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }], onDelta: () => {} })
    await api.disconnectLocalService()
    let after
    try { await api.getLocalStatus() } catch (error) { after = error.code }
    return { before, ready: status.ready, content: reply.content, after, storage: Object.keys(localStorage) }
  })
  assert.deepEqual(result, { before: 'pairing_required', ready: true, content: 'image OK', after: 'pairing_required', storage: [] })
  assert.equal(upstreamCalls, 1)
  await page.reload()
  assert.equal(await page.evaluate(async () => { try { await window.ReaderLocal.getLocalStatus() } catch (error) { return error.code } }), 'pairing_required')
  await context.close()
  console.log('PASS: HTTPS Pages-origin browser pairing, real loopback CORS, image SSE completion, disconnect, memory-only connection, reload; upstream Mock')
} finally { await browser.close(); await service.stop() }
