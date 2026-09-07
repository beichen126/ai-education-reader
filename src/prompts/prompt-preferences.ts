import { getSetting, setSetting } from '../storage/storage'
import { BUILTIN_PROMPT_IDS } from './prompt-registry'
import type { PromptSortPreference, PromptUserPreferences } from './prompt-types'

export const PROMPT_PREFERENCES_KEY = 'promptPreferences'
export const DEFAULT_PROMPT_PREFERENCES: PromptUserPreferences = {
  version: 1,
  defaultConversationModeId: BUILTIN_PROMPT_IDS.conversationDefault,
  hiddenBuiltinPromptIds: [],
  activeProtocolOverrideByDomain: {},
  sortPreference: 'updatedAt-desc',
}

function isSortPreference(value: unknown): value is PromptSortPreference {
  return value === 'updatedAt-desc' || value === 'name-asc'
}

function normalize(raw: unknown): PromptUserPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROMPT_PREFERENCES, hiddenBuiltinPromptIds: [], activeProtocolOverrideByDomain: {} }
  const value = raw as Record<string, unknown>
  const hidden = Array.isArray(value.hiddenBuiltinPromptIds) ? value.hiddenBuiltinPromptIds.filter((id): id is string => typeof id === 'string') : []
  const overrides: Record<string, string> = {}
  if (value.activeProtocolOverrideByDomain && typeof value.activeProtocolOverrideByDomain === 'object') {
    for (const [domain, id] of Object.entries(value.activeProtocolOverrideByDomain as Record<string, unknown>)) if (typeof id === 'string') overrides[domain] = id
  }
  return {
    version: 1,
    defaultConversationModeId: typeof value.defaultConversationModeId === 'string' ? value.defaultConversationModeId : DEFAULT_PROMPT_PREFERENCES.defaultConversationModeId,
    hiddenBuiltinPromptIds: [...new Set(hidden)],
    activeProtocolOverrideByDomain: overrides,
    sortPreference: isSortPreference(value.sortPreference) ? value.sortPreference : DEFAULT_PROMPT_PREFERENCES.sortPreference,
  }
}

export async function getPromptPreferences(): Promise<PromptUserPreferences> {
  return normalize(await getSetting(PROMPT_PREFERENCES_KEY))
}

/** The whole preference record is written in one settings transaction. */
export async function savePromptPreferences(preferences: PromptUserPreferences): Promise<void> {
  await setSetting(PROMPT_PREFERENCES_KEY, normalize(preferences))
}

export async function updatePromptPreferences(patch: Partial<PromptUserPreferences>): Promise<PromptUserPreferences> {
  const next = { ...(await getPromptPreferences()), ...patch }
  await savePromptPreferences(next)
  return normalize(next)
}

export async function setDefaultConversationModeId(id: string): Promise<PromptUserPreferences> {
  return updatePromptPreferences({ defaultConversationModeId: id })
}

export async function setPromptSortPreference(sortPreference: PromptSortPreference): Promise<PromptUserPreferences> {
  return updatePromptPreferences({ sortPreference })
}

export async function setBuiltinPromptHidden(id: string, hidden: boolean): Promise<PromptUserPreferences> {
  const current = await getPromptPreferences()
  const ids = new Set(current.hiddenBuiltinPromptIds)
  if (hidden) ids.add(id)
  else ids.delete(id)
  return saveAndRead({ hiddenBuiltinPromptIds: [...ids] })
}

export async function setActiveProtocolOverride(domain: string, id: string | undefined): Promise<PromptUserPreferences> {
  const current = await getPromptPreferences()
  const mapping = { ...current.activeProtocolOverrideByDomain }
  if (id === undefined) delete mapping[domain]
  else mapping[domain] = id
  return saveAndRead({ activeProtocolOverrideByDomain: mapping })
}

async function saveAndRead(patch: Partial<PromptUserPreferences>): Promise<PromptUserPreferences> {
  await updatePromptPreferences(patch)
  return getPromptPreferences()
}
