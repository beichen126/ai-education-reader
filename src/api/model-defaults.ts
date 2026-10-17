export const DEFAULT_MODEL = 'deepseek-flash'

/** Upgrade the retired official default only. Never rewrite a custom provider's
 * alias or an explicitly selected different model during settings/backup reads. */
export function resolveStoredModel(model: unknown, baseUrl: unknown): string {
  if (typeof model !== 'string' || !model.trim()) return DEFAULT_MODEL
  let official = false
  try { official = new URL(typeof baseUrl === 'string' && baseUrl ? baseUrl : 'https://api.deepseek.com').hostname.toLowerCase() === 'api.deepseek.com' } catch { /* preserve custom input */ }
  return official && model === 'deepseek-v4-flash-vision-exp' ? DEFAULT_MODEL : model
}
