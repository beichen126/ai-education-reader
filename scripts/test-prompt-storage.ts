import 'fake-indexeddb/auto'
import { closeDb, idbClearAll, idbGet, idbReplaceAll } from '../src/storage/idb.ts'
import { setSetting } from '../src/storage/storage.ts'
import { BUILTIN_PROMPT_IDS, BUILTIN_PROMPT_REGISTRY, getBuiltinPrompt } from '../src/prompts/prompt-registry.ts'
import { capturePromptSnapshot } from '../src/prompts/prompt-resolution.ts'
import {
  copyPromptDefinition,
  deletePromptDefinition,
  getPromptDefinition,
  getPromptNameWarnings,
  listPromptCatalog,
  nextPromptRevision,
  savePromptDefinition,
  setPromptEnabled,
  setPromptSortPreference,
  updatePromptDefinition,
  PromptServiceError,
} from '../src/prompts/prompt-service.ts'
import { getPromptPreferences, getPromptPreferencesWithDiagnostics, setActiveProtocolOverride, setBuiltinPromptHidden, setDefaultConversationModeId, updatePromptPreferences, updatePromptPreferencesAtomic } from '../src/prompts/prompt-preferences.ts'
import { getPromptRecord, listPromptRecordsByKind, savePromptRecord } from '../src/prompts/prompt-store.ts'
import type { PromptDefinition } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function isServiceError(error: unknown, code: PromptServiceError['code']): boolean {
  return error instanceof PromptServiceError && error.code === code
}

await idbClearAll()
let idCounter = 0
let clock = 100
const deps = { id: () => 'custom-' + (++idCounter), now: () => ++clock }

const first: PromptDefinition = {
  id: 'custom-first', kind: 'conversation-mode', name: '我的模式', description: '本地模式', source: 'custom', enabled: true,
  createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: '先解释，再提问。',
}
const saved = await savePromptDefinition(first, deps)
assert(saved.definition.id === first.id && saved.definition.updatedAt === 101, 'custom definition saves with injected durable timestamp')
assert((await getPromptRecord(first.id))?.systemPrompt === first.systemPrompt, 'saved custom prompt is readable from prompts store')
assert((await listPromptRecordsByKind('conversation-mode')).some((p) => p.id === first.id), 'by_kind index returns the saved definition')
await closeDb()
assert((await getPromptDefinition(first.id))?.id === first.id, 'custom prompt survives IDB close/reopen')

const sameName: PromptDefinition = { ...first, id: 'custom-second', systemPrompt: '换一种解释。', createdAt: 2, updatedAt: 2, revision: 1 }
const warningSave = await savePromptDefinition(sameName, deps)
assert(warningSave.warnings.length === 1 && warningSave.warnings[0].code === 'duplicate-name', 'same-name save returns warning metadata')
assert((await getPromptRecord(sameName.id))?.id === sameName.id, 'same-name warning does not block persistence')

const builtIn = getBuiltinPrompt(BUILTIN_PROMPT_IDS.conversationSocratic)!
let collidingRowRejected = false
try { await savePromptRecord({ ...builtIn, source: 'custom' }) } catch { collidingRowRejected = true }
assert(collidingRowRejected, 'prompt store rejects a custom row that shadows a built-in stable ID')
const protocolBuiltIn = getBuiltinPrompt(BUILTIN_PROMPT_IDS.protocolAiTocTranscription)!
const detachedProtocol = getBuiltinPrompt(BUILTIN_PROMPT_IDS.protocolAiTocTranscription) as any
if (detachedProtocol.kind === 'protocol' && detachedProtocol.validator) detachedProtocol.validator.name = 'mutated outside registry'
assert(protocolBuiltIn.kind === 'protocol' && protocolBuiltIn.validator?.name !== 'mutated outside registry', 'built-in getter returns a detached nested validator clone')
assert(Object.isFrozen(protocolBuiltIn) === false && Object.isFrozen(BUILTIN_PROMPT_REGISTRY), 'canonical built-in registry is frozen while public getter is mutable')
let rejected = false
try { await savePromptDefinition(builtIn, deps) } catch (error) { rejected = isServiceError(error, 'builtin-immutable') }
assert(rejected, 'direct built-in update/save is rejected by service')
rejected = false
try { await deletePromptDefinition(builtIn.id) } catch (error) { rejected = isServiceError(error, 'builtin-immutable') }
assert(rejected, 'built-in delete is rejected by service')
assert((await getBuiltinPrompt(builtIn.id))?.source === 'builtin', 'rejected built-in mutation leaves canonical registry unchanged')

const copied = await copyPromptDefinition(builtIn.id, { name: '我的苏格拉底模式' }, deps)
assert(copied.definition.source === 'custom' && copied.definition.id === 'custom-1' && copied.definition.revision === 1, 'copy creates a new custom stable id')
assert((await getPromptRecord(copied.definition.id))?.name === '我的苏格拉底模式', 'copied definition is durably saved')
const protocolCopy = await copyPromptDefinition(BUILTIN_PROMPT_IDS.protocolAiTocStructure, {}, deps)
assert(protocolCopy.definition.source === 'experimental' && protocolCopy.definition.kind === 'protocol' && protocolCopy.definition.baseProtocolId === BUILTIN_PROMPT_IDS.protocolAiTocStructure, 'protocol copy becomes an experimental override with lineage')
const activeOverride = await setActiveProtocolOverride('ai-toc-structure', protocolCopy.definition.id)
assert(activeOverride.activeProtocolOverrideByDomain['ai-toc-structure'] === protocolCopy.definition.id, 'active protocol override validates experimental lineage and persists atomically')
let invalidOverride = false
try { await setActiveProtocolOverride('ai-toc-structure', BUILTIN_PROMPT_IDS.protocolAiTocStructure) } catch { invalidOverride = true }
assert(invalidOverride, 'active protocol override rejects a built-in protocol')

