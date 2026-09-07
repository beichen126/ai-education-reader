import { getSetting } from '../storage/storage'
import { idbGetAll, idbRunTxn } from '../storage/idb'
import { newStableId } from '../engine/types'
import { DEFAULT_PROMPT_PREFERENCES, PROMPT_PREFERENCES_KEY } from './prompt-preferences'
import { BUILTIN_PROMPT_REGISTRY, getBuiltinPrompt } from './prompt-registry'
import type { ArtifactPrompt, PromptDefinition, PromptUserPreferences } from './prompt-types'

export const LEGACY_PROMPT_MIGRATION_KEY = 'promptMigrationV1'

export type LegacyPromptMigrationMarker = {
  version: 1
  migratedAt: number
  fixedPromptId?: string
  customActionIds: string[]
  collisionMappings?: { from: string; to: string }[]
}

export type PromptMigrationDependencies = {
  id?: () => string
  now?: () => number
}

export type PromptMigrationResult = {
  migrated: boolean
  marker: LegacyPromptMigrationMarker
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

function isMarker(value: unknown): value is LegacyPromptMigrationMarker {
  return isObject(value) && value.version === 1 && finiteNonNegative(value.migratedAt) && Array.isArray(value.customActionIds) && value.customActionIds.every(nonEmptyString) && (value.fixedPromptId === undefined || nonEmptyString(value.fixedPromptId)) && (value.collisionMappings === undefined || (Array.isArray(value.collisionMappings) && value.collisionMappings.every((item: any) => isObject(item) && nonEmptyString(item.from) && nonEmptyString(item.to))))
}

function isEnabled(value: unknown): boolean {
  return value === true || value === 'true'
}

function actionDefinition(action: Record<string, any>, now: number): ArtifactPrompt | null {
  if (!nonEmptyString(action.id) || !nonEmptyString(action.name) || !nonEmptyString(action.prompt)) return null
  const createdAt = finiteNonNegative(action.createdAt) ? action.createdAt : now
  const updatedAt = finiteNonNegative(action.updatedAt) ? action.updatedAt : createdAt
  return {
    id: action.id,
    kind: 'artifact',
    artifactKind: 'custom',
    name: action.name,
    description: '从 v1.x 自定义操作迁移。',
    source: 'custom',
    enabled: true,
    createdAt,
    updatedAt,
    revision: 1,
    userPrompt: action.prompt,
  }
}

function markerResult(marker: LegacyPromptMigrationMarker): PromptMigrationResult {
  return { migrated: false, marker }
}

export async function hasLegacyPromptMigrationMarker(): Promise<boolean> {
  return isMarker(await getSetting(LEGACY_PROMPT_MIGRATION_KEY))
}

export async function migrateLegacyPrompts(dependencies: PromptMigrationDependencies = {}): Promise<PromptMigrationResult> {
  const existingMarker = await getSetting(LEGACY_PROMPT_MIGRATION_KEY)
  if (isMarker(existingMarker)) return markerResult(existingMarker)

  const id = dependencies.id ?? newStableId
  const now = dependencies.now ?? Date.now
  const [legacyPrompt, legacyEnabled, legacyActions, rawPreferences, promptRows] = await Promise.all([
    getSetting('customSystemPrompt'),
    getSetting('customSystemPromptEnabled'),
    getSetting('customArtifactActions'),
    getSetting(PROMPT_PREFERENCES_KEY),
    idbGetAll('prompts'),
  ])

  const existing = promptRows.filter((row): row is PromptDefinition => isObject(row) && nonEmptyString(row.id))
  const planned = new Set([...BUILTIN_PROMPT_REGISTRY.map((prompt) => prompt.id), ...existing.map((prompt) => prompt.id)])
  const writes: PromptDefinition[] = []
  const collisionMappings: { from: string; to: string }[] = []
  let fixedPromptId: string | undefined

  const fixedText = typeof legacyPrompt === 'string' && legacyPrompt.trim().length > 0 ? legacyPrompt : undefined
  if (fixedText !== undefined) {
    const matching = existing.find((prompt) => prompt.kind === 'conversation-mode' && prompt.source === 'custom' && prompt.name === '原固定提示词' && prompt.systemPrompt === fixedText)
    if (matching) fixedPromptId = matching.id
    else {
      let candidate = id()
      while (planned.has(candidate)) candidate = id()
      const timestamp = now()
      const definition: PromptDefinition = {
        id: candidate,
        kind: 'conversation-mode',
        name: '原固定提示词',
        description: '从 v1.x customSystemPrompt 迁移，历史 Conversation 不追溯补写模式。',
        source: 'custom',
        enabled: isEnabled(legacyEnabled),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
        systemPrompt: fixedText,
      }
      writes.push(definition)
      planned.add(candidate)
      fixedPromptId = candidate
    }
  }

  const customActionIds: string[] = []
  const seenActionIds = new Set<string>()
  const actions = Array.isArray(legacyActions) ? legacyActions : []
  for (const raw of actions) {
    if (!isObject(raw)) continue
    const candidate = actionDefinition(raw, now())
    if (!candidate || seenActionIds.has(candidate.id)) continue
    seenActionIds.add(candidate.id)
    const sameId = existing.find((prompt) => prompt.id === candidate.id)
    if (sameId && !getBuiltinPrompt(candidate.id)) {
      if (sameId.kind === 'artifact' && sameId.artifactKind === 'custom' && sameId.source === 'custom' && sameId.name === candidate.name && sameId.userPrompt === candidate.userPrompt) customActionIds.push(sameId.id)
      else {
        let replacement = id()
        while (planned.has(replacement)) replacement = id()
        writes.push({ ...candidate, id: replacement })
        planned.add(replacement)
        customActionIds.push(replacement)
        collisionMappings.push({ from: candidate.id, to: replacement })
      }
      continue
    }
    if (planned.has(candidate.id)) {
      let replacement = id()
      while (planned.has(replacement)) replacement = id()
      writes.push({ ...candidate, id: replacement })
      planned.add(replacement)
      customActionIds.push(replacement)
      collisionMappings.push({ from: candidate.id, to: replacement })
      continue
    }
    writes.push(candidate)
    planned.add(candidate.id)
    customActionIds.push(candidate.id)
  }

  const marker: LegacyPromptMigrationMarker = { version: 1, migratedAt: now(), ...(fixedPromptId ? { fixedPromptId } : {}), customActionIds, ...(collisionMappings.length ? { collisionMappings } : {}) }
  const shouldAdoptFixedPrompt = fixedPromptId !== undefined && isEnabled(legacyEnabled) && rawPreferences === undefined
  const nextPreferences: PromptUserPreferences | undefined = shouldAdoptFixedPrompt
    ? { ...DEFAULT_PROMPT_PREFERENCES, defaultConversationModeId: fixedPromptId! }
    : undefined

  await idbRunTxn(['prompts', 'settings'], (txn) => {
    const prompts = txn.objectStore('prompts')
    for (const definition of writes) prompts.put(definition)
    txn.objectStore('settings').put({ key: LEGACY_PROMPT_MIGRATION_KEY, value: marker })
    if (nextPreferences) txn.objectStore('settings').put({ key: PROMPT_PREFERENCES_KEY, value: nextPreferences })
  })
  return { migrated: true, marker }
}
