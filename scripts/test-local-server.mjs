import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createLocalService } from '../server/local-server.mjs'
import { responsesRequest, relayResponses, webCitationLinks } from '../server/openai-contract.mjs'
import { isTrustedLocalProxyRequest, prepareLocalTransport, readLocalTransport } from '../server/local-transport.mjs'

const origin = 'http://127.0.0.1:5173'
test('local proxy requires exact host/origin and persists a separate transport capability', async () => {
  assert.equal(isTrustedLocalProxyRequest({host:'127.0.0.1:5173',origin},'POST'),true)
  assert.equal(isTrustedLocalProxyRequest({host:'127.0.0.1:5173',referer:origin+'/ai-education-reader/'},'GET'),true)
  assert.equal(isTrustedLocalProxyRequest({host:'evil.test',origin},'GET'),false)
  assert.equal(isTrustedLocalProxyRequest({host:'127.0.0.1:5173',origin:'https://evil.test',referer:origin},'POST'),false)
  assert.equal(isTrustedLocalProxyRequest({host:'127.0.0.1:5173',referer:origin},'POST'),false)
  assert.equal(isTrustedLocalProxyRequest({host:'127.0.0.1:5173'},'GET'),false)
  let saved = {hostId:'urn:uuid:test',profiles:[]}
  const vault = {load:async()=>structuredClone(saved),save:async value=>{saved=structuredClone(value)}}
  const first=await prepareLocalTransport(vault)
  assert.deepEqual(await prepareLocalTransport(vault),first)
  assert.deepEqual(await readLocalTransport(vault),first)
  saved.expiresAt=1
  assert.equal(await readLocalTransport(vault),null)
  assert.notEqual((await prepareLocalTransport(vault)).key,first.key)
})

test('trusted local transport works without browser cookies; guessed/expired keys do not', async t => {
  const adapter={status:async()=>({ready:true,auth:'authorized',models:['mock-model'],images:false})}
  const f=await fixture(t,adapter,{localTransport:{key:'test-local-only-capability',expiresAt:Date.now()+60000}})
  assert.equal((await f.request('/status')).status,401)
  assert.equal((await f.request('/status',{headers:{'x-reader-local-transport':'wrong'}})).status,401)
  const headers={'x-reader-local-transport':'test-local-only-capability'}
  assert.equal((await f.request('/status',{headers})).status,200)
  assert.equal((await f.request('/status',{headers:{...headers,Origin:'https://evil.test'}})).status,403)
  const expired=await fixture(t,adapter,{localTransport:{key:'test-local-only-capability',expiresAt:1}})
  assert.equal((await expired.request('/status',{headers})).status,401)
})
function sse(events) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }) }
async function fixture(t, adapter, extra = {}) {
  const service = createLocalService({ adapter, pairingCode: 'test-only-pairing', ...extra })
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening')
  t.after(() => service.stop())
  const url = `http://127.0.0.1:${service.server.address().port}`
  let cookie = ''
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { Origin: origin, Cookie: cookie, ...options.headers } })
  const pair = async () => {
    const response = await request('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: service.pairingCode }) })
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  }
  return { service, url, request, pair }
}

test('loopback service: exact origins, pairing, unavailable auth and no paid fallback', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/health')).status, 200)
  assert.equal((await fetch(f.url + '/health')).status, 403)
  assert.equal((await f.request('/health', { headers: { Origin: 'https://beichen126.github.io' } })).status, 200)
  assert.equal((await f.request('/health', { headers: { Origin: 'https://other.github.io' } })).status, 403)
  assert.equal((await f.request('/health', { headers: { Origin: 'http://127.0.0.1:5173.evil.test' } })).status, 403)
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url + '/health', { headers: { Host: 'evil.test', Origin: origin } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(wrongHostStatus, 403)
  assert.equal((await f.request('/status')).status, 401)
  await f.pair()
  const status = await (await f.request('/status')).json()
  assert.equal(status.ready, false); assert.equal(status.auth, 'authorization-not-verified')
  assert.deepEqual(status.models, [])
  const response = await f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }) })
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'authorization_not_verified')
  assert.equal((await f.request('/pair', { method: 'POST' })).status, 403)
  assert.equal((await f.request('/disconnect', { method: 'POST' })).status, 200)
  assert.equal((await f.request('/status')).status, 401)
})

