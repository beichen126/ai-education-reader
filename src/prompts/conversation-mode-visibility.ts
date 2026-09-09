import { getSetting } from '../storage/storage'
import { BUILTIN_PROMPT_IDS } from './prompt-registry'
import { isCanonicalDefaultConversationMode } from './prompt-simplification'
import { LEGACY_PROMPT_MIGRATION_KEY } from './prompt-migration'
import type { ConversationModePrompt, PromptDefinition } from './prompt-types'

type MarkerLike = { fixedPromptId?: unknown }

function markerId(value: unknown, key: keyof MarkerLike): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as MarkerLike)[key]
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The source registry keeps deprecated built-ins parseable for snapshots and
 * Backup, but they are not part of a new user's visible or selectable mode
 * catalog. The migration marker identifies the old fixed-prompt duplicate that
 * was absorbed into the canonical default row.
 */
async function compatibilityOnlyIds(): Promise<Set<string>> {
  const legacyMarker = await getSetting(LEGACY_PROMPT_MIGRATION_KEY)
  const ids = new Set<string>()
  const fixedPromptId = markerId(legacyMarker, 'fixedPromptId')
  if (fixedPromptId) ids.add(fixedPromptId)
  return ids
}

export type ConversationModeCatalogOptions = {
  includeDisabled?: boolean
}

/** Shared visibility resolver for Prompt Manager and the current-route selector. */
export async function listVisibleConversationModes(
  definitions: readonly PromptDefinition[],
  options: ConversationModeCatalogOptions = {},
): Promise<ConversationModePrompt[]> {
  const hiddenCompatibilityIds = await compatibilityOnlyIds()
  const modes = definitions.filter((item): item is ConversationModePrompt => item.kind === 'conversation-mode')
  const canonicalDefault = modes.find((item) => isCanonicalDefaultConversationMode(item))
  const visible = modes.filter((definition) => {
    if (hiddenCompatibilityIds.has(definition.id)) return false
    if (definition.source === 'builtin') {
      // A v2.0.3 migration may have persisted an editable canonical default
      // row. Do not show the source built-in beside that row.
      return definition.id === BUILTIN_PROMPT_IDS.conversationDefault && !canonicalDefault
    }
    if (definition.source === 'custom') return true
    return false
  })
  return visible.filter((definition) => options.includeDisabled || definition.enabled)
}

/** A disabled custom mode remains manageable but cannot be selected for a send. */
export async function listSelectableConversationModes(definitions: readonly PromptDefinition[]): Promise<ConversationModePrompt[]> {
  return listVisibleConversationModes(definitions, { includeDisabled: false })
}

export function modeIsSelectable(mode: ConversationModePrompt | undefined): boolean {
  return !!mode && mode.enabled && (mode.source === 'builtin' || mode.source === 'custom')
}
