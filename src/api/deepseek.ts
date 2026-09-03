// DeepSeek API adapter. Only boundary that performs fetch from the app.
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type ApiChatMessage = { role: 'user' | 'assistant' | 'system'; content: string | ChatContentPart[] }
export type SendTextChatArgs = { apiKey: string; baseUrl: string; model: string; messages: ApiChatMessage[]; signal?: AbortSignal }
export type SendTextChatResult = { content: string }

/** DeepSeek vision API limit: max images in ONE chat request (API limit, not product). */
export const MAX_VISION_IMAGES_PER_REQUEST = 600
export function exceedsVisionImageCount(count: number): boolean { return count > MAX_VISION_IMAGES_PER_REQUEST }

export type ErrorKind =
  | 'no-api-key' | 'network-or-cors' | 'unauthorized' | 'billing'
  | 'rate-limited' | 'bad-request' | 'server' | 'bad-json' | 'no-content' | 'aborted'

export class DeepSeekError extends Error {
  readonly kind: ErrorKind; readonly status?: number
  constructor(kind: ErrorKind, message: string, status?: number) { super(message); this.kind = kind; this.status = status }
}

export function errorKindLabel(kind: ErrorKind): string {
  switch (kind) {
    case 'no-api-key': return '未配置 API Key，请先在设置中填写。'
    case 'network-or-cors': return '网络不可用，或请求被跨域(CORS)策略拦截。'
    case 'unauthorized': return 'API Key 无效（401），请检查后重试。'
    case 'billing': return '余额或计费问题（402），请检查账户。'
    case 'rate-limited': return '请求过于频繁（429），请稍后重试。'
    case 'bad-request': return '请求参数错误，请检查 Base URL 与 Model。'
    case 'server': return 'DeepSeek 服务端错误，请稍后重试。'
    case 'bad-json': return '返回内容不是有效的 JSON。'
    case 'no-content': return '返回结果中没有 assistant 文本。'
    case 'aborted': return '已停止生成。'
    default: return '请求失败。'
  }
}

const DEFAULT_BASE = 'https://api.deepseek.com'

export async function sendTextChat(args: SendTextChatArgs): Promise<SendTextChatResult> {
  const { apiKey, baseUrl, model, messages, signal } = args
  if (!apiKey) throw new DeepSeekError('no-api-key', 'missing api key')
  const endpoint = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/chat/completions'
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    })
  } catch {
    if (signal && signal.aborted) throw new DeepSeekError('aborted', 'request aborted')
    throw new DeepSeekError('network-or-cors', 'fetch failed')
  }
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = (j && j.error && typeof j.error.message === 'string') ? j.error.message : '' }
    catch { try { detail = (await res.text()).slice(0, 300) } catch {} }
    let kind: ErrorKind = 'bad-request'
    if (res.status === 401) kind = 'unauthorized'
    else if (res.status === 402) kind = 'billing'
    else if (res.status === 429) kind = 'rate-limited'
    else if (res.status >= 500) kind = 'server'
    else if (res.status >= 400) kind = 'bad-request'
    throw new DeepSeekError(kind, detail || ('http ' + res.status), res.status)
  }
  let json: any
  try { json = await res.json() } catch { throw new DeepSeekError('bad-json', 'response is not JSON') }
  const content = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : undefined
  if (typeof content !== 'string') throw new DeepSeekError('no-content', 'no assistant content in response')
  return { content }
}

/** Connection test: GET {baseUrl}/models (OpenAI-compatible). Sends NO chat history,
 * NO images/PDFs/user content — only the Authorization header. Verifies endpoint
 * reachability, key validity and browser CORS. */
