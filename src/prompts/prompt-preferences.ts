import { getSetting } from '../storage/storage'
import { idbUpdateOrInsert } from '../storage/idb'
import { BUILTIN_PROMPT_IDS, getBuiltinPrompt, getBuiltinProtocol } from './prompt-registry'
import { getPromptRecord, listPromptRecords } from './prompt-store'
import { resolveProtocolCanonicalRoot } from './protocol-lineage'
import type { PromptDefinition, PromptSortPreference, PromptUserPreferences } from './prompt-types'

export const PROMPT_PREFERENCES_KEY = 'promptPreferences'
export const DEFAULT_PROMPT_PREFERENCES: PromptUserPreferences = Object.freeze({
  version: 1,
  defaultConversationModeId: BUILTIN_PROMPT_IDS.conversationDefault,
  hiddenBuiltinPromptIds: Object.freeze([]) as unknown as string[],
  activeProtocolOverrideByDomain: Object.freeze({}) as Record<string, string>,
  sortPreference: 'updatedAt-desc',
})

export type PromptPreferencesDiagnostic = {
  code: 'invalid-record' | 'invalid-version' | 'invalid-default' | 'invalid-hidden' | 'duplicate-hidden' | 'invalid-override' | 'invalid-sort'
  path: string
  message: string
}

export type PromptPreferencesNormalization = {
  preferences: PromptUserPreferences
  diagnostics: PromptPreferencesDiagnostic[]
}

export class PromptPreferencesError extends Error {
  readonly code: 'invalid-sort' | 'invalid-hidden-id' | 'invalid-default-mode' | 'invalid-override'
  constructor(code: PromptPreferencesError['code'], message: string) {
    super(message)
    this.name = 'PromptPreferencesError'
    this.code = code
  }
}

function isSortPreference(value: unknown): value is PromptSortPreference {
  return value === 'updatedAt-desc' || value === 'name-asc'
}

function clonePreferences(preferences: PromptUserPreferences): PromptUserPreferences {
  return {
    version: 1,
    defaultConversationModeId: preferences.defaultConversationModeId,
    hiddenBuiltinPromptIds: [...preferences.hiddenBuiltinPromptIds],
    activeProtocolOverrideByDomain: { ...preferences.activeProtocolOverrideByDomain },
    sortPreference: preferences.sortPreference,
  }
}

function defaultPreferences(): PromptUserPreferences {
  return clonePreferences(DEFAULT_PROMPT_PREFERENCES)
}

