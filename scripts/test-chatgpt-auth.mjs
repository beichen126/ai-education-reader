import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createChatGPTAdapter, verifyIdentity } from '../server/chatgpt-auth.mjs'
import { createCredentialVault } from '../server/credential-vault.mjs'

const { publicKey, privateKey } = await generateKeyPair('RS256')
const publicJwk = await exportJWK(publicKey)
const keyset = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
async function idToken(clientId, nonce, extra = {}) {
  return new SignJWT({ nonce, email: 'test@example.invalid', ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com').setSubject('test-subject').setAudience(clientId).setIssuedAt().setExpirationTime('5m').sign(privateKey)
}
function memoryVault() {
  let saved
  return { load: async () => saved ? structuredClone(saved) : { hostId: 'urn:uuid:test-host', profiles: [], activeId: null }, save: async state => { saved = structuredClone(state) }, snapshot: () => structuredClone(saved) }
}
async function setup(t, { scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', wrongNonce = false, tokenStatus = 200 } = {}) {
  const vault = memoryVault(), requests = []
  let authorize, refreshes = 0
  const clientId = 'oaiapp_test_reader'
  const adapter = await createChatGPTAdapter({ vault, verify: (token, audience, nonce) => verifyIdentity(token, audience, nonce, keyset), fetchImpl: async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/api/accounts/oauth/token')) {
      if (tokenStatus !== 200) return new Response('<html>PRIVATE_DIAGNOSTIC_DO_NOT_ECHO</html>', { status: tokenStatus, headers: { 'Content-Type': 'text/html' } })
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('client_id'), clientId)
      if (body.get('grant_type') === 'refresh_token') refreshes++
      else {
        assert.equal(body.get('redirect_uri'), authorize.searchParams.get('redirect_uri'))
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'))
      }
      return Response.json({ access_token: 'test-access-only', refresh_token: 'test-refresh-only', token_type: 'Bearer', expires_in: 3600, scope, id_token: await idToken(clientId, wrongNonce ? 'wrong-nonce' : authorize.searchParams.get('nonce')) })
    }
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list', input_modalities: ['text', 'image'] }, { slug: 'hidden-model', visibility: 'hidden', input_modalities: ['image'] }] })
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/test-revoke' })
    if (url.endsWith('/test-revoke')) return new Response(null, { status: 200 })
    if (url.endsWith('/responses')) return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error('unexpected endpoint')
  } })
  t.after(() => adapter.stop())
  async function start() { authorize = new URL((await adapter.beginLogin()).authorizationUrl); return authorize }
  async function callback(overrides = {}) {
    const url = new URL(authorize.searchParams.get('redirect_uri'))
    url.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'test-code', client_id: clientId, ...overrides }).toString()
    return fetch(url)
  }
  return { adapter, vault, start, callback, requests, refreshes: () => refreshes }
}

test('real JWT verification rejects wrong nonce/audience/signature', async () => {
  const token = await idToken('reader-test', 'nonce-test')
  assert.equal((await verifyIdentity(token, 'reader-test', 'nonce-test', keyset)).subject, 'test-subject')
  await assert.rejects(verifyIdentity(token, 'wrong-audience', 'nonce-test', keyset))
  await assert.rejects(verifyIdentity(token, 'reader-test', 'wrong-nonce', keyset))
})
test('independent OAuth registration validates PKCE, state, granted scopes, catalog and public endpoint', async t => {
  const f = await setup(t), url = await f.start()
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'AI Education Reader')
  assert.equal(new URL(url.searchParams.get('redirect_uri')).hostname, '127.0.0.1')
  assert.equal((await f.callback({ state: 'wrong-state' })).status, 400)
  assert.equal((await f.adapter.status()).login, 'pending')
  assert.equal(f.requests.length, 0)
  assert.equal((await f.callback()).status, 200)
  const [status] = await Promise.all([f.adapter.status(), f.adapter.status(), f.adapter.status()])
  assert.equal(f.requests.filter(request => request.url.endsWith('/models')).length, 1, 'concurrent status checks share one model discovery')
  assert.equal(status.ready, true); assert.deepEqual(status.models, ['test-model'])
  assert.equal(status.images, true); assert.deepEqual(status.imageModels, ['test-model'])
  assert.ok(status.scopes.includes('chatgpt.tokens.use.direct'))
  assert.doesNotMatch(JSON.stringify(status), /test-access-only|test-refresh-only|id_token/)
  await f.adapter.stream({ model: 'test-model', input: [], store: false, stream: true }, new AbortController().signal)
  assert.equal(f.requests.at(-1).url, 'https://api.openai.com/v1/responses')
  const next = await f.start()
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_test_reader')
  assert.equal(next.searchParams.has('agent_name_hint'), false)
  f.adapter.cancelLogin()
  assert.equal((await f.adapter.logout()).revoked, true)
  assert.equal((await f.adapter.status()).ready, false)
  assert.equal(f.vault.snapshot().profiles[0].accessToken, undefined)
})
test('missing actual subscription scope does not activate credentials', async t => {
  const f = await setup(t, { scope: 'openid profile email' }); await f.start()
  assert.equal((await f.callback()).status, 400)
  assert.equal((await f.adapter.status()).errorCode, 'subscription_scope_missing')
  assert.equal(f.vault.snapshot().activeId, null)
  assert.equal((await f.start()).searchParams.get('client_id'), 'oaiapp_test_reader')
})

