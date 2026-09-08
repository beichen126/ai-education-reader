import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
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

console.log(`RESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
