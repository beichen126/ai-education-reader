// Provider-neutral Reader messages -> official SIWC Responses contract.
// No credentials, URLs, tools, history lookup or file reads are accepted here.
export class LocalError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}
export function responsesRequest(body) {
  if (!body || typeof body.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(body.model)
    || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000) throw new LocalError('invalid_request')
  let images = 0
  const input = body.messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) throw new LocalError('invalid_message')
    const role = message.role === 'system' ? 'developer' : message.role
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(parts) || !parts.length) throw new LocalError('invalid_content')
    const content = parts.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
      if (part?.type === 'image_url' && role === 'user' && typeof part.image_url?.url === 'string'
        && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url)) {
        if (++images > 100) throw new LocalError('image_limit')
        return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
      }
      throw new LocalError('unsupported_content')
    })
    return { role, content }
  })
  // Do not forward DeepSeek options or arbitrary caller-supplied Responses fields.
  return { model: body.model, input, store: false, stream: true, tools: [{ type: 'web_search' }], tool_choice: 'auto' }
}

// SSE parsing tolerates CRLF, split UTF-8 and multiline data, with bounded frames.
export async function* readEvents(body) {
  if (!body) throw new LocalError('empty_stream', 502)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', ended = false
  try {
    while (!ended) {
      const next = await reader.read()
      ended = next.done
      buffer += decoder.decode(next.value, { stream: !ended })
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (frame.length > 1024 * 1024) throw new LocalError('oversized_stream_event', 502)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') {
          try { yield JSON.parse(data) } catch (error) { if (error instanceof SyntaxError) throw new LocalError('invalid_stream_json', 502); throw error }
        }
      }
      if (buffer.length > 1024 * 1024) throw new LocalError('oversized_stream_event', 502)
    }
    if (buffer.trim()) throw new LocalError('truncated_stream_event', 502)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function relayResponses(body, emit) {
  const sources = new Set()
  for await (const event of readEvents(body)) {
    const links = webCitationLinks(event, sources)
    if (links) await emit({ type: 'delta', text: links })
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') await emit({ type: 'delta', text: event.delta })
    else if (event.type === 'response.completed') { await emit({ type: 'completed' }); return }
    else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      // Never forward untrusted upstream error messages (may contain request data).
      const raw = event.response?.error?.code ?? event.code
      const code = ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'model_not_found', 'invalid_api_key'].includes(raw) ? raw : 'upstream_failed'
      throw new LocalError(code, 502)
    }
  }
  throw new LocalError('stream_incomplete', 502)
}

export function webCitationLinks(event, seen = new Set()) {
  const annotations = [event.annotation]
  for (const item of event.response?.output ?? []) {
    for (const part of item.content ?? []) annotations.push(...(part.annotations ?? []))
  }
  let result = ''
  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string' || seen.size >= 100) continue
    try {
      const url = new URL(annotation.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
      seen.add(url.href)
      result += ` [${url.hostname.replace(/[\[\]\\]/g, '')}](<${url.href.replace(/>/g, '%3E').replace(/</g, '%3C')}>)`
    } catch { /* Ignore malformed source metadata, not the answer. */ }
  }
  return result
}