test('callback method/host rejection preserves pending login; actual token HTTP status is visible without body leakage', async t => {
  const f = await setup(t, { tokenStatus: 403 }); const start = await f.start()
  const callback = start.searchParams.get('redirect_uri')
  const method = await fetch(callback, { method: 'POST' })
  assert.equal(method.status, 405); assert.match(await method.text(), /requires GET/)
  assert.equal((await f.adapter.status()).login, 'pending')
  const host = await new Promise((resolve, reject) => {
    const request = httpRequest(callback, { headers: { Host: 'localhost:' + new URL(callback).port } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode, text }))
    }); request.on('error', reject); request.end()
  })
  assert.equal(host.status, 403); assert.match(host.text, /host mismatch/)
  assert.equal((await f.adapter.status()).login, 'pending')
  const returned = await f.callback()
  assert.equal(returned.status, 400)
  const text = await returned.text()
  assert.match(text, /token_endpoint_http_403/); assert.doesNotMatch(text, /PRIVATE_DIAGNOSTIC/)
  assert.equal((await f.adapter.status()).errorCode, 'token_endpoint_http_403')
})
test('wrong signed nonce does not activate credentials', async t => {
  const f = await setup(t, { wrongNonce: true }); await f.start()
  assert.equal((await f.callback()).status, 400)
  assert.equal((await f.adapter.status()).ready, false)
})
test('denied authorization does not exchange a code', async t => {
  const f = await setup(t); await f.start()
  assert.equal((await f.callback({ error: 'access_denied' })).status, 400)
  assert.equal(f.requests.length, 0)
  assert.equal((await f.adapter.status()).errorCode, 'authorization_denied')
})
test('expired session refresh is serialized and never exposes rotating tokens', async t => {
  const vault = memoryVault()
  await vault.save({ hostId: 'urn:uuid:refresh-test', activeId: 'oaiapp_refresh', profiles: [{ clientId: 'oaiapp_refresh', subject: 'refresh-user', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], accessToken: 'expired-test-access', refreshToken: 'old-test-refresh', expiresAt: 1 }] })
  let refreshCount = 0
  const adapter = await createChatGPTAdapter({ vault, fetchImpl: async (url, init) => {
    if (url.endsWith('/api/accounts/oauth/token')) {
      refreshCount++
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'old-test-refresh')
      return Response.json({ access_token: 'new-test-access', refresh_token: 'rotated-test-refresh', expires_in: 3600, token_type: 'Bearer' })
    }
    return Response.json({ models: [{ slug: 'test-model', visibility: 'list' }] })
  } })
  t.after(() => adapter.stop())
  await Promise.all([adapter.status(), adapter.status(), adapter.status()])
  assert.equal(refreshCount, 1)
  assert.equal(vault.snapshot().profiles[0].refreshToken, 'rotated-test-refresh')
  assert.doesNotMatch(JSON.stringify(await adapter.status()), /new-test-access|rotated-test-refresh/)
})
test('vault roundtrip protects credentials on Windows and preserves the app host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reader-vault-test-'))
  assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
  t.after(() => rm(root, { recursive: true, force: true }))
  const vault = createCredentialVault(root), data = await vault.load()
  data.profiles.push({ clientId: 'test-only', accessToken: 'fake-token-for-storage-test' })
  await vault.save(data)
  assert.deepEqual(await vault.load(), data)
  if (process.platform === 'win32') {
    const contents = await readFile(join(root, (await readdir(root)).find(name => name.endsWith('.dpapi'))))
    assert.ok(!contents.includes(Buffer.from('fake-token-for-storage-test')))
  }
})

