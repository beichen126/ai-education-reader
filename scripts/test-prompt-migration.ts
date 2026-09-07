import 'fake-indexeddb/auto'
import { getSetting, saveConversation, setSetting } from '../src/storage/storage.ts'
import { closeDb, idbClearAll, idbGetAll } from '../src/storage/idb.ts'
import { getPromptPreferences } from '../src/prompts/prompt-preferences.ts'
import { getPromptRecord, listPromptRecordsByKind, savePromptRecord } from '../src/prompts/prompt-store.ts'
import { hasLegacyPromptMigrationMarker, migrateLegacyPrompts } from '../src/prompts/prompt-migration.ts'
import { createCustomAction, deleteCustomAction, listCustomActions, updateCustomAction } from '../src/artifacts/custom-action-store.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import type { ArtifactPrompt, ConversationModePrompt } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const fixedText = '  你是一位严谨的学习教练。\n请先解释再追问。  '
const oldAction = { id: 'legacy-action-1', name: '自定义整理', prompt: '请整理成三层要点。', createdAt: 11, updatedAt: 12 }

await idbClearAll()
const conversation = { id: 'legacy-conversation', title: '旧会话', createdAt: 1, updatedAt: 2, messages: [{ id: 'legacy-message', role: 'user', content: '旧内容', images: [], createdAt: 1, updatedAt: 1 }] }
await saveConversation(conversation)
await setSetting('customSystemPrompt', fixedText)
await setSetting('customSystemPromptEnabled', 'true')
await setSetting('customArtifactActions', [oldAction])

let idCounter = 0
const first = await migrateLegacyPrompts({ id: () => 'migrated-' + (++idCounter), now: () => 100 + idCounter })
assert(first.migrated && first.marker.version === 1, 'legacy migration commits a versioned marker')
assert(first.marker.fixedPromptId === 'migrated-1', 'fixed prompt receives one stable migrated id')
assert(first.marker.customActionIds.length === 1 && first.marker.customActionIds[0] === oldAction.id, 'custom action keeps its legacy stable id')

const fixed = await getPromptRecord(first.marker.fixedPromptId!) as ConversationModePrompt | undefined
assert(!!fixed && fixed.name === '原固定提示词' && fixed.systemPrompt === fixedText, 'fixed prompt text is preserved byte-for-byte')
assert(!!fixed && fixed.enabled === true && fixed.source === 'custom' && fixed.revision === 1, 'fixed prompt becomes an enabled custom conversation mode')
const migratedAction = await getPromptRecord(oldAction.id) as ArtifactPrompt | undefined
assert(!!migratedAction && migratedAction.kind === 'artifact' && migratedAction.artifactKind === 'custom', 'custom action becomes an ArtifactPrompt')
assert(!!migratedAction && migratedAction.name === oldAction.name && migratedAction.userPrompt === oldAction.prompt && migratedAction.createdAt === 11 && migratedAction.updatedAt === 12, 'custom action fields and timestamps survive migration')
assert((await getPromptPreferences()).defaultConversationModeId === first.marker.fixedPromptId, 'enabled legacy fixed prompt becomes the future default mode')
assert((await getSetting('customSystemPrompt')) === fixedText && (await getSetting('customSystemPromptEnabled')) === 'true', 'legacy fixed prompt settings remain read-only compatibility data')
assert(JSON.stringify(await getSetting('customArtifactActions')) === JSON.stringify([oldAction]), 'legacy custom action settings remain unchanged')
const untouched = await new Promise<any>((resolve) => { const request = indexedDB.open('ai-education-reader'); request.onsuccess = () => { const db = request.result; const tx = db.transaction('conversations'); const get = tx.objectStore('conversations').get(conversation.id); get.onsuccess = () => resolve(get.result) } })
assert(untouched && untouched.promptTransitions === undefined, 'migration does not fabricate old conversation transitions')

const second = await migrateLegacyPrompts({ id: () => 'should-not-be-used', now: () => 999 })
assert(!second.migrated && second.marker.fixedPromptId === first.marker.fixedPromptId, 'restarting migration is idempotent')
assert((await idbGetAll('prompts')).length === 2, 'restarting migration creates no duplicate prompt rows')
assert(await hasLegacyPromptMigrationMarker(), 'migration marker is durable')

// After migration, the compatibility facade writes new custom actions only to prompts.
const created = await createCustomAction({ name: '迁移后操作', prompt: '请给出一个反例。' })
assert((await getPromptRecord(created.id))?.kind === 'artifact', 'new custom action is written to prompts store')
assert((await getSetting('customArtifactActions'))?.length === 1, 'new custom action does not dual-write legacy settings')
assert((await listCustomActions()).some((action) => action.id === created.id), 'custom action facade reads migrated and new prompt rows')
const edited = await updateCustomAction(created.id, { prompt: '请给出两个反例。' })
assert(edited?.prompt === '请给出两个反例。' && (await getPromptRecord(created.id) as any)?.userPrompt === '请给出两个反例。', 'post-migration update stays in prompts store')
await deleteCustomAction(created.id)
assert((await getPromptRecord(created.id)) === undefined, 'post-migration delete removes only the prompt row')

// A disabled fixed prompt is migrated as a reusable disabled profile but must not
// silently replace the built-in default mode.
await idbClearAll()
await setSetting('customSystemPrompt', '停用的旧提示词')
await setSetting('customSystemPromptEnabled', false)
const disabled = await migrateLegacyPrompts({ id: () => 'disabled-fixed', now: () => 200 })
const disabledPrompt = await getPromptRecord(disabled.marker.fixedPromptId!) as ConversationModePrompt | undefined
assert(!!disabledPrompt && disabledPrompt.enabled === false, 'disabled fixed prompt remains disabled after migration')
assert((await getPromptPreferences()).defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault, 'disabled fixed prompt does not become the default mode')

// V6 restore may already contain migrated rows but not the internal marker.
await idbClearAll()
const restoredMode: ConversationModePrompt = { id: 'restored-mode', kind: 'conversation-mode', name: '原固定提示词', description: '旧', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: 'restored' }
const restoredAction: ArtifactPrompt = { id: 'restored-action', kind: 'artifact', artifactKind: 'custom', name: '旧操作', description: '旧', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, userPrompt: '旧 prompt' }
await savePromptRecord(restoredMode)
await savePromptRecord(restoredAction)
await setSetting('customSystemPrompt', 'restored')
await setSetting('customSystemPromptEnabled', 'true')
await setSetting('customArtifactActions', [{ id: restoredAction.id, name: restoredAction.name, prompt: restoredAction.userPrompt, createdAt: 1, updatedAt: 1 }])
const restored = await migrateLegacyPrompts({ id: () => 'duplicate-must-not-exist', now: () => 300 })
assert(restored.marker.fixedPromptId === restoredMode.id && restored.marker.customActionIds[0] === restoredAction.id, 'migration reuses equivalent V6 prompt rows after restore')
assert((await idbGetAll('prompts')).length === 2, 'restore compatibility path remains duplicate-free')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
