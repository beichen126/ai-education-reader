import 'fake-indexeddb/auto'
import { idbClearAll, idbGetAll } from '../src/storage/idb.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { listEffectivePromptDefinitions } from '../src/prompts/prompt-resolution.ts'
import { listPromptCatalog, savePromptDefinition } from '../src/prompts/prompt-service.ts'
import type { ArtifactPrompt } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

await idbClearAll()
const legacyCustom: ArtifactPrompt = {
  id: 'stage4-legacy-custom', kind: 'artifact', artifactKind: 'custom', name: '旧版自定义成果', description: 'legacy',
  source: 'custom', enabled: true, createdAt: 1, updatedAt: 1, revision: 1, userPrompt: '保留旧版内容。',
}
const customNote: ArtifactPrompt = {
  id: 'stage4-custom-note', kind: 'artifact', artifactKind: 'note', name: '我的笔记模板', description: 'note',
  source: 'custom', enabled: true, createdAt: 2, updatedAt: 2, revision: 1, userPrompt: '整理成笔记。',
}
await savePromptDefinition(legacyCustom)
await savePromptDefinition(customNote)

const visible = await listPromptCatalog()
const visibleArtifacts = visible.filter((item) => item.kind === 'artifact')
assert(!visible.some((item) => item.kind === 'protocol'), 'default catalog does not query or expose protocol rows')
assert(visibleArtifacts.every((item) => item.artifactKind === 'note' || item.artifactKind === 'quiz'), 'default catalog artifact rows are limited to note/quiz')
assert(!visibleArtifacts.some((item) => item.id === legacyCustom.id), 'legacy custom artifact definition is hidden from the default catalog')

const artifactCatalog = await listPromptCatalog('artifact')
assert(artifactCatalog.length === 3 && artifactCatalog.every((item) => item.kind === 'artifact' && (item.artifactKind === 'note' || item.artifactKind === 'quiz')), 'artifact category shows canonical note/quiz plus custom note templates only')
assert(!artifactCatalog.some((item) => item.artifactKind === 'custom' || item.artifactKind === 'summary' || item.artifactKind === 'study-guide'), 'artifact category excludes legacy artifact kinds')

const protocolCatalog = await listPromptCatalog('protocol')
assert(protocolCatalog.length > 0 && protocolCatalog.every((item) => item.kind === 'protocol'), 'explicit protocol category still loads protocol rows')

const effective = await listEffectivePromptDefinitions()
assert(effective.some((item) => item.id === legacyCustom.id) && effective.some((item) => item.kind === 'protocol'), 'internal effective resolution still retains legacy and protocol definitions')

const oldArtifactDefinitions = (['note', 'quiz', 'summary', 'study-guide', 'custom'] as const).map((artifactKind, index) => ({
  id: 'stage4-backup-' + artifactKind,
  kind: 'artifact' as const,
  artifactKind,
  name: '旧版 ' + artifactKind,
  description: 'legacy backup fixture',
  source: 'custom' as const,
  enabled: true,
  createdAt: index + 1,
  updatedAt: index + 1,
  revision: 1,
  userPrompt: '旧版模板 ' + artifactKind,
}))
const oldBackup = {
  format: 'ai-education-reader-backup', version: 6, exportedAt: 1,
  settings: { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false },
  conversations: [], annotations: [], attachments: [], documents: [], drafts: [], appearance: 'system',
  branches: [], branchDrafts: [], artifacts: [], activeBranches: [], documentNotes: [],
  prompts: oldArtifactDefinitions,
  promptPreferences: { version: 1, defaultConversationModeId: 'builtin-conversation-default', hiddenBuiltinPromptIds: [], activeProtocolOverrideByDomain: {} },
}
const parsedOldBackup = parseAndValidate(oldBackup)
assert(parsedOldBackup.version === 6 && parsedOldBackup.prompts.length === 5, 'legacy five artifact prompt definitions pass Backup validation')
await idbClearAll()
await restoreBackup(parsedOldBackup)
const restoredLegacyDefinitions = await idbGetAll('prompts')
assert(restoredLegacyDefinitions.length === 5 && restoredLegacyDefinitions.every((item: any) => ['note', 'quiz', 'summary', 'study-guide', 'custom'].includes(item.artifactKind)), 'legacy five artifact prompt definitions restore without loss')

console.log(`RESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
