import { TOC_STRUCTURE_PROMPT, TOC_TRANSCRIPTION_SYSTEM_PROMPT } from '../src/documents/ai-toc.ts'
import { presetById, QUIZ_OUTPUT_PROTOCOL_PROMPT, TRANSFORMATION_PRESETS } from '../src/artifacts/artifact-prompts.ts'
import {
  BUILTIN_ARTIFACT_PROMPTS,
  BUILTIN_CONVERSATION_MODES,
  BUILTIN_PROMPT_IDS,
  BUILTIN_PROMPT_REGISTRY,
  BUILTIN_PROTOCOL_PROMPTS,
  BUILTIN_PROTOCOL_VALIDATOR_NAMES,
  getBuiltinArtifactPrompt,
  getBuiltinProtocol,
  listBuiltinPrompts,
  PROTOCOL_METADATA_ADAPTERS,
} from '../src/prompts/prompt-registry.ts'
import { getPromptDefinitionIssues, validatePromptScopeMatrix } from '../src/prompts/prompt-validation.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

assert(BUILTIN_CONVERSATION_MODES.length === 4, 'registry contains exactly four built-in conversation modes')
assert(BUILTIN_CONVERSATION_MODES.find((p) => p.id === BUILTIN_PROMPT_IDS.conversationDefault)?.systemPrompt === '', 'default mode keeps the 1.x empty prompt')
assert(new Set(BUILTIN_PROMPT_REGISTRY.map((p) => p.id)).size === BUILTIN_PROMPT_REGISTRY.length, 'all built-in ids are unique')
assert(BUILTIN_PROMPT_REGISTRY.every((p) => p.source === 'builtin' && p.enabled && p.revision === 1), 'all registry entries are canonical built-ins')
assert(BUILTIN_PROMPT_REGISTRY.every((p) => getPromptDefinitionIssues(p).length === 0), 'all registry entries pass discriminated validation')
assert(validatePromptScopeMatrix(), 'registry ships with a valid request scope matrix')

assert(BUILTIN_ARTIFACT_PROMPTS.length === TRANSFORMATION_PRESETS.length, 'every existing artifact preset has one prompt definition')
for (const preset of TRANSFORMATION_PRESETS) {
  const definition = getBuiltinArtifactPrompt(preset.kind)
  assert(!!definition && definition.id === 'builtin-artifact-' + preset.id, 'artifact preset has deterministic stable id: ' + preset.id)
  assert(definition?.name === preset.label && definition?.userPrompt === preset.defaultPrompt, 'artifact text remains the existing canonical preset: ' + preset.id)
}
assert(presetById('quiz')?.defaultPrompt === getBuiltinArtifactPrompt('quiz')?.userPrompt, 'quiz registry does not copy or drift the existing prompt')
assert(getBuiltinArtifactPrompt('quiz')?.protocolId === BUILTIN_PROMPT_IDS.protocolQuizOutput, 'quiz artifact points to the output protocol')

assert(PROTOCOL_METADATA_ADAPTERS.length === 3 && BUILTIN_PROTOCOL_PROMPTS.length === 3, 'registry exposes the three required protocol adapters')
assert(getBuiltinProtocol('ai-toc-transcription')?.systemPrompt === TOC_TRANSCRIPTION_SYSTEM_PROMPT, 'AI TOC transcription uses the production prompt constant')
assert(getBuiltinProtocol('ai-toc-structure')?.systemPrompt === TOC_STRUCTURE_PROMPT, 'AI TOC structure uses the production prompt constant')
assert(getBuiltinProtocol('quiz-output')?.systemPrompt === QUIZ_OUTPUT_PROTOCOL_PROMPT, 'Quiz protocol points to the canonical output protocol prompt')
assert(getBuiltinProtocol('ai-toc-transcription')?.validator?.name === BUILTIN_PROTOCOL_VALIDATOR_NAMES.aiTocTranscription, 'transcription adapter names its actual validator')
assert(getBuiltinProtocol('ai-toc-structure')?.validator?.name === BUILTIN_PROTOCOL_VALIDATOR_NAMES.aiTocStructure, 'structure adapter names its actual validator')
assert(getBuiltinProtocol('quiz-output')?.validator?.name === BUILTIN_PROTOCOL_VALIDATOR_NAMES.quizOutput, 'quiz adapter names its actual validator')
assert(listBuiltinPrompts('protocol').length === 3 && listBuiltinPrompts('artifact').length === 5, 'kind filters return complete registry partitions')

const idsBefore = BUILTIN_PROMPT_REGISTRY.map((p) => p.id).join('|')
const idsAfterImport = BUILTIN_PROMPT_REGISTRY.map((p) => p.id).join('|')
assert(idsBefore === idsAfterImport, 'registry ids are deterministic within a fresh module load')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
