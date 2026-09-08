import 'fake-indexeddb/auto'
import { closeDb, idbClearAll, idbGetAll } from '../src/storage/idb.ts'
import { getConversation, getSetting, saveConversation, setSetting } from '../src/storage/storage.ts'
import { DEFAULT_PROMPT_PREFERENCES, getPromptPreferences } from '../src/prompts/prompt-preferences.ts'
import { getPromptRecord, savePromptRecord } from '../src/prompts/prompt-store.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import { listEffectivePromptDefinitions } from '../src/prompts/prompt-resolution.ts'
import { listPromptCatalog } from '../src/prompts/prompt-service.ts'
import { migrateLegacyPrompts } from '../src/prompts/prompt-migration.ts'
import { hasPromptSimplificationMarker, migratePromptSimplification } from '../src/prompts/prompt-simplification.ts'
import { prepareAcceptedSendContext, resolveCurrentConversationModeResult } from '../src/prompts/prompt-send.ts'
import type { ConversationModePrompt } from '../src/prompts/prompt-types.ts'
import type { Message } from '../src/engine/types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

function customMode(id: string, name: string, content: string, enabled = true): ConversationModePrompt {
  return { id, kind: 'conversation-mode', name, description: name, source: 'custom', enabled, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: content }
}

await idbClearAll()
const empty = await migratePromptSimplification({ id: () => 'should-not-be-used', now: () => 10 })
assert(empty.migrated && empty.marker.adoptedFrom === 'empty-default', 'new install keeps an empty canonical default without fabricating a custom row')
assert((await getPromptPreferences()).defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault, 'new install points preferences at the canonical built-in default')
assert(await hasPromptSimplificationMarker(), 'simplification marker is durable')
const emptySecond = await migratePromptSimplification({ id: () => 'duplicate', now: () => 999 })
assert(!emptySecond.migrated && emptySecond.marker.defaultPromptId === empty.marker.defaultPromptId && (await idbGetAll('prompts')).length === 0, 'restarting empty migration is idempotent and creates no duplicate')

await idbClearAll()
const fixedText = '  legacy fixed prompt\nonly once  '
await setSetting('customSystemPrompt', fixedText)
await setSetting('customSystemPromptEnabled', 'true')
const legacy = await migrateLegacyPrompts({ id: () => 'legacy-fixed', now: () => 20 })
const adoptedLegacy = await migratePromptSimplification({ id: () => 'canonical-from-legacy', now: () => 21 })
const canonicalLegacy = await getPromptRecord(adoptedLegacy.marker.defaultPromptId) as ConversationModePrompt | undefined
assert(adoptedLegacy.marker.adoptedFrom === 'legacy-fixed' && canonicalLegacy?.systemPrompt === fixedText, 'enabled v1 fixed prompt is copied byte-for-byte into default')
assert(canonicalLegacy?.name === '默认' && canonicalLegacy?.source === 'custom' && (await getPromptPreferences()).defaultConversationModeId === canonicalLegacy?.id, 'legacy adoption creates one canonical custom default and selects it')
assert((await getPromptRecord(legacy.marker.fixedPromptId!))?.kind === 'conversation-mode', 'deprecated migrated fixed definition remains available for compatibility')
const legacyCount = (await idbGetAll('prompts')).length
const legacySecond = await migratePromptSimplification({ id: () => 'duplicate', now: () => 999 })
assert(!legacySecond.migrated && (await idbGetAll('prompts')).length === legacyCount && (await getPromptRecord(canonicalLegacy!.id))?.revision === 1, 'restarting legacy migration does not duplicate or bump default revision')