export async function testConnection(args: { apiKey: string; baseUrl: string }): Promise<{ ok: boolean; label: string; status?: number }> {
  const { apiKey, baseUrl } = args
  if (!apiKey) return { ok: false, label: '请先填写 API Key。' }
  const endpoint = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/models'
  try {
    const res = await fetch(endpoint, { method: 'GET', headers: { 'Authorization': 'Bearer ' + apiKey } })
    if (res.ok) return { ok: true, label: '连接成功：API 服务可访问，Key 有效。', status: res.status }
    let kind: ErrorKind = 'bad-request'
    if (res.status === 401) kind = 'unauthorized'
    else if (res.status === 402) kind = 'billing'
    else if (res.status === 429) kind = 'rate-limited'
    else if (res.status >= 500) kind = 'server'
    return { ok: false, label: errorKindLabel(kind) + '（HTTP ' + res.status + '）', status: res.status }
  } catch {
    return { ok: false, label: errorKindLabel('network-or-cors'), status: undefined }
  }
}
// ---- SSE streaming (browser-native fetch + ReadableStream; no third-party SSE lib) ----

/** Incremental SSE parser that tolerates chunks cutting anywhere (mid UTF-8 / mid JSON / mid 'data:' / mid CRLF). */
export class SSEParser {
  private buf = ''
  feed(text: string): string[] {
    this.buf += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return this.drain()
  }
  private drain(): string[] {
    const events: string[] = []
    for (;;) {
      const sep = this.buf.indexOf('\n\n')
      if (sep === -1) break
      const block = this.buf.slice(0, sep)
      this.buf = this.buf.slice(sep + 2)
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (data) events.push(data)
    }
    return events
  }
  /** Flush any remaining trailing event when the stream ends (no trailing blank line). */
  finish(): string[] {
    const events = this.drain()
    const trailing = this.buf.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
    this.buf = ''
    if (trailing) events.push(trailing)
    return events
  }
}

export interface StreamTextChatArgs extends SendTextChatArgs { signal?: AbortSignal; onDelta: (delta: string) => void }
export interface StreamTextChatResult { content: string; finishReason?: string }

/** Extract the content delta from one SSE event payload (DeepSeek / OpenAI shape). */
function deltaOf(data: string): { delta: string; finishReason?: string } {
  let evt: any
  try { evt = JSON.parse(data) } catch { return { delta: '' } }
  const ch = evt && evt.choices && evt.choices[0] ? evt.choices[0] : undefined
  const d = ch && ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : ''
  const fr = ch && ch.finish_reason ? ch.finish_reason : undefined
  return { delta: d, finishReason: fr }
}