test('pairing console is local-navigation-only, non-embeddable and hides consumed codes', async t => {
  const f = await fixture(t)
  const response = await fetch(f.url + '/')
  assert.equal(response.status, 200)
  assert.match(await response.text(), new RegExp(f.service.pairingCode))
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal((await fetch(f.url + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await fetch(f.url + '/', { headers: { Origin: 'https://evil.test' } })).status, 403)
  assert.equal((await fetch(f.url + '/', { headers: { Origin: 'https://beichen126.github.io' } })).status, 401)
  await f.pair()
  assert.doesNotMatch(await (await fetch(f.url + '/')).text(), new RegExp(f.service.pairingCode))
})

test('Pages pairing is cookie-free, origin-bound, revocable, and requires its capability', async t => {
  const f = await fixture(t)
  const headers = { Origin: 'https://beichen126.github.io', 'Content-Type': 'application/json' }
  const preflight = await f.request('/pair', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-reader-session', 'Access-Control-Request-Private-Network': 'true' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), headers.Origin)
  assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'), 'true')
  const pair = await f.request('/pair', { method: 'POST', headers, body: JSON.stringify({ code: 'test-only-pairing' }) })
  assert.equal(pair.status, 200); assert.equal(pair.headers.get('set-cookie'), null)
  const { session } = await pair.json()
  assert.match(session, /^[A-Za-z0-9_-]{43}$/)
  assert.equal((await f.request('/status', { headers })).status, 401)
  assert.equal((await f.request('/status', { headers: { Cookie: 'reader_local=' + session } })).status, 401)
  headers['X-Reader-Session'] = session
  assert.equal((await f.request('/status', { headers })).status, 200)
  assert.equal((await f.request('/status', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403)
  assert.equal((await f.request('/disconnect', { method: 'POST', headers })).status, 200)
  assert.equal((await f.request('/status', { headers })).status, 401)
})

test('pairing attempts are bounded; preflight does not allow credentials or arbitrary headers', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"bad"}' })).status, 403)
  const expired = await f.request('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'test-only-pairing' }) })
  assert.equal((await expired.json()).error.code, 'pairing_expired')
  assert.equal((await f.request('/chat', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })).status, 204)
  assert.equal((await f.request('/chat', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } })).status, 403)
})

test('model discovery failures during chat are not misreported as missing authorization', async t => {
  const f = await fixture(t, { status: async () => ({ ready: false, auth: 'authorized', models: [], errorCode: 'openai_network_unavailable' }) })
  await f.pair()
  const r = await f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }) })
  assert.equal((await r.json()).error.code, 'openai_network_unavailable')
})

test('Responses projection preserves only supplied text/images and strips provider options', () => {
  const request = responsesRequest({ model: 'mock-model', max_output_tokens: 9999, apiKey: 'do-not-forward', messages: [
    { role: 'system', content: 'Teaching instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Selected page' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    { role: 'assistant', content: 'Earlier answer' },
  ] })
  assert.deepEqual(Object.keys(request), ['model', 'input', 'store', 'stream', 'tools', 'tool_choice'])
  assert.deepEqual(request.tools, [{ type: 'web_search' }])
  assert.equal(request.tool_choice, 'auto')
  assert.equal(request.input[0].role, 'developer')
  assert.equal(request.input[1].content[1].type, 'input_image')
  assert.equal(request.input[2].content[0].type, 'output_text')
  assert.equal(request.store, false); assert.equal(request.stream, true)
  assert.throws(() => responsesRequest({ model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] }), /unsupported_content/)
  assert.throws(() => responsesRequest({ model: 'mock-model', messages: [{ role: 'tool', content: 'x' }] }), /invalid_message/)
})

test('web search citations are clickable, deduplicated and reject unsafe URLs', async () => {
  const annotation = { type: 'url_citation', url: 'https://example.com/article' }
  const seen = new Set()
  assert.match(webCitationLinks({ annotation }, seen), /\[example.com\]\(<https:\/\/example.com\/article>\)/)
  assert.equal(webCitationLinks({ annotation }, seen), '')
  assert.equal(webCitationLinks({ annotation: { ...annotation, url: 'javascript:alert(1)' } }, seen), '')
  const events = []
  await relayResponses(sse([
    { type: 'response.output_text.delta', delta: 'Answer' },
    { type: 'response.completed', response: { output: [{ content: [{ annotations: [annotation] }] }] } },
  ]).body, event => events.push(event))
  assert.ok(events.some(e => e.type === 'delta' && e.text.includes('https://example.com/article')))
  assert.equal(events.at(-1).type, 'completed')
})

test('mock stream reaches completed; status never leaks adapter credentials', async t => {
  let captured
  const adapter = {
    status: async () => ({ ready: true, auth: 'authorized', images: true, models: ['mock-model'], access_token: 'TEST_SECRET' }),
    stream: async request => { captured = request; return sse([{ type: 'response.output_text.delta', delta: '你好' }, { type: 'response.completed' }]) },
  }
  const f = await fixture(t, adapter); await f.pair()
  assert.doesNotMatch(await (await f.request('/status')).text(), /TEST_SECRET|access_token/)
  const response = await f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }) })
  const text = await response.text()
  assert.match(text, /你好/); assert.match(text, /"type":"completed"/)
  assert.equal(captured.stream, true)
  assert.equal((await f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' })).status, 400)
})

