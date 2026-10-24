export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
/** Accept only complete, non-negative integer counters, never estimated usage. */
export function parseTokenUsage(value: any): TokenUsage | undefined {
  const inputTokens = value?.inputTokens ?? value?.input_tokens ?? value?.prompt_tokens
  const outputTokens = value?.outputTokens ?? value?.output_tokens ?? value?.completion_tokens
  const totalTokens = value?.totalTokens ?? value?.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)) return
  return { inputTokens, outputTokens, totalTokens }
}
