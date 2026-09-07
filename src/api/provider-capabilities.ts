/**
 * Provider facts are deliberately explicit. Prompt compilation must not infer
 * transport support from a model name: model names are user-controlled and
 * compatible providers do not share one naming convention.
 */
export type SystemMessagePolicy = 'auto' | 'interleaved' | 'flattened'
export type ResolvedSystemMessagePolicy = Exclude<SystemMessagePolicy, 'auto'>

export type ProviderCapabilities = {
  /** Whether the provider reliably accepts system messages after user/assistant history. */
  supportsInterleavedSystemMessages: boolean
}

export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  supportsInterleavedSystemMessages: false,
})

export class ProviderPromptPolicyError extends Error {
  readonly code = 'unsupported-interleaved-system'
  constructor() {
    super('当前 provider capability 不支持 interleaved system messages')
    this.name = 'ProviderPromptPolicyError'
  }
}

/** Resolve auto from explicit capability only; flattened is the safe fallback. */
export function resolveSystemMessagePolicy(
  requested: SystemMessagePolicy,
  capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES,
): ResolvedSystemMessagePolicy {
  if (requested === 'auto') return capabilities.supportsInterleavedSystemMessages ? 'interleaved' : 'flattened'
  if (requested === 'interleaved' && !capabilities.supportsInterleavedSystemMessages) throw new ProviderPromptPolicyError()
  return requested
}