test('images use selected-model capabilities and preserve page order', async t => {
  let captured
  const f = await fixture(t, {
    status: async () => ({ ready: true, auth: 'authorized', images: true, models: ['vision', 'text'], imageModels: ['vision'] }),
    stream: async request => { captured = request; return sse([{ type: 'response.completed' }]) },
  }); await f.pair()
  const urls = ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg==']
  const send = model => f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Only selected pages' }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] }] }) })
  assert.deepEqual((await (await f.request('/status')).json()).imageModels, ['vision'])
  const rejected = await send('text')
  assert.equal(rejected.status, 400); assert.match(await rejected.text(), /vision_unsupported/)
  assert.equal(captured, undefined)
  assert.match(await (await send('vision')).text(), /completed/)
  assert.deepEqual(captured.input[0].content.filter(p => p.type === 'input_image').map(p => p.image_url), urls)
  assert.throws(() => responsesRequest({ model: 'vision', messages: [{ role: 'user', content: Array.from({ length: 1501 }, () => ({ type: 'image_url', image_url: { url: urls[0] } })) }] }), /image_limit/)
})

test('OpenAI accepts payloads above the former local 24 MiB ceiling', async t => {
  let captured
  const f = await fixture(t, {
    status: async () => ({ready:true,auth:'authorized',models:['vision'],imageModels:['vision']}),
    stream: async request => { captured=request;return sse([{type:'response.completed'}]) },
  });await f.pair()
  const image='data:image/jpeg;base64,'+'A'.repeat(26*1024*1024)
  const response=await f.request('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'vision',messages:[{role:'user',content:[{type:'image_url',image_url:{url:image}}]}]})})
  assert.match(await response.text(),/completed/)
  assert.equal(captured.input[0].content[0].image_url.length,image.length)
  assert.equal(responsesRequest({model:'vision',messages:[{role:'user',content:Array.from({length:1500},()=>({type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}))}]}).input[0].content.length,1500)
})

test('OpenAI actual upstream 413 is distinct from authentication failure', async t => {
  const f=await fixture(t,{
    status:async()=>({ready:true,auth:'authorized',models:['vision'],imageModels:['vision']}),
    stream:async()=>new Response('{}',{status:413}),
  });await f.pair()
  const response=await f.request('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'vision',messages:[{role:'user',content:'hello'}]})})
  assert.equal((await response.json()).error.code,'upstream_request_too_large')
  assert.equal((await (await f.request('/status')).json()).auth,'authorized')
})

test('upstream incomplete, usage failures, malformed and missing terminal events are not successes', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete' }],
    [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE_DATA' } } }],
  ]) {
    const received = []
    await assert.rejects(relayResponses(sse(events).body, event => received.push(event)))
    assert.ok(!received.some(event => event.type === 'completed'))
    assert.doesNotMatch(JSON.stringify(received), /PRIVATE_DATA/)
  }
  await assert.rejects(relayResponses(new Response('data: {bad}\n\n').body, () => {}), /invalid_stream_json/)
})

test('subscription SSE without Content-Type is accepted only with a completed event', async t => {
  let variant = 'valid'
  const adapter = {
    status: async () => ({ ready: true, auth: 'authorized', images: false, models: ['mock-model'] }),
    stream: async () => {
      if (variant === 'json') return Response.json({ message: 'not a stream' })
      const text = variant === 'html' ? '<html>not SSE</html>' : 'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' + (variant === 'valid' ? 'data: {"type":"response.completed"}\n\n' : '')
      const response = new Response(new TextEncoder().encode(text))
      assert.equal(response.headers.get('content-type'), null)
      return response
    },
  }
  const f = await fixture(t, adapter); await f.pair()
  const chat = () => f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }) })
  const valid = await chat()
  assert.equal(valid.status, 200)
  assert.match(await valid.text(), /"type":"completed"/)
  variant = 'incomplete'
  const incomplete = await (await chat()).text()
  assert.match(incomplete, /stream_incomplete/)
  assert.doesNotMatch(incomplete, /"type":"completed"/)
  variant = 'html'
  const html = await (await chat()).text()
  assert.match(html, /"type":"error"/)
  assert.doesNotMatch(html, /"type":"completed"/)
  variant = 'json'
  const json = await chat()
  assert.equal(json.status, 502)
  assert.equal((await json.json()).error.code, 'invalid_stream_type')
})

test('client disconnect aborts the upstream request; service stop is deterministic', async t => {
  let startedResolve, cancelledResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const cancelled = new Promise(resolve => { cancelledResolve = resolve })
  const adapter = {
    status: async () => ({ ready: true, auth: 'authorized', models: ['mock-model'], images: false }),
    stream: async (_, signal) => new Promise((resolve, reject) => {
      startedResolve()
      signal.addEventListener('abort', () => { cancelledResolve(); reject(new Error('aborted')) }, { once: true })
    }),
  }
  const f = await fixture(t, adapter); await f.pair()
  const controller = new AbortController()
  const pending = f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal }).catch(() => null)
  await started; controller.abort(); await pending
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream not aborted')), 2000); timer.unref() })])
})

test('service deadline cancels upstream and releases capacity', async t => {
  let cancelled = false
  const adapter = {
    status: async () => ({ ready: true, auth: 'authorized', models: ['mock-model'], images: false }),
    stream: async (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('deadline')) }, { once: true })),
  }
  const f = await fixture(t, adapter, { requestTimeoutMs: 50 }); await f.pair()
  const response = await f.request('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }] }) })
  assert.equal(response.status, 408)
  assert.equal(cancelled, true)
  assert.equal((await f.request('/status')).status, 200)
})