const unchanged = await updatePromptDefinition(first.id, { name: '我的模式改名', description: '新描述' }, deps)
assert(unchanged.definition.revision === 1, 'metadata-only edit does not bump behavior revision')
const changed = await updatePromptDefinition(first.id, { systemPrompt: '先提问，再根据回答解释。' }, deps)
assert(changed.definition.revision === 2, 'system prompt edit bumps behavior revision')
assert(nextPromptRevision(changed.definition, { ...changed.definition, sortOrder: undefined } as PromptDefinition) === 2, 'revision helper is pure for unchanged behavior')
const quick: PromptDefinition = { id: 'quick', kind: 'quick-follow-up', name: '追问', description: '', source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 4, label: '举例', userPrompt: '请举例。', pinned: false, sortOrder: 0 }
assert(nextPromptRevision(quick, { ...quick, pinned: true, sortOrder: 9 }) === 4, 'quick follow-up pin/sort changes do not bump content revision')
const [raceA, raceB] = await Promise.all([
  updatePromptDefinition(first.id, { systemPrompt: 'race A' }, deps),
  updatePromptDefinition(first.id, { systemPrompt: 'race B' }, deps),
])
const raceRevisions = [raceA.definition.revision, raceB.definition.revision].sort((a, b) => a - b)
assert(raceRevisions[0] === 3 && raceRevisions[1] === 4 && (await getPromptRecord(first.id))?.revision === 4, 'concurrent semantic updates commit durable revisions N+1 then N+2')

const disabled = await setPromptEnabled(first.id, false, deps)
assert(disabled.definition.enabled === false && (await getPromptRecord(first.id))?.enabled === false, 'custom enable/disable persists in the definition')
assert((await getPromptRecord(first.id))?.revision === 4, 'enable/disable does not bump behavior revision')
await setPromptEnabled(first.id, true, deps)

const hidden = await setPromptEnabled(BUILTIN_PROMPT_IDS.conversationDeepExplanation, false)
assert(hidden.definition.enabled === false, 'built-in disable is represented as a user preference')
assert((await getBuiltinPrompt(BUILTIN_PROMPT_IDS.conversationDeepExplanation))?.enabled === true, 'built-in disable does not mutate source registry')
assert((await listPromptCatalog('conversation-mode')).find((p) => p.id === BUILTIN_PROMPT_IDS.conversationDeepExplanation)?.enabled === false, 'catalog applies hidden built-in preference')
await setBuiltinPromptHidden(BUILTIN_PROMPT_IDS.conversationDeepExplanation, false)

await setPromptSortPreference('name-asc')
const sorted = await listPromptCatalog()
assert(sorted.every((item, index) => index === 0 || sorted[index - 1].name.localeCompare(item.name, 'zh-CN') <= 0), 'catalog applies persisted sort preference')
await setPromptSortPreference('updatedAt-desc')
const prefs = await setDefaultConversationModeId(BUILTIN_PROMPT_IDS.conversationExamCoaching)
assert(prefs.defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationExamCoaching, 'prompt preferences persist default mode as one record')
assert((await getPromptPreferences()).defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationExamCoaching, 'prompt preferences survive reload')

await Promise.all([
  updatePromptPreferences({ sortPreference: 'name-asc' }),
  updatePromptPreferences({ hiddenBuiltinPromptIds: [BUILTIN_PROMPT_IDS.conversationSocratic] }),
])
const concurrentPreferences = await getPromptPreferences()
assert(concurrentPreferences.sortPreference === 'name-asc' && concurrentPreferences.hiddenBuiltinPromptIds.includes(BUILTIN_PROMPT_IDS.conversationSocratic), 'concurrent unrelated preference patches preserve both fields')
const atomicMarker = await updatePromptPreferencesAtomic((current) => ({ ...current, sortPreference: 'updatedAt-desc' }))
assert(atomicMarker.sortPreference === 'updatedAt-desc' && (await getPromptPreferences()).sortPreference === 'updatedAt-desc', 'canonical atomic preference helper returns committed value')
await setSetting('promptPreferences', { version: 99, defaultConversationModeId: '', hiddenBuiltinPromptIds: ['not-a-built-in', BUILTIN_PROMPT_IDS.conversationSocratic, BUILTIN_PROMPT_IDS.conversationSocratic], activeProtocolOverrideByDomain: { '': '' }, sortPreference: 'bad' })
const normalizedCorrupt = await getPromptPreferencesWithDiagnostics()
assert(normalizedCorrupt.preferences.defaultConversationModeId === BUILTIN_PROMPT_IDS.conversationDefault && normalizedCorrupt.preferences.hiddenBuiltinPromptIds.length === 1 && normalizedCorrupt.diagnostics.length >= 5, 'corrupted local preferences normalize with explicit diagnostics')

const snapshot = capturePromptSnapshot(changed.definition, 999)
await deletePromptDefinition(first.id)
assert((await getPromptRecord(first.id)) === undefined, 'custom delete removes the persisted definition')
assert(snapshot.content === '先提问，再根据回答解释。', 'deleting a definition does not alter an existing snapshot value')

let badSave = false
try { await savePromptRecord({ ...sameName, id: '' }) } catch { badSave = true }
assert(badSave && (await idbGet('prompts', sameName.id)) !== undefined, 'invalid save rejects without replacing existing prompt data')

await idbReplaceAll({ settings: [], conversations: [], attachments: [], annotations: [], prompts: [] })
assert((await idbGet('prompts', sameName.id)) === undefined, 'replace-all clears prompts when restore input has no prompt rows')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