await idbClearAll()
const selected = customMode('selected-custom', '我的学习模式', 'selected wins')
await savePromptRecord(selected)
await setSetting('promptPreferences', { ...DEFAULT_PROMPT_PREFERENCES, defaultConversationModeId: selected.id })
await setSetting('customSystemPrompt', 'lower priority fixed')
await setSetting('customSystemPromptEnabled', 'true')
const selectedResult = await migratePromptSimplification({ id: () => 'canonical-from-selected', now: () => 30 })
const selectedDefault = await getPromptRecord(selectedResult.marker.defaultPromptId) as ConversationModePrompt | undefined
assert(selectedResult.marker.adoptedFrom === 'selected-custom' && selectedDefault?.systemPrompt === selected.systemPrompt, 'currently selected enabled custom mode outranks legacy fixed content')
assert(selectedResult.marker.ignoredCandidates.some((item) => item.label === 'legacy customSystemPrompt' && item.reason === 'lower-priority'), 'migration marker records the ignored lower-priority candidate')
assert((await getPromptRecord(selected.id))?.systemPrompt === selected.systemPrompt, 'selected deprecated custom definition is preserved unchanged')

await idbClearAll()
await setSetting('promptPreferences', { ...DEFAULT_PROMPT_PREFERENCES, defaultConversationModeId: BUILTIN_PROMPT_IDS.conversationSocratic })
const oldConversation = { id: 'old-snapshot', title: 'old', createdAt: 1, updatedAt: 1, messages: [], promptTransitions: [{ id: 'old-transition', afterMessageId: null, snapshot: { profileId: BUILTIN_PROMPT_IDS.conversationSocratic, kind: 'conversation-mode' as const, name: '苏格拉底式学习', content: 'old content', source: 'builtin' as const, revision: 1, capturedAt: 1 }, createdAt: 1 }] }
await saveConversation(oldConversation)
const deprecated = await migratePromptSimplification({ id: () => 'should-not-be-used', now: () => 40 })
const resolvedDeprecated = await resolveCurrentConversationModeResult(41)
const effectiveDeprecated = await listEffectivePromptDefinitions('conversation-mode')
const visibleDeprecated = await listPromptCatalog('conversation-mode')
assert(deprecated.marker.adoptedFrom === 'empty-default' && (await getPromptPreferences()).defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault, 'selected deprecated built-in mode falls back to default for new sends')
assert(resolvedDeprecated.snapshot?.profileId === BUILTIN_PROMPT_IDS.conversationDefault && resolvedDeprecated.snapshot.content === '', 'new send resolver returns canonical empty default after deprecated selection')
const oldUser: Message = { id: 'new-after-old', role: 'user', content: 'new', images: [], createdAt: 1, updatedAt: 1 }
const preparedAfterOld = await prepareAcceptedSendContext({
  threadRef: { type: 'root', conversationId: oldConversation.id },
  messagesBeforeAcceptance: [],
  candidateMessages: [oldUser],
  effectiveTransitions: oldConversation.promptTransitions,
  localTransitions: oldConversation.promptTransitions,
  acceptedMessageId: oldUser.id,
  now: 42,
})
assert(preparedAfterOld.context.effectivePromptTimeline.at(-1)?.snapshot.profileId === BUILTIN_PROMPT_IDS.conversationDefault, 'a new send after a deprecated historical snapshot captures the current default snapshot')
assert(effectiveDeprecated.some((item) => item.id === BUILTIN_PROMPT_IDS.conversationSocratic) && visibleDeprecated.length === 1 && visibleDeprecated[0].id === BUILTIN_PROMPT_IDS.conversationDefault, 'deprecated built-in IDs remain parseable while visible catalog exposes only default')
assert((await getConversation(oldConversation.id))?.promptTransitions?.[0].snapshot.name === '苏格拉底式学习', 'historical deprecated snapshot is not rewritten by migration')

await idbClearAll()
await setSetting('customSystemPrompt', 'disabled fixed')
await setSetting('customSystemPromptEnabled', false)
const disabled = await migratePromptSimplification({ id: () => 'should-not-be-used', now: () => 50 })
assert(disabled.marker.adoptedFrom === 'empty-default' && disabled.marker.ignoredCandidates.some((item) => item.reason === 'disabled'), 'disabled legacy fixed prompt is not activated and is recorded as ignored')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
