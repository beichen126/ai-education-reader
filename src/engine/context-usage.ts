export type ContextUsageMessage = {
  role: string
  content: string
  images?: readonly string[]
}

export type ContextUsage = {
  estimatedTextTokens: number
  imageCount: number
  messageCount: number
}

/**
 * Small, provider-independent estimate for the context indicator. CJK text generally
 * tokenizes much more densely than Latin text, so count it separately instead of using
 * the misleading `characters / 4` rule for the whole string.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** Mirrors the send path's multimodal policy: all text stays in the path, while only
 * the newest image-bearing turn is sent. Pending draft images take precedence. */
export function estimateContextUsage(input: {
  messages: readonly ContextUsageMessage[]
  draftText?: string
  draftImageIds?: readonly string[]
  promptTexts?: readonly string[]
  systemPrompt?: string
}): ContextUsage {
  const pieces = [
    ...(input.systemPrompt ? [input.systemPrompt] : []),
    ...(input.promptTexts ?? []),
    ...input.messages.map(message => message.content),
    input.draftText ?? '',
  ]
  const draftImages = input.draftImageIds ?? []
  let imageCount = draftImages.length
  if (imageCount === 0) {
    for (let index = input.messages.length - 1; index >= 0; index--) {
      if (input.messages[index].role !== 'user') continue
      const images = input.messages[index].images ?? []
      if (images.length > 0) { imageCount = images.length; break }
    }
  }
  return {
    estimatedTextTokens: pieces.reduce((sum, piece) => sum + estimateTextTokens(piece), 0),
    imageCount,
    messageCount: input.messages.length + ((input.draftText?.trim() || draftImages.length) ? 1 : 0),
  }
}

export function formatEstimatedTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10000) return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return Math.round(tokens / 1000) + 'K'
}
