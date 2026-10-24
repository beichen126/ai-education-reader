import type { ApiChatMessage } from './deepseek'
import { tx } from '../engine/locale'
import { parseTokenUsage, type TokenUsage } from '../engine/token-usage'

const ENDPOINT = import.meta.env?.MODE === 'reader-local' ? '/__reader_local' : 'http://127.0.0.1:8091'
export const usesLocalProxy = () => import.meta.env?.MODE === 'reader-local'
export const isPagesReader = () => typeof location !== 'undefined' && location.origin === 'https://beichen126.github.io'

// ---------------------------------------------------------------------------
// Android 原生桥（F:\Android\projects\ai-education-reader）：
// App 内用 Kotlin 实现官方 SIWC 流程，替代桌面端的 127.0.0.1:8091 本机服务。
// 桥存在时所有本机 Provider 调用都走它；桌面浏览器里保持原行为不变。
// ---------------------------------------------------------------------------
type AndroidNativeBridge = {
  status(): string
  refreshStatus?(): void
  models?(): void
  beginLogin(newAccount: boolean): string
  openAuthorization(url: string): void
  cancelLogin(): void
  logout(): void
  selectAccount(id: string): void
  streamChat(requestId: string, model: string, messagesJson: string): void
  cancelChat(requestId: string): void
}
type AndroidChatEvent = { type?: string; text?: string; content?: string; code?: string; usage?: unknown }
type AndroidEventBridge = {
  subscribeStatus(listener: (status: unknown) => void): () => void
  subscribeChat(requestId: string, listener: (event: AndroidChatEvent) => void): () => void
}
function androidBridge(): { native: AndroidNativeBridge; events: AndroidEventBridge } | null {
  const host = globalThis as unknown as {
    AndroidChatGpt?: AndroidNativeBridge
    __androidChatGpt?: AndroidEventBridge
  }
  return host.AndroidChatGpt && host.__androidChatGpt
    ? { native: host.AndroidChatGpt, events: host.__androidChatGpt }
    : null
}
function isAndroidApp(): boolean {
  return typeof location !== 'undefined' && location.origin === 'https://appassets.androidplatform.net'
}

