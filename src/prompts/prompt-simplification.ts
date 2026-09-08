import { getSetting } from '../storage/storage'
import { idbGetAll, idbRunTxn } from '../storage/idb'
import { newStableId } from '../engine/types'
import { DEFAULT_PROMPT_PREFERENCES, PROMPT_PREFERENCES_KEY, normalizePromptPreferences } from './prompt-preferences'
import { BUILTIN_PROMPT_IDS, BUILTIN_PROMPT_REGISTRY, DEFAULT_CONVERSATION_MODE_DESCRIPTION, getBuiltinPrompt } from './prompt-registry'
import { LEGACY_PROMPT_MIGRATION_KEY, type LegacyPromptMigrationMarker } from './prompt-migration'
import type { ConversationModePrompt, PromptDefinition, PromptUserPreferences } from './prompt-types'
import { validatePromptDefinition } from './prompt-validation'

export const PROMPT_SIMPLIFICATION_KEY = 'promptSimplificationV1'

export type PromptSimplificationCandidate = {
  id?: string
  kind: 'selected-custom' | 'legacy-fixed' | 'canonical-default'
  label: string
  enabled: boolean
  content: string
}

export type PromptSimplificationIgnoredCandidate = {
  id?: string
  label: string
  reason: 'lower-priority' | 'disabled' | 'deprecated-built-in' | 'missing'
}

export type PromptSimplificationMarker = {
  version: 1
  migratedAt: number
  defaultPromptId: string
  adoptedFrom: 'empty-default' | 'selected-custom' | 'legacy-fixed' | 'canonical-default'
  ignoredCandidates: PromptSimplificationIgnoredCandidate[]
}

export type PromptSimplificationDependencies = {
  id?: () => string
  now?: () => number
}

