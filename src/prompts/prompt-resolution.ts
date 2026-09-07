import type { StableId } from '../engine/types'
import type { PromptDefinition, PromptSnapshot } from './prompt-types'
import { promptContent } from './prompt-validation'
import { BUILTIN_PROMPT_REGISTRY, BUILTIN_PROMPT_IDS } from './prompt-registry'

export type PromptResolutionDiagnostic = {
  code: 'missing' | 'disabled' | 'kind-mismatch' | 'fallback-missing'
  requestedId?: StableId
  fallbackId?: StableId
  message: string
}

export type PromptResolutionResult = {
  definition: PromptDefinition | undefined
  diagnostics: PromptResolutionDiagnostic[]
  usedFallback: boolean
}

export type ResolvePromptOptions = {
  expectedKind?: PromptDefinition['kind']
  fallbackId?: StableId
  includeDisabled?: boolean
}

/** Resolve a definition without ever fabricating a prompt from its id. */
export function resolvePromptDefinition(
  id: StableId | undefined,
  definitions: readonly PromptDefinition[] = BUILTIN_PROMPT_REGISTRY,
  options: ResolvePromptOptions = {},
): PromptResolutionResult {
  const diagnostics: PromptResolutionDiagnostic[] = []
  const requested = id ? definitions.find((definition) => definition.id === id) : undefined
  let selected = requested

  if (!requested) {
    diagnostics.push({ code: 'missing', requestedId: id, message: 'prompt definition was not found' })
  } else if (options.expectedKind && requested.kind !== options.expectedKind) {
    diagnostics.push({ code: 'kind-mismatch', requestedId: id, message: 'prompt definition kind does not match the requested scope' })
    selected = undefined
  } else if (!options.includeDisabled && !requested.enabled) {
    diagnostics.push({ code: 'disabled', requestedId: id, message: 'prompt definition is disabled' })
    selected = undefined
  }

  if (selected) return { definition: selected, diagnostics, usedFallback: false }

  const fallbackId = options.fallbackId ?? BUILTIN_PROMPT_IDS.conversationDefault
  const fallback = definitions.find((definition) => definition.id === fallbackId)
  if (!fallback || (!options.includeDisabled && !fallback.enabled)) {
    diagnostics.push({ code: 'fallback-missing', fallbackId, message: 'fallback prompt definition was not found or is disabled' })
    return { definition: undefined, diagnostics, usedFallback: false }
  }
  return { definition: fallback, diagnostics, usedFallback: true }
}

/** Capture only values needed to explain one request; no definition reference survives. */
export function capturePromptSnapshot(definition: PromptDefinition, now: number): PromptSnapshot {
  return {
    profileId: definition.id,
    kind: definition.kind,
    name: String(definition.name),
    content: String(promptContent(definition)),
    revision: definition.revision,
    source: definition.source,
    capturedAt: now,
  }
}