// Only the user's opt-in Reader capability is persisted. Never an OpenAI token.
const PAIRING_KEY = 'aer-local-pairing-v1'
let pagesSession = ''
let cachedStatus: { origin: string; value: LocalStatus; at: number } | null = null
let statusEpoch = 0
function savedPairing(): string {
  try { const token = localStorage.getItem(PAIRING_KEY) || ''; return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '' } catch { return '' }
}
function clearPairing() { pagesSession = ''; cachedStatus = null; statusEpoch++; try { localStorage.removeItem(PAIRING_KEY) } catch {} }
export type LocalStatus = { provider?: string; ready: boolean; auth: string; models: string[]; images: boolean; imageModels?: string[]; login?: string; errorCode?: string; email?: string; scopes?: string[]; accounts?: { id: string; email: string; active: boolean }[]; modelLabels?: { slug: string; displayName: string }[] }
export class LocalProviderError extends Error {
  constructor(readonly code: string) { super(localErrorLabel(code)); this.name = 'LocalProviderError' }
}
export function localErrorLabel(code: string): string {
  if (code === 'unsupported_country_region_territory') return tx('OpenAI 拒绝当前请求的地区或网络出口。授权凭据已保留；反复登录不能解除地区策略限制。', 'OpenAI rejected the request region or network egress. Saved credentials are retained; signing in again cannot remove a region-policy restriction.')
  if (code === 'oauth_policy_denied') return tx('OpenAI 的授权策略拒绝了请求。凭据已保留，请核实账户和应用权限，不要重复授权。', 'OpenAI policy denied the request. Credentials are retained; check account and app permissions instead of repeatedly signing in.')
  if (code === 'credential_read_failed' || code === 'credential_write_failed') return tx('无法读取或安全保存 ChatGPT 凭据。原凭据文件不会被自动清空；请检查本机安全存储。', 'Unable to read or safely save ChatGPT credentials. The original vault is not automatically cleared; check secure local storage.')
  if (code === 'android_bridge_unavailable') return tx('Android 内置登录组件未加载，请更新 APK；手机端不需要电脑配对码。', 'The Android sign-in component did not load. Update the APK; no desktop pairing code is needed.')
  if (code === 'authorization_pending') return tx('ChatGPT 登录仍在进行，请完成或取消本次登录后再发送；这不表示已有授权丢失。', 'ChatGPT sign-in is still pending. Complete or cancel it before sending; this does not mean saved authorization was lost.')
  if (code === 'pairing_remember_unavailable') return tx('请更新并重启本机服务，以支持记住配对。', 'Update and restart the local service to support remembered pairing.')
  if (code === 'pairing_storage_unavailable') return tx('浏览器阻止了配对凭证保存，本次连接可临时使用，但刷新后需要重新配对。', 'The browser blocked pairing storage. This connection works temporarily, but a reload requires pairing again.')
  if (code === 'pairing_device_limit') return tx('本机已记住的配对达到 16 个上限，请先在旧浏览器中断开配对。', 'This service already remembers 16 pairings. Disconnect an old browser first.')
  if (code === 'oauth_invalid_client') return tx('OpenAI 拒绝当前应用注册（invalid_client）。不是配对码问题，请检查应用注册状态。', 'OpenAI rejected this application registration (invalid_client). This is not a pairing-code problem; check the client registration.')
  if (/^token_endpoint_http_\d{3}$/.test(code)) {
    const status = code.slice(-3)
    return tx(`OpenAI 凭证接口返回 HTTP ${status}。`, `The OpenAI token endpoint returned HTTP ${status}. `) + (status === '403' ? tx('请求被拒绝，请检查返回策略及网络出口；重复登录未必能解决。现有凭证已保留。', 'The request was denied. Check policy and network egress; signing in repeatedly may not help. Existing credentials are retained.') : tx('这不是配对失败；请保留该错误码以便排查，现有凭证未清除。', 'This is not a pairing failure. Keep this error code for diagnosis; existing credentials have not been cleared.'))
  }
  if (code === 'vision_unsupported') return tx('所选 ChatGPT 模型未声明支持图片，请切换支持图片的模型。', 'The selected ChatGPT model does not declare image support. Choose an image-capable model.')
  if (code === 'image_limit') return tx('本次请求超过 100 张图片，请减少已选页面或图片。', 'This request exceeds 100 images. Select fewer pages or images.')
  if (code === 'request_too_large') return tx('本次请求超过本机服务的 24 MiB 上限，请减少已选页面或图片。', 'This request exceeds the local service’s 24 MiB limit. Select fewer pages or images.')
  if (code === 'local_only') return tx('本机 OpenAI 仅允许官方 Reader GitHub Pages 或受支持的本地地址。', 'Local OpenAI access is restricted to the official Reader GitHub Pages or supported local origins.')
  if (code === 'local_transport_unavailable') return tx('本机连接尚未就绪或已过期。启动/重启 npm run local:server 后点击“检查本机状态”；无需重新授权 ChatGPT。', 'Local transport is not ready or has expired. Start/restart npm run local:server and check status; no ChatGPT reauthorization needed.')
  if (code === 'pairing_required') return tx('尚未连接本机服务：填写配对码后先点“配对”，成功后才能登录 ChatGPT。', 'Not paired: enter the pairing code and click Pair before signing in with ChatGPT.')
  if (code === 'pairing_rejected') return tx('配对码不正确，请复制本次服务启动时显示的完整配对码。', 'Incorrect pairing code. Copy the complete code from the current service startup.')
  if (code === 'pairing_expired') return tx('配对码已过期或已使用，请重启本机服务获取新码；已有连接可点“检查本机状态”。', 'The pairing code expired or was already used. Restart the local service for a new code, or check local status if already paired.')
  if (code === 'authorization_not_verified') return tx('本机服务已连接，但 ChatGPT 订阅授权尚未验证，真实调用未启用。不会自动改用付费 API Key。', 'Local service connected, but ChatGPT subscription authorization is not verified. Live requests are disabled; no paid API key fallback is used.')
  if (code === 'request_cancelled') return tx('本机请求已停止或超时。', 'The local request was stopped or timed out.')
  if (code === 'subscription_scope_missing') return tx('账户未授予使用 ChatGPT 订阅的权限，请重新授权并同意订阅使用。', 'ChatGPT plan permission was not granted. Authorize again and approve plan usage.')
  if (code === 'authorization_denied') return tx('你取消了授权或未同意权限。', 'Authorization was cancelled or permission was denied.')
  if (code === 'authorization_timeout') return tx('登录已超时，请重新点击登录。', 'Sign-in timed out. Start sign-in again.')
  if (code === 'login_already_pending') return tx('已有登录正在进行，请先完成或取消。', 'Sign-in is already pending. Complete or cancel it first.')
  if (code === 'openai_network_unavailable') return tx('本机服务无法连接 OpenAI，请检查本机网络或代理设置。', 'The local service cannot reach OpenAI. Check local network or proxy settings.')
  if (code === 'identity_validation_failed' || code === 'account_mismatch') return tx('身份校验未通过，未使用返回的凭证，请重新登录。', 'Identity validation failed. Returned credentials were not activated. Sign in again.')
  if (code === 'model_discovery_failed' || code === 'invalid_model_catalog') return tx('订阅授权后获取模型列表失败，请检查网络与账户权限。', 'Unable to load models after authorization. Check connectivity and account permissions.')
  if (code === 'revocation_unconfirmed') return tx('本机凭证已清除，但远端撤销未确认；可在 ChatGPT 设置中断开应用。', 'Local credentials cleared, but remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.')
  if (code === 'stream_incomplete') return tx('OpenAI 响应未完整结束，不能视为成功。', 'The OpenAI stream ended without completion.')
  if (code === 'invalid_stream_type') return tx('OpenAI 返回了明确的非流式响应，无法继续解析；不是登录授权问题。', 'OpenAI returned an explicitly non-streaming response. This is not a sign-in authorization issue.')
  if (code === 'invalid_status') return tx('本机服务可访问，但返回的状态格式不匹配，请更新服务后检查连接。', 'The local service is reachable, but its status format does not match. Update the service and check again.')
  if (code === 'local_status_timeout') return tx('本机状态检查超时；这不代表 ChatGPT 授权丢失。请点击“检查本机状态”重试。', 'Local status check timed out; this does not mean ChatGPT authorization was lost. Check local status again.')
  if (code === 'service_unavailable') return tx('无法连接本机服务。请启动服务并允许浏览器访问本地网络；已保存的 ChatGPT 授权不会丢失。', 'Cannot reach the local service. Start it and allow browser local network access. Saved ChatGPT authorization is preserved.')
  if (code.includes('quota') || code.includes('usage_limit') || code.includes('usage_unavailable')) return tx('订阅额度或请求速率受限，请检查账户用量。', 'Subscription usage or request rate is limited. Check account usage.')
  if (code === 'model_unavailable' || code === 'model_not_found') return tx('当前账户不可使用所选模型。', 'The selected model is unavailable to this account.')
  if (code === 'authorization_expired' || code === 'invalid_api_key') return tx('本机授权已失效，需要重新授权。', 'Local authorization has expired. Authorize again.')
  const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : 'unknown_error'
  return tx('本机接口返回错误：', 'Local API returned an error: ') + safeCode + tx('。请检查状态；不代表需要重新授权。', '. Check status; this does not necessarily require reauthorization.')
}
export function isLocalReader(): boolean {
  return typeof location !== 'undefined' && (isPagesReader() || isAndroidApp() || ['http://127.0.0.1:5173', 'http://127.0.0.1:4173'].includes(location.origin))
}
async function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (isAndroidApp()) throw new LocalProviderError('android_bridge_unavailable')
  if (!isLocalReader()) throw new LocalProviderError('local_only')
  const hosted = isPagesReader()
  if (path.startsWith('/auth/') || path === '/pair' || path === '/disconnect') { cachedStatus = null; statusEpoch++ }
  if (hosted && !pagesSession) pagesSession = savedPairing()
  if (hosted && !pagesSession && path !== '/pair') throw new LocalProviderError('pairing_required')
  try {
    const headers = new Headers(init.headers)
    if (hosted && pagesSession) headers.set('X-Reader-Session', pagesSession)
    const response = await fetch(ENDPOINT + path, { ...init, headers, credentials: hosted ? 'omit' : 'include', signal: init.signal ?? AbortSignal.timeout(5000) })
    if (!response.ok) {
      cachedStatus = null
      const body = await response.json().catch(() => null)
      if (hosted && body?.error?.code === 'pairing_required') clearPairing()
      throw new LocalProviderError(typeof body?.error?.code === 'string' ? body.error.code : 'service_unavailable')
    }
    return response
  } catch (error) {
    cachedStatus = null
    if (error instanceof LocalProviderError) throw error
    if (init.signal?.aborted) throw error
    throw new LocalProviderError('service_unavailable')
  }
}
export async function getLocalStatus(signal?: AbortSignal, maxAgeMs = 0): Promise<LocalStatus> {
  if (signal?.aborted) throw signal.reason
  if (!isLocalReader()) throw new LocalProviderError('local_only')
  const bridge = androidBridge()
  if (bridge) return await androidGetStatus(bridge, signal)
  if (maxAgeMs > 0 && cachedStatus?.origin === location.origin && Date.now() - cachedStatus.at < Math.min(maxAgeMs, 15000)) return cachedStatus.value
  const timeout = AbortSignal.timeout(35000)
  const epoch = statusEpoch
  let result: any
  try { result = await (await localFetch('/status', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })).json() }
  catch (error) { cachedStatus = null; if (timeout.aborted && !signal?.aborted) throw new LocalProviderError('local_status_timeout'); throw error }
  if (result.provider !== 'openai-local' || typeof result.ready !== 'boolean' || !Array.isArray(result.models)) { cachedStatus = null; throw new LocalProviderError('invalid_status') }
  if (epoch === statusEpoch) cachedStatus = result.ready && result.auth === 'authorized' && !result.errorCode && result.login !== 'pending' ? { origin: location.origin, value: result, at: Date.now() } : null
  return result
}