async function renewableFixture(t, refresh, { expiresAt = 1, vault: suppliedVault } = {}) {
  const vault = suppliedVault || memoryVault()
  if (!suppliedVault) await vault.save({ hostId: 'urn:uuid:renewal-test', activeId: 'oaiapp_saved', profiles: [{ clientId: 'oaiapp_saved', subject: 'saved-user', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt }] })
  let calls = 0, modelCalls = 0
  const adapter = await createChatGPTAdapter({ vault, fetchImpl: async (url, init) => {
    if (url.endsWith('/oauth/token')) { calls++; return refresh(init) }
    assert.ok(url.endsWith('/models'))
    modelCalls++
    if (expiresAt > 1 && init.headers.Authorization === 'Bearer old-access') return new Response(null, { status: 401 })
    return Response.json({ models: [{ slug: 'test-model', visibility: 'list' }] })
  } })
  t.after(() => adapter.stop())
  return { adapter, vault, calls: () => calls, modelCalls: () => modelCalls }
}
const renewedTokens = extra => Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, ...extra })

test('temporary and region errors preserve persisted authorization and bound refresh retries', async t => {
  for (const code of ['temporarily_unavailable', 'unsupported_country_region_territory']) {
    const f = await renewableFixture(t, () => Response.json({ error: { code, message: 'PRIVATE_BODY' } }, { status: 403 }))
    const status = await f.adapter.status()
    assert.equal(status.auth, 'authorized'); assert.equal(status.ready, false)
    assert.equal(status.errorCode, code === 'temporarily_unavailable' ? 'token_endpoint_http_403' : code)
    assert.equal(f.vault.snapshot().profiles[0].refreshToken, 'old-refresh')
    await f.adapter.status(); await f.adapter.status()
    assert.equal(f.calls(), 1)
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_BODY|old-refresh|old-access/)
  }
})
test('explicit scope removal still persists rotated refresh token; omitted scope inherits grant across restart', async t => {
  const denied = await renewableFixture(t, () => renewedTokens({ scope: '' }))
  assert.equal((await denied.adapter.status()).errorCode, 'subscription_scope_missing')
  assert.equal(denied.vault.snapshot().profiles[0].refreshToken, 'rotated-refresh')
  assert.deepEqual(denied.vault.snapshot().profiles[0].scopes, [])
  const valid = await renewableFixture(t, () => renewedTokens())
  assert.equal((await valid.adapter.status()).ready, true)
  const restarted = await renewableFixture(t, () => { throw new Error('must not refresh again') }, { vault: valid.vault })
  assert.equal((await restarted.adapter.status()).ready, true)
  assert.equal(restarted.calls(), 0)
})
test('confirmed invalid_grant clears invalid tokens but preserves registration', async t => {
  const f = await renewableFixture(t, () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
  assert.equal((await f.adapter.status()).errorCode, 'authorization_expired')
  const profile = f.vault.snapshot().profiles[0]
  assert.equal(profile.accessToken, ''); assert.equal(profile.refreshToken, null)
  assert.equal(profile.clientId, 'oaiapp_saved')
})
test('rejected access token renews once without a new OAuth login', async t => {
  const f = await renewableFixture(t, () => renewedTokens(), { expiresAt: Date.now() + 3600000 })
  assert.equal((await f.adapter.status()).ready, true)
  assert.equal(f.calls(), 1); assert.equal(f.modelCalls(), 2)
})
test('failed persistence retries saving the new rotating token before making another refresh request', async t => {
  const base = memoryVault()
  await base.save({ hostId: 'urn:uuid:write-test', activeId: 'oaiapp_saved', profiles: [{ clientId: 'oaiapp_saved', subject: 'saved-user', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }] })
  let fail = false
  const vault = { ...base, save: async state => { if (fail) { fail = false; throw new Error('disk unavailable') }; await base.save(state) } }
  const f = await renewableFixture(t, () => { fail = true; return renewedTokens() }, { vault })
  assert.equal((await f.adapter.status()).errorCode, 'credential_write_failed')
  assert.equal(base.snapshot().profiles[0].refreshToken, 'old-refresh')
  assert.equal((await f.adapter.status()).ready, true)
  assert.equal(base.snapshot().profiles[0].refreshToken, 'rotated-refresh'); assert.equal(f.calls(), 1)
})
