export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number; reasoningTokens?: number }
/** Display only: original API integer counters remain unchanged in storage. */
export function formatTokenCount(value: number): string { return (Math.round(value / 10) / 100).toFixed(2) + 'k' }
/** Accept only complete, non-negative integer counters, never estimated usage. */
export function parseTokenUsage(value: any): TokenUsage | undefined {
  const inputTokens = value?.inputTokens ?? value?.input_tokens ?? value?.prompt_tokens
  const outputTokens = value?.outputTokens ?? value?.output_tokens ?? value?.completion_tokens
  const totalTokens = value?.totalTokens ?? value?.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)) return
  const result: TokenUsage = { inputTokens, outputTokens, totalTokens }
  const extras = {
    cachedReadTokens: value.cachedReadTokens ?? value.cached_read_tokens ?? value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens,
    cachedWriteTokens: value.cachedWriteTokens ?? value.cached_write_tokens,
    reasoningTokens: value.reasoningTokens ?? value.completion_tokens_details?.reasoning_tokens,
  }
  for (const [key, count] of Object.entries(extras)) if (Number.isSafeInteger(count) && count >= 0) (result as any)[key] = count
  return result
}
