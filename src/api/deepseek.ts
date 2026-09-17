// DeepSeek API adapter. Only boundary that performs fetch from the app.
import { hasMeaningfulAssistantContent } from '../engine/types'
import { tx } from '../engine/locale'

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type ApiChatMessage = { role: 'user' | 'assistant' | 'system'; content: string | ChatContentPart[] }
export type SendTextChatArgs = { apiKey: string; baseUrl: string; model: string; messages: ApiChatMessage[]; signal?: AbortSignal; reasoningEffort?: DeepSeekReasoningEffort }
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
    case 'no-api-key': return tx('未配置 API Key，请先在设置中填写。', 'No API key is configured. Add one in Settings.')
    case 'network-or-cors': return tx('网络不可用，或请求被跨域(CORS)策略拦截。', 'The network is unavailable or the request was blocked by CORS.')
    case 'unauthorized': return tx('API Key 无效（401），请检查后重试。', 'The API key is invalid (401). Check it and try again.')
    case 'billing': return tx('余额或计费问题（402），请检查账户。', 'There is a balance or billing issue (402). Check the account.')
    case 'rate-limited': return tx('请求过于频繁（429），请稍后重试。', 'Too many requests (429). Try again later.')
    case 'bad-request': return tx('请求参数错误，请检查 Base URL 与 Model。', 'The request is invalid. Check the Base URL and model.')
    case 'server': return tx('DeepSeek 服务端错误，请稍后重试。', 'The API service returned a server error. Try again later.')
    case 'bad-json': return tx('返回内容不是有效的 JSON。', 'The response is not valid JSON.')
    case 'no-content': return tx('模型未返回有效内容，请重试。', 'The model returned no usable content. Try again.')
    case 'aborted': return tx('已停止生成。', 'Generation stopped.')
    default: return tx('请求失败。', 'Request failed.')
  }
}

const DEFAULT_BASE = 'https://api.deepseek.com'

export type DeepSeekReasoningEffort = 'low' | 'high' | 'max'
export const DEFAULT_DEEPSEEK_REASONING_EFFORT: DeepSeekReasoningEffort = 'max'

function isDeepSeekRequest(baseUrl: string, model: string): boolean {
  const normalizedModel = model.trim().toLowerCase()
  if (/^deepseek(?:-|$)/.test(normalizedModel)) return true
  try {
    const hostname = new URL(baseUrl || DEFAULT_BASE).hostname.toLowerCase()
    return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/** Add DeepSeek-only defaults without leaking provider-specific fields to compatible APIs. */
export function deepSeekRequestOptions(baseUrl: string, model: string, reasoningEffort: DeepSeekReasoningEffort = DEFAULT_DEEPSEEK_REASONING_EFFORT): { reasoning_effort?: DeepSeekReasoningEffort } {
  return isDeepSeekRequest(baseUrl, model) ? { reasoning_effort: reasoningEffort } : {}
}

export async function sendTextChat(args: SendTextChatArgs): Promise<SendTextChatResult> {
  const { apiKey, baseUrl, model, messages, signal } = args
  if (!apiKey) throw new DeepSeekError('no-api-key', 'missing api key')
  const endpoint = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/chat/completions'
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, stream: false, ...deepSeekRequestOptions(baseUrl, model, args.reasoningEffort) }),
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
  if (typeof content !== 'string' || !hasMeaningfulAssistantContent(content)) throw new DeepSeekError('no-content', 'no meaningful assistant content in response')
  return { content }
}

/** Connection test: GET {baseUrl}/models (OpenAI-compatible). Sends NO chat history,
 * NO images/PDFs/user content — only the Authorization header. Verifies endpoint
 * reachability, key validity and browser CORS. */
