import assert from 'node:assert/strict'
import { hasFirecrawlWebSearch } from '../src/api/firecrawl-web'
import { nativeConversationOptions } from '../src/api/deepseek-native'
import { apiRequestDiagnostic, DeepSeekError, streamTextChat } from '../src/api/deepseek'
import { DEFAULT_SETTINGS } from '../src/engine/settings-store'

const official = { ...DEFAULT_SETTINGS, webSearchEnabled: false, firecrawlApiKey: 'fc-fixture' }
const relay = { ...official, apiBaseUrl: 'https://relay.example/v1', nativeDeepSeekProxy: true, webSearchEnabled: true }
assert.equal(hasFirecrawlWebSearch(official), true)
assert.equal(hasFirecrawlWebSearch({ ...official, deepseekWebSearchEnabled: false, firecrawlWebSearchEnabled: false }), true)
assert.deepEqual(nativeConversationOptions(official, [], false)?.nativeTools, ['deepseek_read_url'])
assert.deepEqual(nativeConversationOptions(relay, [], false)?.nativeTools, [])
assert.equal(hasFirecrawlWebSearch(relay), true)
assert.equal(hasFirecrawlWebSearch({ ...relay, firecrawlApiKey: '' }), false)

const args = {
  apiKey: 'mock', baseUrl: relay.apiBaseUrl, model: 'mock-model',
  messages: [{ role: 'user' as const, content: 'look up the price' }],
  onDelta() {}, onWebToolCalls: async () => [{ status: 'ok', sources: ['official pricing'] }],
}
const originalFetch = globalThis.fetch
try {
  let requests = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (++requests === 1) {
      assert.equal(body.tool_choice, 'auto')
      return Response.json({ error: { message: 'Unable to complete request.' } }, { status: 400 })
    }
    assert.equal(body.tools, undefined)
    return Response.json({ choices: [{ message: { content: 'Direct answer.' } }] })
  }
  assert.equal((await streamTextChat(args)).content, 'Direct answer.')
  assert.equal(requests, 2)

  requests = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (++requests === 1) return Response.json({ error: { message: 'tool unsupported' } }, { status: 400 })
    assert.equal(body.tools, undefined)
    if (requests === 2) {
      const marker = body.messages[0].content.match(/READER_SEARCH_[a-f0-9]+/)?.[0]
      assert.ok(marker)
      return Response.json({ choices: [{ message: { content: marker + ' {"query":"Firecrawl pricing"}' } }] })
    }
    assert.match(body.messages.at(-1).content, /official pricing/)
    return Response.json({ choices: [{ message: { content: 'Compatible answer.' } }] })
  }
  assert.equal((await streamTextChat(args)).content, 'Compatible answer.')
  assert.equal(requests, 3)

  requests = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (++requests === 1) return Response.json({ choices: [{ message: { tool_calls: [
      { id: 'x', type: 'function', function: { name: 'search_web', arguments: '{"query":"pricing"}' } },
    ] } }] })
    if (requests === 2) {
      assert.equal(body.messages.at(-1).role, 'tool')
      return Response.json({ error: { param: 'messages[2].tool_call_id' } }, { status: 422 })
    }
    assert.equal(body.tools, undefined)
    assert.match(body.messages.at(-1).content, /official pricing/)
    return Response.json({ choices: [{ message: { content: 'Answer with evidence.' } }] })
  }
  assert.equal((await streamTextChat(args)).content, 'Answer with evidence.')
  assert.equal(requests, 3)

  globalThis.fetch = async () => Response.json({ error: { param: 'thinking', message: 'private example secret' } }, { status: 400 })
  await assert.rejects(streamTextChat({ ...args, onWebToolCalls: undefined }), error =>
    error instanceof DeepSeekError && apiRequestDiagnostic(error).includes('thinking') && !apiRequestDiagnostic(error).includes('secret'))
} finally {
  globalThis.fetch = originalFetch
}

console.log('PASS default search routing, gateway 400 recovery, safe request diagnostics')
