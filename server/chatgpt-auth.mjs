import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createCredentialVault } from './credential-vault.mjs'
import { LocalError } from './openai-contract.mjs'

const AUTH = 'https://auth.openai.com'
const API = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const requiredScopes = ['resource.invoke', 'chatgpt.tokens.use.direct']
const jwks = createRemoteJWKSet(new URL(AUTH + '/.well-known/jwks.json'), { timeoutDuration: 10000 })
const random = () => randomBytes(32).toString('base64url')
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const validClient = value => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,190}$/.test(value)

export async function verifyIdentity(token, clientId, nonce, keys = jwks) {
  const { payload } = await jwtVerify(token, keys, { issuer: AUTH, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5 })
  if (!safeEqual(payload.nonce, nonce) || typeof payload.sub !== 'string') throw new LocalError('identity_validation_failed', 401)
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0, 254) : '' }
}

export async function createChatGPTAdapter({ vault = createCredentialVault(), fetchImpl = fetch, verify = verifyIdentity, authTimeoutMs = 300000 } = {}) {
  const state = await vault.load()
  await vault.save(state) // Persist host identity before the first authorization.
  let pending = null, refreshPromise = null, catalog = null, lastError = null, stopped = false, loggingOut = false
  const active = () => state.profiles.find(profile => profile.clientId === state.activeId)
  async function request(url, init = {}, streaming = false) {
    const allowed = new URL(url)
    if (allowed.origin !== AUTH && allowed.origin !== 'https://api.openai.com') throw new LocalError('official_endpoint_required', 500)
    const signal = streaming && init.signal ? init.signal : init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    try { return await fetchImpl(url, { ...init, signal, redirect: 'error' }) }
    catch { throw new LocalError(signal.aborted ? 'request_cancelled' : 'openai_network_unavailable', 503) }
  }
  async function tokenRequest(parameters) {
    const response = await request(AUTH + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters.toString() })
    if (!response.ok) { await response.body?.cancel(); throw new LocalError(response.status === 400 || response.status === 401 ? 'authorization_expired' : 'token_exchange_failed', 401) }
    const tokens = await response.json()
    if (typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.token_type?.toLowerCase() !== 'bearer') throw new LocalError('invalid_token_response', 502)
    return tokens
  }
  const scopesOf = value => typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
  function checkScopes(scopes) { if (!requiredScopes.every(scope => scopes.includes(scope))) throw new LocalError('subscription_scope_missing', 403) }
  async function accessToken() {
    if (stopped || loggingOut) throw new LocalError('service_stopping', 503)
    let profile = active()
    if (!profile?.accessToken) throw new LocalError('authorization_not_verified', 401)
    checkScopes(profile.scopes)
    if (profile.expiresAt > Date.now() + 60000) return profile.accessToken
    if (!profile.refreshToken) throw new LocalError('authorization_expired', 401)
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const current = profile
        const tokens = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, resource: API }))
        const scopes = tokens.scope === undefined ? current.scopes : scopesOf(tokens.scope)
        checkScopes(scopes)
        if (active() !== current || stopped) throw new LocalError('authorization_changed', 409)
        Object.assign(current, { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : current.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000, scopes })
        await vault.save(state)
        return current.accessToken
      })().finally(() => { refreshPromise = null })
    }
    return refreshPromise
  }
  async function models(force = false) {
    const profile = active()
    if (!force && catalog?.clientId === profile?.clientId && catalog.expires > Date.now()) return catalog.entries
    const token = await accessToken()
    const response = await request(API + '/models', { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) { await response.body?.cancel(); throw new LocalError(response.status === 401 ? 'authorization_expired' : 'model_discovery_failed', 502) }
    const body = await response.json()
    if (!Array.isArray(body.models)) throw new LocalError('invalid_model_catalog', 502)
    const entries = body.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(model.slug)).slice(0, 100)
      .map(model => ({ slug: model.slug, displayName: typeof model.display_name === 'string' ? model.display_name.slice(0, 200) : model.slug,
        images: Array.isArray(model.input_modalities) && model.input_modalities.includes('image') }))
    if (active() !== profile) throw new LocalError('authorization_changed', 409)
    catalog = { clientId: profile.clientId, expires: Date.now() + 60000, entries }
    return entries
  }
  async function status() {
    const profile = active()
    let entries = []
    if (profile?.accessToken && !pending && !loggingOut) {
      try { entries = await models(); lastError = null } catch (error) { lastError = error instanceof LocalError ? error.code : 'model_discovery_failed' }
    }
    const authorized = !loggingOut && !!profile?.accessToken && requiredScopes.every(scope => profile.scopes?.includes(scope))
    return { ready: authorized && entries.length > 0 && !lastError && !pending, auth: authorized ? 'authorized' : 'authorization-not-verified',
      login: pending ? 'pending' : lastError ? 'error' : authorized ? 'authorized' : 'signed-out', errorCode: lastError,
      email: profile?.email || '', models: entries.map(model => model.slug), modelLabels: entries,
      imageModels: entries.filter(model => model.images).map(model => model.slug),
      images: entries.some(model => model.images), scopes: authorized ? profile.scopes.filter(scope => SCOPE.split(' ').includes(scope)) : [],
      accounts: state.profiles.filter(p => p.subject).map(p => ({ id: p.clientId, email: p.email || '', active: p.clientId === state.activeId })) }
  }
  async function beginLogin({ newAccount = false } = {}) {
    if (pending) throw new LocalError('login_already_pending', 409)
    const saved = newAccount ? null : active() || state.profiles.find(profile => profile.clientId === state.lastRegistrationId)
    const transaction = { state: random(), nonce: random(), verifier: random(), clientId: saved?.clientId, subject: saved?.subject, used: false, server: null, timer: null }
    const callback = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      const finish = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><body><p>${text}</p><p>Return to Reader / 请返回 Reader。</p></body></html>`) }
      try {
        const port = callback.address()?.port
        if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') { finish(403, 'Invalid callback'); return }
        const url = new URL(req.url, `http://127.0.0.1:${port}`)
        if (url.pathname !== '/auth/callback') { finish(404, 'Not found'); return }
        if (pending !== transaction || transaction.used || !safeEqual(url.searchParams.get('state'), transaction.state)) { finish(400, 'Invalid or expired authorization state'); return }
        transaction.used = true
        if (url.searchParams.has('error')) throw new LocalError('authorization_denied', 403)
        const returnedClient = url.searchParams.get('client_id')
        const clientId = returnedClient || transaction.clientId
        const code = url.searchParams.get('code')
        if (!validClient(clientId) || !code || (transaction.clientId && transaction.clientId !== clientId)) throw new LocalError('invalid_authorization_callback', 400)
        // Keep issued registration even if the one-use code later fails; no tokens yet.
        if (!state.profiles.some(profile => profile.clientId === clientId)) state.profiles.push({ clientId, scopes: [] })
        state.lastRegistrationId = clientId
        await vault.save(state)
        const tokens = await tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: API }))
        if (typeof tokens.id_token !== 'string') throw new LocalError('identity_validation_failed', 401)
        const identity = await verify(tokens.id_token, clientId, transaction.nonce)
        if (transaction.subject && identity.subject !== transaction.subject) throw new LocalError('account_mismatch', 401)
        const scopes = scopesOf(tokens.scope); checkScopes(scopes)
        if (stopped || pending !== transaction) throw new LocalError('authorization_changed', 409)
        const profile = { clientId, ...identity, scopes, accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null, idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000 }
        state.profiles = state.profiles.map(existing => existing.clientId === clientId ? profile : existing)
        state.activeId = clientId
        await vault.save(state)
        catalog = null; lastError = null
        finish(200, 'ChatGPT authorization received / ChatGPT 授权已接收')
      } catch (error) {
        lastError = error instanceof LocalError ? error.code : 'identity_validation_failed'
        finish(400, 'Authorization failed. Check Reader status / 授权失败，请查看 Reader 状态')
      } finally {
        // Bad unsolicited callbacks must not cancel the real pending attempt.
        if (transaction.used && pending === transaction) { clearTimeout(transaction.timer); pending = null; callback.close() }
      }
    })
    transaction.server = callback; pending = transaction; lastError = null
    try {
      await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(0, '127.0.0.1', resolve) })
      transaction.redirectUri = `http://127.0.0.1:${callback.address().port}/auth/callback`
      transaction.timer = setTimeout(() => { if (pending === transaction) { pending = null; lastError = 'authorization_timeout'; callback.closeAllConnections(); callback.close() } }, authTimeoutMs)
      transaction.timer.unref()
      const url = new URL(AUTH + '/api/accounts/authorize')
      url.search = new URLSearchParams({ client_id: saved?.clientId || 'dynamic_agent_client', ...(!saved ? { agent_name_hint: 'AI Education Reader' } : {}), ext_agent_host_id: state.hostId,
        response_type: 'code', redirect_uri: transaction.redirectUri, scope: SCOPE, resource: API, state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url') }).toString()
      return { authorizationUrl: url.toString() }
    } catch { pending = null; callback.close(); throw new LocalError('callback_listener_failed', 503) }
  }
  function cancelLogin() {
    if (pending) { clearTimeout(pending.timer); pending.server.closeAllConnections(); pending.server.close(); pending = null }
  }
  return {
    status, beginLogin, cancelLogin,
    async selectAccount(id) {
      if (pending || !state.profiles.some(p => p.clientId === id && p.subject)) throw new LocalError('account_unavailable', 409)
      state.activeId = id; catalog = null; lastError = null; await vault.save(state)
    },
    async logout() {
      loggingOut = true
      cancelLogin()
      const profile = active(); let revoked = !profile?.refreshToken
      // Drain a rotating refresh before revoking the latest token.
      if (refreshPromise) await refreshPromise.catch(() => {})
      if (profile?.refreshToken) {
        try {
          const discovery = await request(AUTH + '/.well-known/openid-configuration')
          if (!discovery.ok) throw new Error()
          const config = await discovery.json()
          const endpoint = new URL(config.revocation_endpoint)
          if (config.issuer !== AUTH || endpoint.origin !== AUTH) throw new Error()
          const response = await request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }).toString() })
          revoked = response.status === 200; await response.body?.cancel()
        } catch { revoked = false }
      }
      if (profile) { delete profile.accessToken; delete profile.refreshToken; delete profile.idToken; profile.scopes = [] }
      catalog = null; lastError = revoked ? null : 'revocation_unconfirmed'
      try { await vault.save(state) } finally { loggingOut = false }
      return { revoked }
    },
    async stream(body, signal) {
      const token = await accessToken()
      return request(API + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal }, true)
    },
    stop() { stopped = true; cancelLogin() },
  }
}
