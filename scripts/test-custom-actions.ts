// v1.1.3: saved reusable 自定义操作 persistence (settings KV) + artifact prompt independence.
import 'fake-indexeddb/auto'
import { listCustomActions, createCustomAction, updateCustomAction, deleteCustomAction } from '../src/artifacts/custom-action-store.ts'
import { getArtifact, saveArtifact } from '../src/artifacts/artifact-store.ts'
import { TRANSFORMATION_PRESETS } from '../src/artifacts/artifact-prompts.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate } from '../src/export/backup-import.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// ---- 1. create + reload persistence ----
const created = await createCustomAction({ name: '解释得更简单', prompt: '请用适合初学者理解的方式解释以下内容。' })
assert(created.id && created.name === '解释得更简单' && created.prompt.includes('初学者'), 'create action fields set (id/name/prompt)')
assert(created.createdAt > 0 && created.updatedAt > 0, 'create action timestamps set')
assert(listCustomActions !== undefined, 'store exports list')

// ---- 2. "app restart" = re-read from settings (fresh read) ----
const afterReload = await listCustomActions()
assert(afterReload.length === 1 && afterReload[0].name === '解释得更简单', 'action survives a reload (persisted)')
assert(afterReload[0].prompt.includes('初学者'), 'reloaded prompt intact')

// ---- 3. edit (rename + prompt) + reload shows new values ----
const updated = await updateCustomAction(created.id, { name: '初学者解释', prompt: '请用只含图例的简单中文解释。' })
assert(updated && updated.name === '初学者解释' && updated.prompt === '请用只含图例的简单中文解释。', 'update action renames + changes prompt')
const afterEdit = await listCustomActions()
assert(afterEdit.length === 1 && afterEdit[0].name === '初学者解释' && afterEdit[0].prompt === '请用只含图例的简单中文解释。', 'edited values survive reload')
assert(afterEdit[0].createdAt === created.createdAt && afterEdit[0].updatedAt >= created.updatedAt, 'update bumps updatedAt, keeps createdAt')

// ---- 4. a second action, then delete one (cancel is UI; here delete) ----
const second = await createCustomAction({ name: '提取名词解释', prompt: '请提取值得记忆的名词。' })
assert((await listCustomActions()).length === 2, 'two actions listed')
await deleteCustomAction(second.id)
const afterDelete = await listCustomActions()
assert(afterDelete.length === 1 && afterDelete[0].id === created.id, 'delete removes only the target action')

// ---- 5. artifacts keep THEIR OWN prompt after the action that made them is deleted ----
const artifactPrompt = '请用适合初学者理解的方式解释以下内容。'
const artId = newStableId()
await saveArtifact({
  id: artId, kind: 'custom', title: '解释得更简单（产物）', prompt: artifactPrompt,
  source: { conversationId: 'c1', throughMessageId: 'm1', snapshot: { conversationId: 'c1', throughMessageId: 'm1', createdAt: 1, messages: [{ role: 'user', text: 'x', imageIds: [] }], provenance: [], sourceLabel: 'c1', sourceDeleted: false } },
  createdAt: 1, updatedAt: 1, status: 'ready', content: 'done',
})
await deleteCustomAction(created.id)
const kept = await getArtifact(artId)
assert(kept && kept.prompt === artifactPrompt, 'deleting a custom action does NOT change the historical artifact prompt (provenance preserved)')

// ---- 6. builtin summary / study-guide presets remain available (never deleted) ----
assert(TRANSFORMATION_PRESETS.some((p) => p.id === 'summary'), 'builtin summary preset still available')
assert(TRANSFORMATION_PRESETS.some((p) => p.id === 'study-guide'), 'builtin study-guide preset still available')

