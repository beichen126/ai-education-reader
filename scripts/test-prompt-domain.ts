import {
  getPromptDefinitionIssues,
  getPromptSnapshotIssues,
  getPromptScopeMatrixIssues,
  getPromptScopeSelectionIssues,
  isPromptScopeSelectionValid,
  promptContent,
  validatePromptDefinition,
  validatePromptScopeMatrix,
} from '../src/prompts/prompt-validation.ts'
import { capturePromptSnapshot, resolvePromptDefinition } from '../src/prompts/prompt-resolution.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import type { PromptDefinition } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const common = { id: 'p', name: 'P', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1 }
const definitions: PromptDefinition[] = [
  { ...common, kind: 'conversation-mode', systemPrompt: 'system' },
  { ...common, id: 'a', kind: 'artifact', artifactKind: 'note', userPrompt: 'artifact' },
  { ...common, id: 'q', kind: 'quick-follow-up', label: '举例', userPrompt: 'follow up', pinned: false, sortOrder: 0 },
  { ...common, id: 'r', kind: 'protocol', domain: 'quiz-output', systemPrompt: 'protocol', overridePolicy: 'read-only' },
]

for (const definition of definitions) {
  assert(validatePromptDefinition(definition) !== null, definition.kind + ' definition validates')
  assert(getPromptDefinitionIssues(definition).length === 0, definition.kind + ' has no validation issue')
  assert(promptContent(definition).length >= 0, definition.kind + ' has exhaustive content resolution')
}

const snapshotSource = definitions[0]
const snapshot = capturePromptSnapshot(snapshotSource, 1234)
snapshotSource.systemPrompt = 'mutated definition'
assert(snapshot.content === 'system', 'snapshot content is independent from definition mutation')
assert(snapshot.capturedAt === 1234 && snapshot.profileId === 'p' && snapshot.source === 'custom', 'snapshot captures injected time, id and source')
const artifactSnapshot = capturePromptSnapshot(definitions[1], 1234)
const quickSnapshot = capturePromptSnapshot(definitions[2], 1234)
const protocolSnapshot = capturePromptSnapshot(definitions[3], 1234)
assert(artifactSnapshot.kind === 'artifact' && artifactSnapshot.artifactKind === 'note', 'artifact snapshot carries artifactKind metadata')
assert(quickSnapshot.kind === 'quick-follow-up' && quickSnapshot.label === '举例' && quickSnapshot.pinned === false && quickSnapshot.sortOrder === 0, 'quick follow-up snapshot carries interaction metadata')
assert(protocolSnapshot.kind === 'protocol' && protocolSnapshot.protocolDomain === 'quiz-output' && protocolSnapshot.overridePolicy === 'read-only', 'protocol snapshot carries domain and contract metadata')
assert(protocolSnapshot.kind === 'protocol' && getPromptSnapshotIssues({ ...protocolSnapshot, validator: { name: 'Quiz validator', description: 'strict' } }).length === 0, 'protocol snapshot accepts complete validator metadata')
assert(getPromptSnapshotIssues({ ...artifactSnapshot, artifactKind: undefined }).some((issue) => issue.code === 'INVALID_ARTIFACT_KIND'), 'snapshot rejects a missing artifactKind')
assert(getPromptSnapshotIssues({ ...artifactSnapshot, protocolDomain: 'quiz-output' }).some((issue) => issue.code === 'UNEXPECTED_FIELD'), 'snapshot rejects cross-kind protocol metadata on artifacts')
assert(getPromptSnapshotIssues({ ...protocolSnapshot, artifactKind: 'quiz' }).some((issue) => issue.code === 'UNEXPECTED_FIELD'), 'snapshot rejects cross-kind artifact metadata on protocols')

const invalid = { ...definitions[0], kind: 'artifact', artifactKind: 'not-a-kind' }
assert(validatePromptDefinition(invalid) === null, 'discriminated union rejects mismatched artifact definition')
assert(getPromptDefinitionIssues(invalid).some((issue) => issue.code === 'INVALID_ARTIFACT_KIND'), 'invalid artifact kind has a precise issue')

assert(validatePromptScopeMatrix(), 'canonical scope matrix validates')
assert(getPromptScopeMatrixIssues().length === 0, 'canonical scope matrix has no issues')
assert(isPromptScopeSelectionValid('conversation', ['conversation-mode']), 'normal conversation allows conversation mode')
assert(isPromptScopeSelectionValid('conversation-quick-follow-up', ['conversation-mode', 'quick-follow-up']), 'quick follow-up keeps conversation mode and adds a user prompt')
assert(!isPromptScopeSelectionValid('ai-toc-transcription', ['conversation-mode']), 'AI TOC transcription rejects conversation mode')
assert(getPromptScopeSelectionIssues('artifact-quiz', ['artifact']).some((issue) => issue.code === 'REQUIRED_SCOPE_MISSING'), 'quiz requires its machine protocol')

const fallback = resolvePromptDefinition('missing', definitions, { fallbackId: 'p', expectedKind: 'conversation-mode' })
assert(fallback.usedFallback && fallback.definition?.id === 'p' && fallback.diagnostics.some((d) => d.code === 'missing'), 'resolver returns a diagnostic and safe fallback')
const wrongKind = resolvePromptDefinition('a', definitions, { fallbackId: 'p', expectedKind: 'conversation-mode' })
assert(wrongKind.usedFallback && wrongKind.definition?.id === 'p' && wrongKind.diagnostics.some((d) => d.code === 'kind-mismatch'), 'resolver rejects a wrong-scope definition')
const disabled = resolvePromptDefinition('p', definitions.map((d) => d.id === 'p' ? { ...d, enabled: false } : d), { fallbackId: 'p' })
assert(disabled.definition === undefined && disabled.diagnostics.some((d) => d.code === 'disabled'), 'disabled fallback is not silently selected')

assert(BUILTIN_PROMPT_IDS.conversationDefault.length > 0, 'built-in ids are stable string constants')
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
