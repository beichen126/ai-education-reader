import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { LocalError, responsesRequest, relayResponses } from './openai-contract.mjs'

const PAGES_ORIGIN = 'https://beichen126.github.io'
const ORIGINS = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:4173', PAGES_ORIGIN])
const SESSION_MS = 8 * 60 * 60 * 1000
const MAX_BODY = 24 * 1024 * 1024
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// No live authentication adapter is installed until independent Reader authorization
// is approved and verified. Never fall back to a Platform key or Codex credentials.
const pendingAdapter = {
  status: async () => ({ ready: false, auth: 'authorization-not-verified', models: [], images: false }),
  stream: async () => { throw new LocalError('authorization_not_verified', 503) },
}

export function createLocalService({ adapter = pendingAdapter, pairingCode = randomBytes(18).toString('base64url'), requestTimeoutMs = 180000, localTransport = null } = {}) {
  let pairAvailable = true, pairFailures = 0
  const pairExpires = Date.now() + 10 * 60 * 1000
  const sessions = new Map(), controllers = new Set()
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  async function readJson(req, limit = MAX_BODY) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new LocalError('json_required', 415)
    if (Number(req.headers['content-length']) > limit) throw new LocalError('request_too_large', 413)
    const chunks = []; let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new LocalError('request_too_large', 413)
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new LocalError('invalid_json') }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const address = server.address()
    const expectedHost = `127.0.0.1:${typeof address === 'object' && address ? address.port : 8091}`
    try {
      if (req.headers.host !== expectedHost) throw new LocalError('invalid_host', 403)
      const origin = req.headers.origin
      // Exact origins only, including the maintained Pages origin (never *.github.io).
      if (!ORIGINS.has(origin)) throw new LocalError('origin_denied', 403)
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      if (req.method === 'OPTIONS') {
        if (!['GET', 'POST'].includes(req.headers['access-control-request-method'])) throw new LocalError('method_denied', 405)
        const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean)
        if (headers.some(header => !['content-type', 'x-reader-session'].includes(header))) throw new LocalError('header_denied', 403)
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true')
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Reader-Session' }); res.end(); return
      }
      if (req.url === '/health' && req.method === 'GET') { json(res, 200, { service: 'reader-local', version: 1 }); return }
      if (req.url === '/pair' && req.method === 'POST') {
        if (!pairAvailable || Date.now() > pairExpires || pairFailures >= 5) throw new LocalError('pairing_expired', 403)
        const body = await readJson(req, 1024)
        if (!pairAvailable || Date.now() > pairExpires || pairFailures >= 5) throw new LocalError('pairing_expired', 403)
        if (!equal(body?.code, pairingCode)) { pairFailures++; throw new LocalError('pairing_rejected', 403) }
        pairAvailable = false
        const token = randomBytes(32).toString('base64url')
        sessions.set(token, { expiresAt: Date.now() + SESSION_MS, origin })
        // Cross-site cookies are unreliable and needlessly expose ambient authority.
        // This is a short-lived Reader pairing capability, NOT an OpenAI token.
        if (origin === PAGES_ORIGIN) { json(res, 200, { paired: true, session: token }); return }
        res.setHeader('Set-Cookie', `reader_local=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`)
        json(res, 200, { paired: true }); return
      }
      for (const [key, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(key)
      const session = origin === PAGES_ORIGIN ? req.headers['x-reader-session'] : /(?:^|;\s*)reader_local=([A-Za-z0-9_-]+)(?:;|$)/.exec(req.headers.cookie || '')?.[1]
      const trustedProxy = localTransport && localTransport.expiresAt > Date.now() && origin === 'http://127.0.0.1:5173' && equal(req.headers['x-reader-local-transport'], localTransport.key)
      if (!trustedProxy && (!session || sessions.get(session)?.origin !== origin)) throw new LocalError('pairing_required', 401)
      if (req.url === '/disconnect' && req.method === 'POST') {
        if (session) sessions.delete(session)
        for (const controller of controllers) controller.abort()
        res.setHeader('Set-Cookie', 'reader_local=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        json(res, 200, { paired: false }); return
      }
      if (req.url === '/auth/start' && req.method === 'POST') {
        if (!adapter.beginLogin) throw new LocalError('authorization_not_verified', 503)
        const body = await readJson(req, 1024)
        json(res, 200, await adapter.beginLogin({ newAccount: body.newAccount === true })); return
      }
      if (req.url === '/auth/cancel' && req.method === 'POST') {
        adapter.cancelLogin?.(); json(res, 200, { cancelled: true }); return
      }
      if (req.url === '/auth/logout' && req.method === 'POST') {
        if (!adapter.logout) throw new LocalError('authorization_not_verified', 503)
        for (const controller of controllers) controller.abort()
        json(res, 200, await adapter.logout()); return
      }
      if (req.url === '/auth/account' && req.method === 'POST') {
        const body = await readJson(req, 1024)
        if (!adapter.selectAccount || typeof body.id !== 'string') throw new LocalError('account_unavailable', 400)
        for (const controller of controllers) controller.abort()
        await adapter.selectAccount(body.id); json(res, 200, { selected: true }); return
      }
      if (req.url === '/status' && req.method === 'GET') {
        const status = await adapter.status()
        // Explicit allowlist: adapters must never leak credentials through status.
        json(res, 200, { provider: 'openai-local', ready: status.ready === true && status.auth === 'authorized', auth: status.auth === 'authorized' ? 'authorized' : 'authorization-not-verified', images: status.images === true,
          login: ['pending', 'authorized', 'error', 'signed-out'].includes(status.login) ? status.login : 'signed-out',
          errorCode: typeof status.errorCode === 'string' && /^[a-z_]{1,80}$/.test(status.errorCode) ? status.errorCode : null,
          email: typeof status.email === 'string' ? status.email.slice(0, 254) : '',
          scopes: Array.isArray(status.scopes) ? status.scopes.filter(scope => ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'].includes(scope)) : [],
          accounts: Array.isArray(status.accounts) ? status.accounts.slice(0, 50).filter(account => typeof account.id === 'string' && typeof account.email === 'string').map(account => ({ id: account.id, email: account.email.slice(0, 254), active: account.active === true })) : [],
          imageModels: Array.isArray(status.imageModels) ? status.imageModels.filter(model => typeof model === 'string' && status.models?.includes(model)).slice(0, 100) : [],
          modelLabels: Array.isArray(status.modelLabels) ? status.modelLabels.slice(0, 100).filter(model => typeof model.slug === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(model.slug) && typeof model.displayName === 'string').map(model => ({ slug: model.slug, displayName: model.displayName.slice(0, 200) })) : [],
          models: Array.isArray(status.models) ? status.models.filter(m => typeof m === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(m)).slice(0, 100) : [] }); return
      }
      if (req.url === '/chat' && req.method === 'POST') {
        if (controllers.size >= 2) throw new LocalError('service_busy', 429)
        const controller = new AbortController()
        controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
        const abort = () => { if (!res.writableFinished) controller.abort() }
        res.on('close', abort); req.on('aborted', abort)
        try {
          const request = responsesRequest(await readJson(req))
          if (controller.signal.aborted) throw new LocalError('request_cancelled', 408)
          const status = await adapter.status()
          if (controller.signal.aborted) throw new LocalError('request_cancelled', 408)
          if (!status.ready || status.auth !== 'authorized') throw new LocalError('authorization_not_verified', 503)
          if (!status.models.includes(request.model)) throw new LocalError('model_unavailable', 400)
          if (!status.imageModels?.includes(request.model) && request.input.some(m => m.content.some(p => p.type === 'input_image'))) throw new LocalError('vision_unsupported')
          const upstream = await adapter.stream(request, controller.signal)
          if (!upstream.ok) throw new LocalError(upstream.status === 401 ? 'authorization_expired' : upstream.status === 429 ? 'quota_or_rate_limit' : 'upstream_failed', 502)
          // The official subscription route can omit Content-Type while returning
          // valid Responses SSE. A missing header is not evidence of a non-stream.
          // Keep rejecting explicit incompatible types and validate the actual
          // event framing/terminal event below; never treat JSON/HTML as success.
          const upstreamType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
          if (upstreamType && upstreamType !== 'text/event-stream') {
            await upstream.body?.cancel()
            throw new LocalError('invalid_stream_type', 502)
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' })
          const emit = async event => {
            if (controller.signal.aborted) throw new LocalError('request_cancelled', 408)
            if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: controller.signal })
          }
          await relayResponses(upstream.body, emit)
          res.end()
        } catch (error) {
          if (res.headersSent) { if (!res.destroyed) res.end(`data: ${JSON.stringify({ type: 'error', code: controller.signal.aborted ? 'request_cancelled' : error instanceof LocalError ? error.code : 'upstream_failed' })}\n\n`) }
          else throw controller.signal.aborted ? new LocalError('request_cancelled', 408) : error
        } finally { clearTimeout(timer); controllers.delete(controller); res.off('close', abort); req.off('aborted', abort) }
        return
      }
      throw new LocalError('not_found', 404)
    } catch (error) {
      if (!res.destroyed) json(res, error instanceof LocalError ? error.status : 503, { error: { code: error instanceof LocalError ? error.code : 'service_unavailable' } })
    }
  })
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 32
  server.maxConnections = 32
  server.on('close', () => { for (const controller of controllers) controller.abort(); sessions.clear(); adapter.stop?.() })
  return { server, pairingCode, stop: async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)) } }
}