/** Normalize untrusted local state without silently retaining malformed values. */
export function normalizePromptPreferences(raw: unknown): PromptPreferencesNormalization {
  const diagnostics: PromptPreferencesDiagnostic[] = []
  if (raw === undefined) return { preferences: defaultPreferences(), diagnostics }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({ code: 'invalid-record', path: '', message: 'prompt preferences must be an object; defaults were used' })
    return { preferences: defaultPreferences(), diagnostics }
  }
  const value = raw as Record<string, unknown>
  if (value.version !== undefined && value.version !== 1) diagnostics.push({ code: 'invalid-version', path: 'version', message: 'unsupported prompt preference version; version 1 was used' })

  let defaultConversationModeId = DEFAULT_PROMPT_PREFERENCES.defaultConversationModeId
  if (value.defaultConversationModeId !== undefined) {
    if (typeof value.defaultConversationModeId === 'string' && value.defaultConversationModeId.trim().length > 0) defaultConversationModeId = value.defaultConversationModeId
    else diagnostics.push({ code: 'invalid-default', path: 'defaultConversationModeId', message: 'empty or invalid default mode; canonical default was used' })
  }

  const hiddenBuiltinPromptIds: string[] = []
  if (value.hiddenBuiltinPromptIds !== undefined && !Array.isArray(value.hiddenBuiltinPromptIds)) {
    diagnostics.push({ code: 'invalid-hidden', path: 'hiddenBuiltinPromptIds', message: 'hiddenBuiltinPromptIds must be an array; empty list was used' })
  } else {
    const seen = new Set<string>()
    for (const [index, id] of (Array.isArray(value.hiddenBuiltinPromptIds) ? value.hiddenBuiltinPromptIds : []).entries()) {
      if (typeof id !== 'string' || id.trim().length === 0 || !getBuiltinPrompt(id)) {
        diagnostics.push({ code: 'invalid-hidden', path: 'hiddenBuiltinPromptIds[' + index + ']', message: 'only real built-in prompt IDs may be hidden' })
        continue
      }
      if (seen.has(id)) {
        diagnostics.push({ code: 'duplicate-hidden', path: 'hiddenBuiltinPromptIds[' + index + ']', message: 'duplicate hidden built-in ID was removed' })
        continue
      }
      seen.add(id)
      hiddenBuiltinPromptIds.push(id)
    }
  }

  const activeProtocolOverrideByDomain: Record<string, string> = {}
  if (value.activeProtocolOverrideByDomain !== undefined && (!value.activeProtocolOverrideByDomain || typeof value.activeProtocolOverrideByDomain !== 'object' || Array.isArray(value.activeProtocolOverrideByDomain))) {
    diagnostics.push({ code: 'invalid-override', path: 'activeProtocolOverrideByDomain', message: 'override mapping must be an object; empty mapping was used' })
  } else if (value.activeProtocolOverrideByDomain && typeof value.activeProtocolOverrideByDomain === 'object') {
    for (const [domain, id] of Object.entries(value.activeProtocolOverrideByDomain as Record<string, unknown>)) {
      if (domain.trim().length === 0 || typeof id !== 'string' || id.trim().length === 0) {
        diagnostics.push({ code: 'invalid-override', path: 'activeProtocolOverrideByDomain.' + domain, message: 'override domain and ID must be non-empty strings' })
        continue
      }
      activeProtocolOverrideByDomain[domain] = id
    }
  }

  let sortPreference: PromptSortPreference = DEFAULT_PROMPT_PREFERENCES.sortPreference
  if (value.sortPreference !== undefined) {
    if (isSortPreference(value.sortPreference)) sortPreference = value.sortPreference
    else diagnostics.push({ code: 'invalid-sort', path: 'sortPreference', message: 'unsupported sort preference; default sort was used' })
  }

  return {
    preferences: { version: 1, defaultConversationModeId, hiddenBuiltinPromptIds, activeProtocolOverrideByDomain, sortPreference },
    diagnostics,
  }
}

export async function getPromptPreferencesWithDiagnostics(): Promise<PromptPreferencesNormalization> {
  return normalizePromptPreferences(await getSetting(PROMPT_PREFERENCES_KEY))
}

export async function getPromptPreferences(): Promise<PromptUserPreferences> {
  return (await getPromptPreferencesWithDiagnostics()).preferences
}

function assertSortPreference(value: unknown): asserts value is PromptSortPreference {
  if (!isSortPreference(value)) throw new PromptPreferencesError('invalid-sort', 'sortPreference 不是受支持的枚举值')
}

async function resolvePromptForPreference(id: string): Promise<PromptDefinition> {
  if (typeof id !== 'string' || id.trim().length === 0) throw new PromptPreferencesError('invalid-default-mode', 'defaultConversationModeId 不能为空')
  const builtin = getBuiltinPrompt(id)
  if (builtin) return builtin
  const persisted = await getPromptRecord(id)
  if (!persisted) throw new PromptPreferencesError('invalid-default-mode', 'defaultConversationModeId 未引用已存在的 prompt')
  return persisted
}

async function assertDefaultMode(id: string): Promise<void> {
  const definition = await resolvePromptForPreference(id)
  if (definition.kind !== 'conversation-mode') throw new PromptPreferencesError('invalid-default-mode', 'defaultConversationModeId 必须指向 conversation-mode')
}

async function assertProtocolOverride(domain: string, id: string): Promise<void> {
  if (!domain || !id) throw new PromptPreferencesError('invalid-override', 'protocol override domain 与 ID 不能为空')
  const definition = await getPromptRecord(id)
  if (!definition || definition.kind !== 'protocol' || definition.source !== 'experimental' || !definition.enabled || definition.domain !== domain) {
    throw new PromptPreferencesError('invalid-override', 'active protocol override 必须是 enabled、domain 匹配的 experimental protocol')
  }
  const base = getBuiltinProtocol(domain)
  if (!base) throw new PromptPreferencesError('invalid-override', 'protocol domain 没有可用的 canonical protocol')
  const lineage = resolveProtocolCanonicalRoot(definition, await listPromptRecords())
  if ('message' in lineage) throw new PromptPreferencesError('invalid-override', 'experimental protocol override 的 lineage 无效（' + lineage.code + '：' + lineage.message + '）')
  if (lineage.canonicalId !== base.id) throw new PromptPreferencesError('invalid-override', 'experimental protocol override 的 lineage 无效（canonical domain 不匹配）')
}

