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

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