export async function testConnection(args: { apiKey: string; baseUrl: string }): Promise<{ ok: boolean; label: string; status?: number }> {
  const { apiKey, baseUrl } = args
  if (!apiKey) return { ok: false, label: tx('请先填写 API Key。', 'Enter an API key first.') }
  const endpoint = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + '/models'
  try {
    const res = await fetch(endpoint, { method: 'GET', headers: { 'Authorization': 'Bearer ' + apiKey } })
    if (res.ok) return { ok: true, label: tx('连接成功：API 服务可访问，Key 有效。', 'Connection successful. The API is reachable and the key is valid.'), status: res.status }
    let kind: ErrorKind = 'bad-request'
    if (res.status === 401) kind = 'unauthorized'
    else if (res.status === 402) kind = 'billing'
    else if (res.status === 429) kind = 'rate-limited'
    else if (res.status >= 500) kind = 'server'
    // 404/405 on GET /models is NOT proof /chat/completions is unusable; report the distinction.
    if (res.status === 404 || res.status === 405) {
      return { ok: false, label: tx('服务可访问，但未实现 GET /models 接口。这可能不影响 /chat/completions 调用；请直接发送一条消息以确认模型可用。', 'The service is reachable but does not implement GET /models. Chat completions may still work; send a message to verify the model.'), status: res.status }
    }
    return { ok: false, label: errorKindLabel(kind) + '（HTTP ' + res.status + '）', status: res.status }
  } catch {
    return { ok: false, label: errorKindLabel('network-or-cors'), status: undefined }
  }
}
// ---- SSE streaming (browser-native fetch + ReadableStream; no third-party SSE lib) ----

/**
 * Incremental SSE parser that tolerates chunks cutting anywhere: mid UTF-8,
 * mid JSON, mid 'data:', and mid CRLF. Framing state is preserved across chunks.
 *
 * Because a CRLF line ending may be split exactly between two network chunks
 * (e.g. chunk A ends with '\r' and chunk B starts with '\n'), we never normalize
 * a chunk in isolation. Instead we buffer raw text and hold a trailing lone '\r'
 * until we can see whether the next chunk supplies the '\n' (a bare-CR ending is
 * still recognized). This makes event boundaries correct regardless of framing.
 */
export class SSEParser {
  private buf = ''
  feed(text: string): string[] {
    // Keep raw framing in the buffer. In particular, a CR at the end of one
    // network chunk plus an LF at the start of the next is ONE CRLF newline,
    // not the blank line between two SSE events.
    this.buf += text
    return this.drain()
  }
  private dataOf(block: string): string {
    return block.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  }
  private findSeparator(allowTrailingCR: boolean): { index: number; length: number } | null {
    let previousEnd = -1
    let sequenceStart = -1
    for (let index = 0; index < this.buf.length;) {
      const ch = this.buf[index]
      let length = 0
      if (ch === '\r') {
        if (index + 1 >= this.buf.length && !allowTrailingCR) return null
        length = this.buf[index + 1] === '\n' ? 2 : 1
      } else if (ch === '\n') length = 1
      else {
        previousEnd = -1
        sequenceStart = -1
        index++
        continue
      }
      if (previousEnd === index) return { index: sequenceStart, length: index + length - sequenceStart }
      sequenceStart = index
      previousEnd = index + length
      index += length
    }
    return null
  }
  private drain(allowTrailingCR = false): string[] {
    const events: string[] = []
    for (;;) {
      // One empty line terminates an event. Each line ending may independently
      // be CRLF, LF, or bare CR. The scanner consumes CRLF atomically instead of
      // allowing regexp backtracking to reinterpret it as CR + LF.
      const separator = this.findSeparator(allowTrailingCR)
      if (!separator) break
      const block = this.buf.slice(0, separator.index)
      this.buf = this.buf.slice(separator.index + separator.length)
      const data = this.dataOf(block)
      if (data) events.push(data)
    }
    return events
  }
  /** Flush any remaining trailing event when the stream ends (no trailing blank line). */
  finish(): string[] {
    const events = this.drain(true)
    const trailing = this.dataOf(this.buf)
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
  try { evt = JSON.parse(data) } catch { throw new DeepSeekError('bad-json', 'stream chunk is not valid JSON') }
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
      body: JSON.stringify({ model, messages, stream: true, ...deepSeekRequestOptions(baseUrl, model) }),
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
    if (e instanceof DeepSeekError) throw e
    throw new DeepSeekError('network-or-cors', 'stream failed')
  }
  if (!hasMeaningfulAssistantContent(content)) throw new DeepSeekError('no-content', 'no meaningful assistant content in stream')
  return { content, finishReason }
}
// ---- multimodal helpers (used by the store's message conversion; UI never builds this) ----
export type VisionCapability = 'auto' | 'supports-image' | 'text-only'
/**
 * Whether a model can accept images. With an explicit visionCapability setting the user
 * can override inference: supports-image always enables, text-only always disables, and
 * auto falls back to the model-name heuristics (a name containing 'vision'). Do not infer
 * ONLY from the model name when the user has set an explicit capability. */
export function isVisionModel(model: string, capability?: VisionCapability): boolean {
  if (capability === 'supports-image') return true
  if (capability === 'text-only') return false
  return /vision/i.test(model)
}
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