// ---- 7. backup round-trip: custom actions are carried in the settings portion ----
// Re-create two actions (the earlier ones were deleted) then export + validate.
await createCustomAction({ name: '解释得更简单', prompt: '请用适合初学者的方式解释。' })
await createCustomAction({ name: '提取名词解释', prompt: '请提取值得记忆的名词。' })
const backup = await buildBackup()
const ca = (backup.settings as { customArtifactActions?: { name: string; prompt: string }[] }).customArtifactActions || []
assert(ca.length === 2, 'backup export carries the saved custom actions (got ' + ca.length + ')')
assert(ca.some((a) => a.name === '解释得更简单') && ca.some((a) => a.name === '提取名词解释'), 'backup carries the right names + prompts')
// The backup must still validate (backward-compatible extra field).
let validated = true
try { parseAndValidate(backup as any) } catch { validated = false }
assert(validated, 'backup with customArtifactActions still validates (backward-compatible)')

// ---- 8. v1.2.0: builtin preset must be SAVED AS a new action, never updated in place ----
// A builtin preset id ('summary'/'study-guide') is NOT a saved action: updateCustomAction on it
// must return null (explicit handleable result), never silently mutate or create anything.
assert(await updateCustomAction('summary', { name: '新总结', prompt: 'p' }) === null, 'updateCustomAction("summary") -> null (builtin is not a saved action)')
assert(await updateCustomAction('study-guide', { name: '新指南', prompt: 'p' }) === null, 'updateCustomAction("study-guide") -> null')
assert(!(await listCustomActions()).some((a) => a.id === 'summary' || a.id === 'study-guide'), 'builtin ids never become saved actions')
// "另存为自定义操作" from a builtin -> createCustomAction (a NEW distinct action).
const savedSummary = await createCustomAction({ name: '总结（我的）', prompt: '请把内容总结成要点。' })
assert(savedSummary.id && savedSummary.name === '总结（我的）', 'builtin 总结 另存为 -> a new saved action is created')
const afterSaveAs = await listCustomActions()
assert(afterSaveAs.some((a) => a.name === '总结（我的）'), '另存为 action appears in listCustomActions')
assert(afterSaveAs.some((a) => a.id === 'summary') === false, 'no fake summary-named action row created')
// reload persistence of the 另存为 action
assert((await listCustomActions()).some((a) => a.name === '总结（我的）'), '另存为 action survives reload')
// editing the SAVED-as action updates it correctly
const upd = await updateCustomAction(savedSummary.id, { name: '我的总结', prompt: '请总结为 100 字。' })
assert(upd && upd.name === '我的总结' && upd.prompt === '请总结为 100 字。', 'updating the saved-as action works')
assert((await listCustomActions()).find((a) => a.id === savedSummary.id)?.prompt === '请总结为 100 字。', 'updated value survives reload')
// delete removes it; a historical artifact that used its prompt is unaffected.
const sumArtPrompt = '请总结为 100 字。'
const sumArtId = newStableId()
await saveArtifact({ id: sumArtId, kind: 'summary', title: '总结产物', prompt: sumArtPrompt, source: { conversationId: 'c1', throughMessageId: 'm1', snapshot: { conversationId: 'c1', throughMessageId: 'm1', createdAt: 1, messages: [{ role: 'user', text: 'x', imageIds: [] }], provenance: [], sourceLabel: 'c1', sourceDeleted: false } }, createdAt: 1, updatedAt: 1, status: 'ready', content: 'done' })
await deleteCustomAction(savedSummary.id)
assert(!(await listCustomActions()).some((a) => a.id === savedSummary.id), 'deleting the saved-as action removes it')
const keptArt = await getArtifact(sumArtId)
assert(keptArt && keptArt.prompt === sumArtPrompt, 'summary artifact keeps its prompt after the action is deleted')
// domain invariant: update with empty name/prompt throws, ON AN EXISTING action
const invariantProbe = await createCustomAction({ name: '探针', prompt: 'p' })
let threw = false
try { await updateCustomAction(invariantProbe.id, { name: '   ' }) } catch (e) { threw = true }
assert(threw, 'updateCustomAction with blank name throws (domain invariant)')
let threwP = false
try { await updateCustomAction(invariantProbe.id, { prompt: '' }) } catch { threwP = true }
assert(threwP, 'updateCustomAction with blank prompt throws (domain invariant)')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