// ---- Android 桥实现（App 内没有 127.0.0.1 本机服务，也没有配对码）----
function parseAndroidStatus(value: unknown): LocalStatus {
  const candidate = value as LocalStatus
  if (!candidate || typeof candidate !== 'object' || candidate.provider !== 'openai-local'
    || typeof candidate.ready !== 'boolean' || !Array.isArray(candidate.models)) {
    throw new LocalProviderError('invalid_status')
  }
  return candidate
}

async function androidGetStatus(
  bridge: { native: AndroidNativeBridge; events: AndroidEventBridge },
  signal?: AbortSignal,
): Promise<LocalStatus> {
  const initial = parseAndroidStatus(JSON.parse(bridge.native.status()))
  if (initial.ready || initial.auth !== 'authorized' || initial.login === 'pending') return initial
  return await new Promise<LocalStatus>((resolve, reject) => {
    let settled = false
    let off = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (settled) return
      settled = true; off(); clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new LocalProviderError('request_cancelled'))
    }
    const finish = (status: LocalStatus) => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(status)
    }
    const unsubscribe = bridge.events.subscribeStatus((next) => {
      try {
        const status = parseAndroidStatus(next)
        if (status.ready || status.login === 'error' || status.login === 'signed-out') finish(status)
      } catch {
        /* ignore malformed event */
      }
    })
    off = unsubscribe
    if (settled) { off(); return }
    timer = setTimeout(() => finish(initial), 8000)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    // Subscribe before requesting refresh so an immediate native event is not lost.
    try { bridge.native.refreshStatus?.() } catch { finish(initial) }
  })
}

