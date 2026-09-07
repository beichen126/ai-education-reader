import type { StableId } from '../engine/types'
import type { PromptDefinition, PromptKind, PromptSnapshot } from './prompt-types'
import { promptContent } from './prompt-validation'
import { BUILTIN_PROMPT_REGISTRY, BUILTIN_PROMPT_IDS, clonePromptDefinition } from './prompt-registry'
import { getPromptPreferences } from './prompt-preferences'
import { listPromptRecords } from './prompt-store'

export type PromptResolutionDiagnostic = {
  code: 'missing' | 'disabled' | 'kind-mismatch' | 'fallback-missing' | 'fallback-disabled' | 'fallback-kind-mismatch' | 'fallback-source-mismatch'
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
  fallbackSource?: PromptDefinition['source']
  includeDisabled?: boolean
}

/**
 * The one effective catalog used by catalog UI, mode selection, and send-time
 * resolution. Built-ins remain source-owned; preferences project hidden built-ins
 * to `enabled: false` without mutating the registry or writing a shadow row.
 */
export async function listEffectivePromptDefinitions(kind?: PromptKind): Promise<PromptDefinition[]> {
  const [preferences, custom] = await Promise.all([getPromptPreferences(), listPromptRecords()])
  const hidden = new Set(preferences.hiddenBuiltinPromptIds)
  const byId = new Map<StableId, PromptDefinition>()
  for (const definition of BUILTIN_PROMPT_REGISTRY) {
    byId.set(definition.id, { ...clonePromptDefinition(definition), enabled: definition.enabled && !hidden.has(definition.id) } as PromptDefinition)
  }
  // Built-ins own their stable IDs. A malformed legacy/custom shadow row cannot
  // replace a canonical definition; Stage 4 separately rejects such rows at storage.
  for (const definition of custom) if (!byId.has(definition.id)) byId.set(definition.id, definition)
  const all = [...byId.values()]
  return kind ? all.filter((definition) => definition.kind === kind) : all
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
  let fallback = definitions.find((definition) => definition.id === fallbackId)
  if (fallback && options.expectedKind && fallback.kind !== options.expectedKind) {
    diagnostics.push({ code: 'fallback-kind-mismatch', fallbackId, message: 'fallback prompt definition kind does not match the requested scope' })
    fallback = undefined
  }
  if (fallback && options.fallbackSource && fallback.source !== options.fallbackSource) {
    diagnostics.push({ code: 'fallback-source-mismatch', fallbackId, message: 'fallback prompt definition source does not match the safe fallback contract' })
    fallback = undefined
  }
  if (fallback && !options.includeDisabled && !fallback.enabled) {
    diagnostics.push({ code: 'fallback-disabled', fallbackId, message: 'fallback prompt definition is disabled' })
    // The canonical empty conversation default is a safe transport fallback even
    // when a user hid it in the catalog. It remains hidden in UI; send resolution
    // must never fall through to a non-empty mode or crash.
    const canonical = BUILTIN_PROMPT_REGISTRY.find((definition) => definition.id === BUILTIN_PROMPT_IDS.conversationDefault)
    if (fallbackId === BUILTIN_PROMPT_IDS.conversationDefault && canonical && (!options.expectedKind || canonical.kind === options.expectedKind)) fallback = canonical
    else fallback = undefined
  }
  if (!fallback) {
    diagnostics.push({ code: 'fallback-missing', fallbackId, message: 'fallback prompt definition was not found, has the wrong kind, or is disabled' })
    return { definition: undefined, diagnostics, usedFallback: false }
  }
  return { definition: fallback, diagnostics, usedFallback: true }
}

/** Capture only values needed to explain one request; no definition reference survives. */
export function capturePromptSnapshot(definition: PromptDefinition, now: number): PromptSnapshot {
  const base = {
    profileId: definition.id,
    name: String(definition.name),
    content: String(promptContent(definition)),
    revision: definition.revision,
    source: definition.source,
    capturedAt: now,
  }
  switch (definition.kind) {
    case 'conversation-mode':
      return { ...base, kind: definition.kind }
    case 'artifact':
      return { ...base, kind: definition.kind, artifactKind: definition.artifactKind, ...(definition.protocolId ? { protocolId: definition.protocolId } : {}) }
    case 'quick-follow-up':
      return { ...base, kind: definition.kind, label: definition.label, pinned: definition.pinned, sortOrder: definition.sortOrder }
    case 'protocol':
      return {
        ...base,
        kind: definition.kind,
        protocolDomain: definition.domain,
        ...(definition.outputContract !== undefined ? { outputContract: definition.outputContract } : {}),
        ...(definition.validator ? { validator: { ...definition.validator } } : {}),
        overridePolicy: definition.overridePolicy,
        ...(definition.baseProtocolId ? { baseProtocolId: definition.baseProtocolId } : {}),
      }
    default:
      return assertNever(definition)
  }
}

function assertNever(value: never): never {
  throw new Error('Unhandled prompt definition kind: ' + String(value))
}
