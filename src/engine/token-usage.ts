export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
/** Display only: original API integer counters remain unchanged in storage. */
export function formatTokenCount(value: number): string { return (Math.round(value / 10) / 100).toFixed(2) + 'k' }
/** Accept only complete, non-negative integer counters, never estimated usage. */
export function parseTokenUsage(value: any): TokenUsage | undefined {
  const inputTokens = value?.inputTokens ?? value?.input_tokens ?? value?.prompt_tokens
  const outputTokens = value?.outputTokens ?? value?.output_tokens ?? value?.completion_tokens
  const totalTokens = value?.totalTokens ?? value?.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)) return
  return { inputTokens, outputTokens, totalTokens }
}
