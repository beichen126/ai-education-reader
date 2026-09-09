import 'fake-indexeddb/auto'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getConversation, saveConversation, setSetting } from '../src/storage/storage.ts'
import { listPromptCatalog, listSelectableConversationModes, savePromptDefinition, updatePromptDefinition, deletePromptDefinition } from '../src/prompts/prompt-service.ts'
import { getPromptPreferences, setDefaultConversationModeId } from '../src/prompts/prompt-preferences.ts'
import { listConversationModeDefinitions, switchConversationMode } from '../src/prompts/prompt-mode-service.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import type { ConversationModePrompt } from '../src/prompts/prompt-types.ts'
import type { Conversation } from '../src/engine/types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

const mode = (id: string, name: string, enabled = true): ConversationModePrompt => ({
  id, kind: 'conversation-mode', name, description: name, source: 'custom', enabled,
  createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: name + ' prompt',
})

await idbClearAll()
const initial = await listPromptCatalog('conversation-mode')
assert(initial.length === 1 && initial[0]?.id === BUILTIN_PROMPT_IDS.conversationDefault, 'clean install management catalog contains only 默认')
assert((await listSelectableConversationModes()).length === 1, 'clean install selector contains only 默认')

const custom = mode('v210-math', '数学证明教练')
const disabled = mode('v210-disabled', '停用模式', false)
await savePromptDefinition(custom)
await savePromptDefinition(disabled)
const management = await listPromptCatalog('conversation-mode')
const selectable = await listSelectableConversationModes()
assert(management.some(item => item.id === custom.id) && management.some(item => item.id === disabled.id), 'management catalog shows enabled and disabled custom modes')
assert(selectable.some(item => item.id === custom.id) && !selectable.some(item => item.id === disabled.id), 'selector shows enabled custom mode but excludes disabled custom mode')
assert((await listConversationModeDefinitions()).every(item => item.enabled), 'mode service exposes only selectable modes')

const edited = await updatePromptDefinition(custom.id, { name: '数学证明教练 v2', systemPrompt: '先列出命题，再逐步证明。' })
assert(edited.definition.name === '数学证明教练 v2' && edited.definition.revision === 2, 'custom mode edit persists metadata and increments content revision')
await setDefaultConversationModeId(custom.id)
assert((await getPromptPreferences()).defaultConversationModeId === custom.id, 'enabled custom mode can become the new-session default')

const conversation: Conversation = { id: 'v210-mode-conversation', title: 'mode', createdAt: 1, updatedAt: 1, messages: [] }
await saveConversation(conversation)
const switched = await switchConversationMode({ conversationId: conversation.id, modeId: custom.id, now: 20, id: () => 'v210-transition' })
const stored = await getConversation(conversation.id) as Conversation | undefined
assert(switched.changed && stored?.promptTransitions?.[0]?.snapshot.profileId === custom.id && stored.promptTransitions[0].snapshot.content === '先列出命题，再逐步证明。', 'current route switch captures the selected custom snapshot at the route boundary')

await deletePromptDefinition(custom.id)
assert((await getPromptPreferences()).defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault, 'deleting the global custom default atomically falls back to built-in 默认')
assert((await listPromptCatalog('conversation-mode')).every(item => item.id !== custom.id), 'deleted custom mode leaves no management row')
assert((await getConversation(conversation.id) as Conversation)?.promptTransitions?.[0]?.snapshot.profileId === custom.id, 'deleting a mode does not rewrite historical route snapshot')

const migratedDefault: ConversationModePrompt = {
  id: 'v210-migrated-default', kind: 'conversation-mode', name: '默认',
  description: '保持 1.x 的默认对话行为，不附加模式提示词。', source: 'custom', enabled: true,
  createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: 'legacy default content',
}
await savePromptDefinition(migratedDefault)
await setDefaultConversationModeId(migratedDefault.id)
const migratedCatalog = await listPromptCatalog('conversation-mode')
assert(migratedCatalog.some(item => item.id === migratedDefault.id) && !migratedCatalog.some(item => item.id === BUILTIN_PROMPT_IDS.conversationDefault), 'v2.0.3 canonical custom default is shown once without duplicating the built-in row')

const legacy = mode('v210-legacy-fixed', '原固定提示词')
await savePromptDefinition(legacy)
await setSetting('promptMigrationV1', { version: 1, migratedAt: 1, fixedPromptId: legacy.id, customActionIds: [] })
const compatibilityCatalog = await listPromptCatalog('conversation-mode')
assert(!compatibilityCatalog.some(item => item.id === legacy.id), 'absorbed legacy fixed prompt stays hidden but remains durable')

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