export async function pairLocalService(code: string, signal?: AbortSignal, remember = false): Promise<void> {
  // Android App 内不存在配对码：原生桥已内建同一份授权，直接视为已连接。
  if (androidBridge()) return
  const result = await (await localFetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, remember }), signal })).json()
  if (isPagesReader()) {
    if (typeof result.session !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.session)) throw new LocalProviderError('invalid_status')
    pagesSession = result.session
    if (remember && result.remembered !== true) throw new LocalProviderError('pairing_remember_unavailable')
    try { if (remember) localStorage.setItem(PAIRING_KEY, result.session); else localStorage.removeItem(PAIRING_KEY) }
    catch { if (remember) throw new LocalProviderError('pairing_storage_unavailable') }
  }
}
export async function disconnectLocalService(signal?: AbortSignal): Promise<void> {
  if (androidBridge()) { clearPairing(); return }
  try { await localFetch('/disconnect', { method: 'POST', signal }) } finally { clearPairing() }
}
export async function beginChatGPTLogin(newAccount = false): Promise<string> {
  const bridge = androidBridge()
  if (bridge) {
    let parsed: { authorizationUrl?: string; error?: string }
    try {
      parsed = JSON.parse(bridge.native.beginLogin(newAccount))
    } catch {
      throw new LocalProviderError('invalid_authorization_callback')
    }
    if (parsed.error) throw new LocalProviderError(parsed.error)
    if (typeof parsed.authorizationUrl !== 'string') throw new LocalProviderError('invalid_authorization_callback')
    const url = new URL(parsed.authorizationUrl)
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') {
      throw new LocalProviderError('invalid_authorization_callback')
    }
    return url.href
  }
  const result = await (await localFetch('/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newAccount }) })).json()
  const url = new URL(result.authorizationUrl)
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new LocalProviderError('invalid_authorization_callback')
  return url.href
}
export async function cancelChatGPTLogin(): Promise<void> {
  const bridge = androidBridge()
  if (bridge) { bridge.native.cancelLogin(); return }
  await localFetch('/auth/cancel', { method: 'POST' })
}
export async function logoutChatGPT(): Promise<{ revoked: boolean }> {
  const bridge = androidBridge()
  if (bridge) { bridge.native.logout(); return { revoked: true } }
  return (await localFetch('/auth/logout', { method: 'POST', signal: AbortSignal.timeout(65000) })).json()
}
export async function selectChatGPTAccount(id: string): Promise<void> {
  const bridge = androidBridge()
  if (bridge) { bridge.native.selectAccount(id); return }
  await localFetch('/auth/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
}

export async function streamLocalChat(args: { model: string; messages: ApiChatMessage[]; signal?: AbortSignal; onDelta: (delta: string) => void }): Promise<{ content: string; usage?: TokenUsage }> {
  const bridge = androidBridge()
  if (bridge) return await androidStreamChat(bridge, args)
  const signal = args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
  const response = await localFetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: args.model, messages: args.messages }), signal })
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new LocalProviderError('stream_incomplete')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', content = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        if (frame.length > 1024 * 1024) throw new LocalProviderError('invalid_stream')
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n')
        if (!data) continue
        const event = JSON.parse(data)
        if (event.type === 'delta' && typeof event.text === 'string') { content += event.text; args.onDelta(event.text) }
        else if (event.type === 'completed') return { content, usage: parseTokenUsage(event.usage) }
        else if (event.type === 'error') { cachedStatus = null; throw new LocalProviderError(typeof event.code === 'string' ? event.code : 'invalid_stream') }
      }
      if (buffer.length > 1024 * 1024) throw new LocalProviderError('invalid_stream')
      if (done) throw new LocalProviderError('stream_incomplete')
    }
  } catch (error) {
    if (signal.aborted && !args.signal?.aborted) throw new LocalProviderError('request_cancelled')
    throw error
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Android 原生桥的流式对话：事件由 Kotlin 侧通过 onChatEvent 推回。 */
async function androidStreamChat(
  bridge: { native: AndroidNativeBridge; events: AndroidEventBridge },
  args: { model: string; messages: ApiChatMessage[]; signal?: AbortSignal; onDelta: (delta: string) => void },
): Promise<{ content: string; usage?: TokenUsage }> {
  const requestId = `android-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  // A timer below owns the deadline; do not require recent AbortSignal helpers
  // in Android WebView. Cancellation remains wired to the caller's signal.
  const signal = args.signal ?? new AbortController().signal
  if (signal.aborted) throw new LocalProviderError('request_cancelled')
  return await new Promise<{ content: string; usage?: TokenUsage }>((resolve, reject) => {
    let settled = false
    let content = ''
    const onAbort = () => {
      bridge.native.cancelChat(requestId)
      finish(() => reject(new LocalProviderError('request_cancelled')))
    }
    const cleanup = () => {
      off()
      clearTimeout(timer)
      signal.removeEventListener?.('abort', onAbort)
    }
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const off = bridge.events.subscribeChat(requestId, (event) => {
      if (event.type === 'delta' && typeof event.text === 'string') {
        content += event.text
        args.onDelta(event.text)
      } else if (event.type === 'completed') {
        finish(() => resolve({ content: typeof event.content === 'string' ? event.content : content, usage: parseTokenUsage(event.usage) }))
      } else if (event.type === 'error') {
        cachedStatus = null
        finish(() => reject(new LocalProviderError(typeof event.code === 'string' ? event.code : 'invalid_stream')))
      }
    })
    const timer = setTimeout(() => {
      bridge.native.cancelChat(requestId)
      finish(() => reject(new LocalProviderError('request_cancelled')))
    }, 180000)
    signal.addEventListener?.('abort', onAbort, { once: true })
    try {
      bridge.native.streamChat(requestId, args.model, JSON.stringify(args.messages))
    } catch {
      finish(() => reject(new LocalProviderError('upstream_failed')))
    }
  })
}