async function validatePreferencePatch(patch: Partial<PromptUserPreferences>): Promise<void> {
  if (patch.sortPreference !== undefined) assertSortPreference(patch.sortPreference)
  if (patch.defaultConversationModeId !== undefined) await assertDefaultMode(patch.defaultConversationModeId)
  if (patch.hiddenBuiltinPromptIds !== undefined) {
    if (!Array.isArray(patch.hiddenBuiltinPromptIds) || new Set(patch.hiddenBuiltinPromptIds).size !== patch.hiddenBuiltinPromptIds.length) throw new PromptPreferencesError('invalid-hidden-id', 'hiddenBuiltinPromptIds 必须是无重复数组')
    for (const id of patch.hiddenBuiltinPromptIds) if (!getBuiltinPrompt(id)) throw new PromptPreferencesError('invalid-hidden-id', '只能隐藏真实 built-in prompt ID')
  }
  if (patch.activeProtocolOverrideByDomain !== undefined) {
    for (const [domain, id] of Object.entries(patch.activeProtocolOverrideByDomain)) await assertProtocolOverride(domain, id)
  }
}

/** Canonical atomic preferences helper; returned data is committed data. */
export async function updatePromptPreferencesAtomic(
  updater: (current: PromptUserPreferences) => PromptUserPreferences,
): Promise<PromptUserPreferences> {
  const row = await idbUpdateOrInsert<{ key: string; value: PromptUserPreferences } | undefined>(
    'settings',
    PROMPT_PREFERENCES_KEY,
    { key: PROMPT_PREFERENCES_KEY, value: defaultPreferences() },
    (raw) => {
      const current = normalizePromptPreferences(raw?.value).preferences
      const next = normalizePromptPreferences(updater(clonePreferences(current))).preferences
      return { key: PROMPT_PREFERENCES_KEY, value: next }
    },
  )
  return clonePreferences(row.value)
}

export async function savePromptPreferences(preferences: PromptUserPreferences): Promise<void> {
  const normalized = normalizePromptPreferences(preferences).preferences
  await validatePreferencePatch(normalized)
  await updatePromptPreferencesAtomic(() => normalized)
}

export async function updatePromptPreferences(patch: Partial<PromptUserPreferences>): Promise<PromptUserPreferences> {
  await validatePreferencePatch(patch)
  return updatePromptPreferencesAtomic((current) => ({ ...current, ...patch }))
}

export async function setDefaultConversationModeId(id: string): Promise<PromptUserPreferences> {
  await assertDefaultMode(id)
  return updatePromptPreferencesAtomic((current) => ({ ...current, defaultConversationModeId: id }))
}

export async function setPromptSortPreference(sortPreference: PromptSortPreference): Promise<PromptUserPreferences> {
  assertSortPreference(sortPreference)
  return updatePromptPreferencesAtomic((current) => ({ ...current, sortPreference }))
}

export async function setBuiltinPromptHidden(id: string, hidden: boolean): Promise<PromptUserPreferences> {
  if (!getBuiltinPrompt(id)) throw new PromptPreferencesError('invalid-hidden-id', '只能隐藏真实 built-in prompt ID')
  return updatePromptPreferencesAtomic((current) => {
    const ids = new Set(current.hiddenBuiltinPromptIds)
    if (hidden) ids.add(id)
    else ids.delete(id)
    return { ...current, hiddenBuiltinPromptIds: [...ids] }
  })
}

export async function setActiveProtocolOverride(domain: string, id: string | undefined): Promise<PromptUserPreferences> {
  if (!domain) throw new PromptPreferencesError('invalid-override', 'protocol override domain 不能为空')
  if (id !== undefined) await assertProtocolOverride(domain, id)
  return updatePromptPreferencesAtomic((current) => {
    const mapping = { ...current.activeProtocolOverrideByDomain }
    if (id === undefined) delete mapping[domain]
    else mapping[domain] = id
    return { ...current, activeProtocolOverrideByDomain: mapping }
  })
}
