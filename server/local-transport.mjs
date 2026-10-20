import { randomBytes } from 'node:crypto'
import { createCredentialVault } from './credential-vault.mjs'

export const LOCAL_READER_ORIGIN = 'http://127.0.0.1:5173'
export const LOCAL_PROXY_PATH = '/__reader_local'

// This key authenticates the local Vite process, not OpenAI. It is never returned
// to browser JS, a Vite define/env field, HTML, a log, or the repository.
export async function prepareLocalTransport(vault = createCredentialVault(undefined, 'local-transport')) {
  const state = await vault.load()
  if (typeof state.proxySecret !== 'string' || state.proxySecret.length < 40 || !(state.expiresAt > Date.now())) {
    state.proxySecret = randomBytes(48).toString('base64url')
    state.expiresAt = Date.now() + 8 * 60 * 60 * 1000
    await vault.save(state)
  }
  return { key: state.proxySecret, expiresAt: state.expiresAt }
}

export async function readLocalTransport(vault = createCredentialVault(undefined, 'local-transport')) {
  const state = await vault.load()
  if (typeof state.proxySecret !== 'string' || !(state.expiresAt > Date.now())) return null
  return { key: state.proxySecret, expiresAt: state.expiresAt }
}

export function isTrustedLocalProxyRequest(headers, method) {
  if (headers.host !== '127.0.0.1:5173' || !['GET', 'POST'].includes(method)) return false
  // Cross-site browser callers cannot forge Origin. Same-origin GETs usually
  // omit it, so require their browser-generated Referer instead.
  if (headers.origin) return headers.origin === LOCAL_READER_ORIGIN
  if (method !== 'GET' || !headers.referer) return false
  try { return new URL(headers.referer).origin === LOCAL_READER_ORIGIN } catch { return false }
}

export function readerLocalProxyPlugin() {
  return {
    name: 'reader-local-transport',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url === LOCAL_PROXY_PATH || req.url?.startsWith(LOCAL_PROXY_PATH + '/'))) return next()
        const fail = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { code } })) }
        if (!isTrustedLocalProxyRequest(req.headers, req.method)) { fail(403, 'origin_denied'); return }
        // Discard any browser-supplied transport header, always replace it from
        // protected on-disk storage in this local Node process.
        delete req.headers['x-reader-local-transport']
        try {
          const transport = await readLocalTransport()
          if (!transport) { fail(503, 'local_transport_unavailable'); return }
          req.headers['x-reader-local-transport'] = transport.key
          req.headers.origin = LOCAL_READER_ORIGIN
          next()
        } catch { fail(503, 'local_transport_unavailable') }
      })
    },
  }
}