export async function streamTextChat(args: StreamTextChatArgs): Promise<StreamTextChatResult> {
  const { apiKey, baseUrl, model, messages, signal, onDelta } = args
  if (!apiKey) throw new DeepSeekError('no-api-key', 'missing api key')
  const endpoint = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/chat/completions'
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    })
  } catch (e) {
    if (signal && signal.aborted) throw new DeepSeekError('aborted', 'stream aborted')
    throw new DeepSeekError('network-or-cors', 'fetch failed')
  }
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = (j && j.error && typeof j.error.message === 'string') ? j.error.message : '' } catch { try { detail = (await res.text()).slice(0, 300) } catch {} }
    let kind: ErrorKind = 'bad-request'
    if (res.status === 401) kind = 'unauthorized'
    else if (res.status === 402) kind = 'billing'
    else if (res.status === 429) kind = 'rate-limited'
    else if (res.status >= 500) kind = 'server'
    else if (res.status >= 400) kind = 'bad-request'
    throw new DeepSeekError(kind, detail || ('http ' + res.status), res.status)
  }
  if (!res.body) throw new DeepSeekError('bad-json', 'no response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SSEParser()
  let content = ''
  let finishReason: string | undefined
  let done = false
  try {
    for (;;) {
      const { value, done: readDone } = await reader.read()
      if (readDone) break
      const text = decoder.decode(value, { stream: true })
      for (const data of parser.feed(text)) {
        if (data === '[DONE]') { done = true; break }
        const d = deltaOf(data)
        if (d.delta) { content += d.delta; onDelta(d.delta) }
        if (d.finishReason) finishReason = d.finishReason
      }
      if (done) break
    }
    for (const data of parser.finish()) {
      if (data === '[DONE]') { done = true; continue }
      const d = deltaOf(data)
      if (d.delta) { content += d.delta; onDelta(d.delta) }
      if (d.finishReason) finishReason = d.finishReason
    }
  } catch (e) {
    if (signal && signal.aborted) throw new DeepSeekError('aborted', 'stream aborted')
    throw new DeepSeekError('network-or-cors', 'stream failed')
  }
  return { content, finishReason }
}
// ---- multimodal helpers (used by the store's message conversion; UI never builds this) ----
export function isVisionModel(model: string): boolean { return /vision/i.test(model) }
export async function buildApiMessages(msgs: import('../engine/types').Message[], toDataUrl: (id: string) => Promise<string>): Promise<ApiChatMessage[]> {
  const out: ApiChatMessage[] = []
  for (const m of msgs) {
    if (m.role === 'assistant') { out.push({ role: 'assistant', content: m.content }); continue }
    if (m.images.length > 0) {
      // Interleave an explicit 【图片 k/N】 text identity before every image so the
      // model can count and order a large batch of unlabeled images reliably.
      const parts: ChatContentPart[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (let idx = 0; idx < m.images.length; idx++) {
        parts.push({ type: 'text', text: '【图片 ' + (idx + 1) + '/' + m.images.length + '】' })
        parts.push({ type: 'image_url', image_url: { url: await toDataUrl(m.images[idx]) } })
      }
      out.push({ role: 'user', content: parts })
    } else {
      out.push({ role: 'user', content: m.content })
    }
  }
  return out
}
/** Count image_url content parts across a message list (for the send invariant). */
export function countImageParts(msgs: ApiChatMessage[]): number {
  let n = 0
  for (const m of msgs) { if (Array.isArray(m.content)) for (const part of m.content) if (part.type === 'image_url') n++ }
  return n
}
/**
 * Image-context policy: how many trailing image-bearing user turns keep their images
 * for the NEXT request. Text history is always retained; earlier turns' images are
 * cleared so a growing conversation never re-base64s the whole attachment history.
 */
export type ImageContextPolicy = { keepRecentImageTurns: number }
export const DEFAULT_IMAGE_CONTEXT: ImageContextPolicy = { keepRecentImageTurns: 1 }

/**
 * Decide exactly which message images enter the next API request.
 * - Text of every message is kept verbatim.
 * - Only the most recent keepRecentImageTurns image-bearing user turns keep images;
 *   every earlier image-bearing turn has its images emptied (not re-encoded).
 * keepRecentImageTurns <= 0 forwards no images (text-only request).
 */
export function buildContextMessages(msgs: import('../engine/types').Message[], policy: ImageContextPolicy = DEFAULT_IMAGE_CONTEXT): import('../engine/types').Message[] {
  const imageTurnIdx: number[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user' && m.images.length > 0) imageTurnIdx.push(i)
    if (imageTurnIdx.length >= Math.max(0, policy.keepRecentImageTurns)) break
  }
  const keep = new Set<number>(policy.keepRecentImageTurns > 0 ? imageTurnIdx : [])
  return msgs.map((m, i) => (m.role === 'user' && m.images.length > 0 && !keep.has(i)) ? { ...m, images: [] } : m)
}


/** Prepend a fixed global system prompt if enabled+non-empty. Shared by text/vision/streaming paths. */
export function buildRequestMessages(apiMessages: ApiChatMessage[], settings: { customSystemPrompt: string; customSystemPromptEnabled: boolean }): ApiChatMessage[] {
  if (settings.customSystemPromptEnabled && settings.customSystemPrompt.trim()) {
    return [{ role: 'system', content: settings.customSystemPrompt.trim() }, ...apiMessages]
  }
  return apiMessages
}