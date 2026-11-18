import type { SendTextChatArgs } from './deepseek'
import { parseTokenUsage } from '../engine/token-usage'
import { WEB_SEARCH_TOOL, type GeminiToolPart } from './web-search-tool'

export function isTeamoGemini(baseUrl: string, model: string): boolean {
  if (model.trim().toLowerCase() !== 'gemini-3.8-flash') return false
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && !url.port &&
      ['teamorouter.com', 'api.teamorouter.com'].includes(url.hostname) &&
      ['', '/v1'].includes(url.pathname.replace(/\/+$/, ''))
  } catch { return false }
}

type GeminiPart = GeminiToolPart | { inlineData: { mimeType: string; data: string } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }

export function teamoGeminiRequest(args: SendTextChatArgs, stream: boolean) {
  const instructions: GeminiPart[] = []
  const contents: { role: 'user' | 'model'; parts: GeminiPart[] }[] = []
  for (const message of args.messages) {
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
    const parts = content.map((part): GeminiPart => {
      if (part.type === 'text') return { text: part.text }
      const inline = part.type === 'image_url' && /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(part.image_url.url)
      if (!inline) throw new Error('Gemini requires inline Base64 images')
      return { inlineData: { mimeType: inline[1], data: inline[2] } }
    })
    if (message.role === 'system' && contents.length === 0) {
      instructions.push(...parts)
      continue
    }
    const role = message.role === 'assistant' ? 'model' : 'user'
    const previous = contents[contents.length - 1]
    if (previous?.role === role) previous.parts.push(...parts)
    else contents.push({ role, parts })
  }
  const exchange = args.webToolExchange
  if (exchange?.calls.format === 'gemini') {
    const parts = exchange.calls.parts
    contents.push({ role: 'model', parts })
    contents.push({ role: 'user', parts: parts.flatMap(part => part.functionCall ? [part.functionCall] : []).map(({ id, name }, index) => ({
      functionResponse: { ...(id ? { id } : {}), name, response: exchange.results[index] },
    })) })
  }
  return {
    endpoint: 'https://api.teamorouter.com/v1beta/models/gemini-3.8-flash:' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'),
    body: {
      contents,
      ...(instructions.length ? { systemInstruction: { parts: instructions } } : {}),
      ...(args.webSearchTool ? { tools: [{ functionDeclarations: [WEB_SEARCH_TOOL] }], toolConfig: { functionCallingConfig: { mode: exchange ? 'NONE' : 'AUTO' } } } : {}),
      generationConfig: {
        thinkingConfig: { includeThoughts: args.thinking !== 'disabled' },
        ...(args.jsonObject ? { responseMimeType: 'application/json' } : {}),
        ...(args.maxTokens ? { maxOutputTokens: args.maxTokens } : {}),
      },
    },
  }
}

export function readGeminiReply(payload: any) {
  const candidate = payload?.candidates?.[0]
  let content = '', reasoning = ''
  const parts = candidate?.content?.parts
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.text !== 'string') continue
    if (part.thought === true) reasoning += part.text
    else content += part.text
  }
  const usage = payload?.usageMetadata
  const reason = candidate?.finishReason
  return {
    content, reasoning,
    finishReason: reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : typeof reason === 'string' ? reason.toLowerCase() : undefined,
    usage: parseTokenUsage({
      inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount,
      totalTokens: usage?.totalTokenCount, cachedReadTokens: usage?.cachedContentTokenCount,
      reasoningTokens: usage?.thoughtsTokenCount,
    }),
  }
}

export function readGeminiToolParts(payload: any): GeminiToolPart[] {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return []
  return parts.filter(part => part && (typeof part.text === 'string' || typeof part.functionCall?.name === 'string'))
}
