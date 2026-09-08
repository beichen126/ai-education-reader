import type { StableId } from '../engine/types'
import { BUILTIN_PROMPT_REGISTRY, getBuiltinProtocol } from './prompt-registry'
import type { ProtocolPrompt, PromptDefinition } from './prompt-types'

export type ProtocolLineageIssueCode =
  | 'not-protocol'
  | 'missing-canonical'
  | 'missing-base'
  | 'cycle'
  | 'base-not-protocol'
  | 'base-domain-mismatch'
  | 'base-not-canonical'
  | 'invalid-override-policy'

export type ProtocolLineageResult =
  | { ok: true; canonicalId: StableId; path: StableId[]; legacyChain: boolean }
  | { ok: false; code: ProtocolLineageIssueCode; path: StableId[]; message: string }

function protocolCatalog(definitions: readonly PromptDefinition[]): Map<StableId, PromptDefinition> {
  const byId = new Map<StableId, PromptDefinition>()
  for (const definition of BUILTIN_PROMPT_REGISTRY) byId.set(definition.id, definition)
  for (const definition of definitions) if (!byId.has(definition.id)) byId.set(definition.id, definition)
  return byId
}

/**
 * Resolve a protocol to its source-owned canonical root without rewriting the
 * supplied object. A legacy copy-of-copy is still readable, but is marked by
 * `legacyChain` so callers can report or migrate it deterministically.
 */
export function resolveProtocolCanonicalRoot(
  definition: PromptDefinition,
  definitions: readonly PromptDefinition[] = [],
): ProtocolLineageResult {
  if (definition.kind !== 'protocol') {
    return { ok: false, code: 'not-protocol', path: [definition.id], message: '对象不是 protocol 定义' }
  }
  const canonical = getBuiltinProtocol(definition.domain)
  if (!canonical) {
    return { ok: false, code: 'missing-canonical', path: [definition.id], message: 'protocol domain 没有可用的 canonical 定义：' + definition.domain }
  }
  const byId = protocolCatalog(definitions)
  const visiting = new Set<StableId>()

  const visit = (current: ProtocolPrompt, path: StableId[], legacyChain: boolean): ProtocolLineageResult => {
    if (visiting.has(current.id)) {
      return { ok: false, code: 'cycle', path: [...path, current.id], message: 'protocol baseProtocolId 形成循环：' + [...path, current.id].join(' → ') }
    }
    if (current.domain !== definition.domain) {
      return { ok: false, code: 'base-domain-mismatch', path, message: 'protocol lineage 的 domain 不一致' }
    }
    if (current.source === 'builtin') {
      if (current.id !== canonical.id || current.overridePolicy !== 'read-only') {
        return { ok: false, code: 'base-not-canonical', path, message: 'protocol lineage 未指向该 domain 的 canonical protocol' }
      }
      return { ok: true, canonicalId: canonical.id, path, legacyChain }
    }
    if (current.source !== 'experimental') {
      return { ok: false, code: 'base-not-canonical', path, message: 'protocol lineage 只能由 canonical 或 experimental protocol 组成' }
    }
    if (current.overridePolicy !== 'experimental') {
      return { ok: false, code: 'invalid-override-policy', path, message: 'experimental protocol 的 overridePolicy 必须为 experimental' }
    }
    if (!current.baseProtocolId) {
      return { ok: false, code: 'missing-base', path, message: 'experimental protocol 缺少 baseProtocolId' }
    }
    const base = byId.get(current.baseProtocolId)
    if (!base) {
      return { ok: false, code: 'missing-base', path: [...path, current.baseProtocolId], message: '找不到 baseProtocolId：' + current.baseProtocolId }
    }
    if (base.kind !== 'protocol') {
      return { ok: false, code: 'base-not-protocol', path: [...path, base.id], message: 'baseProtocolId 必须指向 protocol 定义' }
    }
    visiting.add(current.id)
    const result = visit(base, [...path, base.id], legacyChain || base.source === 'experimental')
    visiting.delete(current.id)
    return result
  }

  return visit(definition, [definition.id], false)
}
