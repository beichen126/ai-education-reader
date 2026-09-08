import type { StableId } from '../engine/types'
import type { ProtocolDomain, ProtocolPrompt, ProtocolPromptSnapshot, PromptDefinition, PromptKind, PromptSnapshot } from './prompt-types'
import { promptContent } from './prompt-validation'
import { BUILTIN_PROMPT_REGISTRY, BUILTIN_PROMPT_IDS, clonePromptDefinition, getBuiltinProtocol } from './prompt-registry'
import { getPromptPreferences } from './prompt-preferences'
import { listPromptRecords } from './prompt-store'
import { resolveProtocolCanonicalRoot } from './protocol-lineage'

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

export type ProtocolResolutionDiagnostic = {
  code: 'missing-canonical' | 'invalid-override' | 'override-missing' | 'override-disabled' | 'override-domain-mismatch' | 'override-lineage-mismatch' | 'override-legacy-lineage'
  domain: ProtocolDomain
  overrideId?: StableId
  message: string
}

export type ProtocolResolutionResult = {
  definition: ProtocolPrompt | undefined
  snapshot: ProtocolPromptSnapshot | undefined
  diagnostics: ProtocolResolutionDiagnostic[]
  usedOverride: boolean
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

/**
 * Resolve one machine protocol once for a request. The returned snapshot is
 * detached from the catalog so later edits, deletes, or preference changes
 * cannot drift an in-flight multi-request AI TOC extraction.
 */
export async function resolveCurrentProtocolResult(
  domain: ProtocolDomain,
  now = Date.now(),
): Promise<ProtocolResolutionResult> {
  const canonical = getBuiltinProtocol(domain)
  if (!canonical) {
    return {
      definition: undefined,
      snapshot: undefined,
      diagnostics: [{ code: 'missing-canonical', domain, message: '没有可用的 canonical protocol' }],
      usedOverride: false,
    }
  }

  const [preferences, catalog] = await Promise.all([getPromptPreferences(), listEffectivePromptDefinitions('protocol')])
  const overrideId = preferences.activeProtocolOverrideByDomain[domain]
  if (!overrideId) {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [],
      usedOverride: false,
    }
  }

  const candidate = catalog.find((item) => item.id === overrideId)
  if (!candidate) {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [{ code: 'override-missing', domain, overrideId, message: 'active protocol override 不存在，已回退 canonical' }],
      usedOverride: false,
    }
  }
  if (candidate.kind !== 'protocol' || candidate.source !== 'experimental' || !candidate.enabled || candidate.overridePolicy !== 'experimental') {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [{ code: 'invalid-override', domain, overrideId, message: 'active protocol override 不是可启用的 experimental protocol，已回退 canonical' }],
      usedOverride: false,
    }
  }
  if (candidate.domain !== domain) {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [{ code: 'override-domain-mismatch', domain, overrideId, message: 'active protocol override domain 不匹配，已回退 canonical' }],
      usedOverride: false,
    }
  }
  const lineage = resolveProtocolCanonicalRoot(candidate, catalog)
  if ('message' in lineage) {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [{ code: 'override-lineage-mismatch', domain, overrideId, message: 'active protocol override lineage 无效：' + lineage.message + '，已回退 canonical' }],
      usedOverride: false,
    }
  }
  if (lineage.canonicalId !== canonical.id) {
    return {
      definition: canonical,
      snapshot: capturePromptSnapshot(canonical, now) as ProtocolPromptSnapshot,
      diagnostics: [{ code: 'override-lineage-mismatch', domain, overrideId, message: 'active protocol override lineage 的 canonical domain 不匹配，已回退 canonical' }],
      usedOverride: false,
    }
  }
  const definition = candidate as ProtocolPrompt
  return {
    definition,
    snapshot: capturePromptSnapshot(definition, now) as ProtocolPromptSnapshot,
    diagnostics: lineage.legacyChain
      ? [{ code: 'override-legacy-lineage', domain, overrideId, message: 'active protocol override 使用了历史 experimental base 链；读取时保持原始数据，不改写历史记录' }]
      : [],
    usedOverride: true,
  }
}

export async function resolveCurrentProtocol(domain: ProtocolDomain, now = Date.now()): Promise<ProtocolPromptSnapshot> {
  const result = await resolveCurrentProtocolResult(domain, now)
  if (!result.snapshot) throw new Error('当前 protocol 不可用：' + result.diagnostics.map((item) => item.code).join(', '))
  return result.snapshot
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