export type PromptSimplificationResult = {
  migrated: boolean
  marker: PromptSimplificationMarker
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isMarker(value: unknown): value is PromptSimplificationMarker {
  return isObject(value)
    && value.version === 1
    && finiteNonNegative(value.migratedAt)
    && nonEmptyString(value.defaultPromptId)
    && ['empty-default', 'selected-custom', 'legacy-fixed', 'canonical-default'].includes(value.adoptedFrom)
    && Array.isArray(value.ignoredCandidates)
    && value.ignoredCandidates.every((item: any) => isObject(item)
      && (item.id === undefined || nonEmptyString(item.id))
      && nonEmptyString(item.label)
      && ['lower-priority', 'disabled', 'deprecated-built-in', 'missing'].includes(item.reason))
}

function validPromptRows(rows: unknown[]): PromptDefinition[] {
  return rows.map((row) => validatePromptDefinition(row)).filter((row): row is PromptDefinition => !!row)
}

function isConversationMode(definition: PromptDefinition | undefined): definition is ConversationModePrompt {
  return !!definition && definition.kind === 'conversation-mode'
}

function enabledCustomConversation(definition: PromptDefinition | undefined): definition is ConversationModePrompt {
  return isConversationMode(definition) && definition.source === 'custom' && definition.enabled
}

function isEnabledLegacy(value: unknown): boolean {
  return value === true || value === 'true'
}

function isCanonicalDefault(definition: ConversationModePrompt | undefined): boolean {
  return !!definition
    && definition.name === '默认'
    && definition.description === DEFAULT_CONVERSATION_MODE_DESCRIPTION
}

function makeDefaultDefinition(id: string, content: string, now: number): ConversationModePrompt {
  return {
    id,
    kind: 'conversation-mode',
    name: '默认',
    description: DEFAULT_CONVERSATION_MODE_DESCRIPTION,
    source: 'custom',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    systemPrompt: content,
  }
}

function markerResult(marker: PromptSimplificationMarker): PromptSimplificationResult {
  return { migrated: false, marker }
}

export async function hasPromptSimplificationMarker(): Promise<boolean> {
  return isMarker(await getSetting(PROMPT_SIMPLIFICATION_KEY))
}

/**
 * Collapse the old selectable conversation modes into one canonical default.
 * Deprecated built-ins and old custom rows remain untouched so snapshots and
 * V6 backups can still resolve them. The marker, preference, and newly created
 * canonical row are committed together when a row is needed.
 */
export async function migratePromptSimplification(dependencies: PromptSimplificationDependencies = {}): Promise<PromptSimplificationResult> {
  const existingMarker = await getSetting(PROMPT_SIMPLIFICATION_KEY)
  if (isMarker(existingMarker)) return markerResult(existingMarker)

  const id = dependencies.id ?? newStableId
  const now = dependencies.now ?? Date.now
  const [rawPreferences, legacyPrompt, legacyEnabled, legacyMarkerRaw, promptRows] = await Promise.all([
    getSetting(PROMPT_PREFERENCES_KEY),
    getSetting('customSystemPrompt'),
    getSetting('customSystemPromptEnabled'),
    getSetting(LEGACY_PROMPT_MIGRATION_KEY),
    idbGetAll('prompts'),
  ])

  const existing = validPromptRows(promptRows)
  const byId = new Map(existing.map((definition) => [definition.id, definition]))
  const preferences = normalizePromptPreferences(rawPreferences).preferences
  const selected = byId.get(preferences.defaultConversationModeId) ?? getBuiltinPrompt(preferences.defaultConversationModeId)
  const legacyMarker = legacyMarkerRaw as LegacyPromptMigrationMarker | undefined
  const legacyFixed = legacyMarker?.fixedPromptId ? byId.get(legacyMarker.fixedPromptId) : undefined
  const legacyText = typeof legacyPrompt === 'string' && legacyPrompt.trim().length > 0 ? legacyPrompt : undefined
  const legacyEnabledValue = isEnabledLegacy(legacyEnabled)

  const ignoredCandidates: PromptSimplificationIgnoredCandidate[] = []
  const selectedIsLegacyFixed = isConversationMode(selected)
    && selected.id === legacyFixed?.id
    && selected.name === '原固定提示词'
  const selectedCustom = isConversationMode(selected) && selected.source === 'custom' && selected.enabled && !selectedIsLegacyFixed ? selected : undefined
  const canonicalCurrent = isCanonicalDefault(selectedCustom) ? selectedCustom : undefined
  const fixedContent = enabledCustomConversation(legacyFixed) && legacyFixed.systemPrompt !== undefined
    ? legacyFixed.systemPrompt
    : legacyText
  const legacyFixedEnabled = legacyFixed ? legacyFixed.enabled : legacyText !== undefined ? legacyEnabledValue : false

  if (isConversationMode(selected) && selected.source === 'builtin' && selected.id !== BUILTIN_PROMPT_IDS.conversationDefault) {
    ignoredCandidates.push({ id: selected.id, label: selected.name, reason: 'deprecated-built-in' })
  } else if (isConversationMode(selected) && selected.source === 'custom' && !selected.enabled) {
    ignoredCandidates.push({ id: selected.id, label: selected.name, reason: 'disabled' })
  }
  if (legacyFixed && !legacyFixed.enabled) ignoredCandidates.push({ id: legacyFixed.id, label: legacyFixed.name, reason: 'disabled' })
  if (legacyText !== undefined && !legacyEnabledValue && !legacyFixed) ignoredCandidates.push({ label: 'legacy customSystemPrompt', reason: 'disabled' })

  let candidate: PromptSimplificationCandidate | undefined
  if (selectedCustom) {
    candidate = {
      id: selectedCustom.id,
      kind: canonicalCurrent ? 'canonical-default' : 'selected-custom',
      label: selectedCustom.name,
      enabled: true,
      content: selectedCustom.systemPrompt,
    }
  } else if (fixedContent !== undefined && legacyFixedEnabled) {
    candidate = {
      id: legacyFixed?.id,
      kind: 'legacy-fixed',
      label: legacyFixed?.name ?? 'legacy customSystemPrompt',
      enabled: true,
      content: fixedContent,
    }
  } else if (canonicalCurrent) {
    candidate = {
      id: canonicalCurrent.id,
      kind: 'canonical-default',
      label: canonicalCurrent.name,
      enabled: true,
      content: canonicalCurrent.systemPrompt,
    }
  }

  if (selectedCustom && fixedContent !== undefined) ignoredCandidates.push({ id: legacyFixed?.id, label: legacyFixed?.name ?? 'legacy customSystemPrompt', reason: 'lower-priority' })
  if (candidate?.kind !== 'canonical-default' && canonicalCurrent) ignoredCandidates.push({ id: canonicalCurrent.id, label: canonicalCurrent.name, reason: 'lower-priority' })

  const existingCanonical = candidate?.kind === 'canonical-default' && candidate.id ? byId.get(candidate.id) : undefined
  let defaultPromptId: string = BUILTIN_PROMPT_IDS.conversationDefault
  let adoptedFrom: PromptSimplificationMarker['adoptedFrom'] = 'empty-default'
  let nextDefault: ConversationModePrompt | undefined
  if (candidate) {
    adoptedFrom = candidate.kind
    if (existingCanonical && isCanonicalDefault(existingCanonical as ConversationModePrompt)) {
      defaultPromptId = existingCanonical.id
    } else {
      defaultPromptId = id()
      const plannedIds = new Set([...BUILTIN_PROMPT_REGISTRY.map((definition) => definition.id), ...existing.map((definition) => definition.id)])
      while (plannedIds.has(defaultPromptId)) defaultPromptId = id()
      nextDefault = makeDefaultDefinition(defaultPromptId, candidate.content, now())
    }
  }

  const marker: PromptSimplificationMarker = {
    version: 1,
    migratedAt: now(),
    defaultPromptId,
    adoptedFrom,
    ignoredCandidates,
  }
  const nextPreferences: PromptUserPreferences = { ...DEFAULT_PROMPT_PREFERENCES, ...preferences, defaultConversationModeId: defaultPromptId }
  await idbRunTxn(['prompts', 'settings'], (txn) => {
    if (nextDefault) txn.objectStore('prompts').put(nextDefault)
    txn.objectStore('settings').put({ key: PROMPT_SIMPLIFICATION_KEY, value: marker })
    txn.objectStore('settings').put({ key: PROMPT_PREFERENCES_KEY, value: nextPreferences })
  })
  return { migrated: true, marker }
}

export function isCanonicalDefaultConversationMode(definition: PromptDefinition | undefined): definition is ConversationModePrompt {
  return isConversationMode(definition) && definition.source !== 'builtin' && isCanonicalDefault(definition)
}
