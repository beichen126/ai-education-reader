import assert from 'node:assert/strict'
import { prepareWebResearch, WebResearchError, webToolEndpoint } from '../src/api/deepseek-web.ts'
import { DeepSeekError } from '../src/api/deepseek.ts'

assert.equal(webToolEndpoint('https://proxy.example/custom/v1/', 'search'), 'https://proxy.example/custom/v1/tools/search')
assert.equal(webToolEndpoint('https://api.deepseek.com', 'fetch'), 'https://api.deepseek.com/v1/tools/fetch')
const original = globalThis.fetch
try {
  const requests: { url: string; body: any }[] = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    assert.equal((init?.headers as any).Authorization, 'Bearer test-only')
    return new Response(JSON.stringify(String(url).endsWith('/search') ? { results: [
      { url: 'https://example.org/a', title: 'A [title]', summary: 'summary' },
      { url: 'javascript:alert(1)', title: 'unsafe' },
      { url: 'https://example.org/a', title: 'duplicate' },
      { url: 'https://example.org/b', title: 'B', summary: 'fallback' },
    ] } : { content: 'Untrusted web body '.repeat(2000) }), { headers: { 'Content-Type': 'application/json' } })
  }
  const result = await prepareWebResearch({ baseUrl: 'https://proxy.example/v1', apiKey: 'test-only', question: '问'.repeat(200), signal: new AbortController().signal })
  assert.equal(requests.length, 3)
  assert.equal(Array.from(requests[0].body.query).length, 128)
  assert.ok(requests.every(request => request.url.startsWith('https://proxy.example/')))
  assert.ok(String(result.message.content).includes('UNTRUSTED'))
  assert.ok(String(result.message.content).length < 25000)
  assert.ok(result.footer.includes('https://example.org/a'))
  assert.ok(!result.footer.includes('javascript:'))
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Tool unavailable' } }), { status: 401 })
  await assert.rejects(prepareWebResearch({ baseUrl: 'https://proxy.example', apiKey: 'test-only', question: 'test', signal: new AbortController().signal }), error => error instanceof WebResearchError && error.message.includes('401') && error.message.includes('Tool unavailable'))
  const aborted = new AbortController(); aborted.abort()
  globalThis.fetch = async (_url, init) => { assert.ok(init?.signal?.aborted); throw new Error('aborted') }
  await assert.rejects(prepareWebResearch({ baseUrl: 'https://proxy.example', apiKey: 'test-only', question: 'test', signal: aborted.signal }), error => error instanceof DeepSeekError && error.kind === 'aborted')
  console.log('PASS web research: endpoints, provider key isolation, bounded query/content, safe sources, detailed errors and cancellation')
} finally { globalThis.fetch = original }
