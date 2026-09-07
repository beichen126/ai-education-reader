import 'fake-indexeddb/auto'
import { newStableId, type Conversation } from '../src/engine/types.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import { initSettings } from '../src/engine/settings-store.ts'
import { setSetting } from '../src/storage/storage.ts'
import { capturePromptSnapshot } from '../src/prompts/prompt-resolution.ts'
import { BUILTIN_PROMPT_IDS, getBuiltinArtifactPrompt, getBuiltinProtocol } from '../src/prompts/prompt-registry.ts'
import { createArtifactDraft } from '../src/artifacts/artifact-service.ts'
import { generateArtifact } from '../src/artifacts/artifact-generation.ts'
import { getArtifact } from '../src/artifacts/artifact-store.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const conversationId = newStableId()
const conversation: Conversation = {
  id: conversationId,
  title: 'Artifact v2 prompt test',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: 'source-user', role: 'user', content: '真实学习材料', images: [], createdAt: 1, updatedAt: 1 },
    { id: 'source-assistant', role: 'assistant', content: '真实回答', images: [], createdAt: 2, updatedAt: 2 },
  ],
}
await saveConversation(conversation)
await setSetting('apiKey', 'sk-test')
await setSetting('customSystemPrompt', 'LEGACY CONVERSATION MODE MUST NOT ENTER ARTIFACT')
await setSetting('customSystemPromptEnabled', 'true')
await initSettings()

const noteDefinition = getBuiltinArtifactPrompt('note')!
const noteTemplate = capturePromptSnapshot(noteDefinition, 100)
const noteUserPrompt = '本次只提炼定义和易错点。'
const note = await createArtifactDraft({
  kind: 'note', conversationId, throughMessageId: 'source-assistant',
  prompt: noteUserPrompt,
  promptBundle: { template: noteTemplate, userPrompt: noteUserPrompt, resolvedAt: 100 },
} as any)
const storedNote = await getArtifact(note.id)
assert(storedNote?.promptBundle?.template?.profileId === noteDefinition.id, 'new Artifact persists the selected template snapshot')
assert(storedNote?.promptBundle?.userPrompt === noteUserPrompt && storedNote.prompt === noteUserPrompt, 'run-local user intent is persisted independently of the template')

let noteRequest: any[] = []
await generateArtifact(note.id, { call: async (args) => { noteRequest = args.messages; return 'generated note' } })
const noteText = JSON.stringify(noteRequest)
assert(!noteText.includes('LEGACY CONVERSATION MODE MUST NOT ENTER ARTIFACT'), 'Artifact request excludes legacy global Conversation Mode prepend')
assert(noteText.includes('本次只提炼定义和易错点。'), 'Artifact request carries the run-local user intent')
assert(noteRequest.filter((m) => m.role === 'system').length === 0, 'Note request does not add a machine protocol system message')

const quizDefinition = getBuiltinArtifactPrompt('quiz')!
const quizProtocol = getBuiltinProtocol('quiz-output')!
const quizTemplate = capturePromptSnapshot(quizDefinition, 200)
const quizProtocolSnapshot = capturePromptSnapshot(quizProtocol!, 200)
const quizUserPrompt = '重点考查本章的核心定义。'
const quiz = await createArtifactDraft({
  kind: 'quiz', conversationId, throughMessageId: 'source-assistant',
  prompt: quizUserPrompt,
  promptBundle: { template: quizTemplate, userPrompt: quizUserPrompt, protocol: quizProtocolSnapshot, resolvedAt: 200 },
} as any)
let quizRequest: any[] = []
const quizJson = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: '哪一项正确？', options: ['A', 'B'], answer: 0 }] })
await generateArtifact(quiz.id, { call: async (args) => { quizRequest = args.messages; return quizJson } })
const quizRoles = quizRequest.map((m) => m.role + ':' + String(m.content))
assert(quizRoles.filter((v) => v.startsWith('system:')).length === 1, 'Quiz request has exactly one protocol system message')
assert(quizRoles.some((v) => v === 'user:' + quizUserPrompt), 'Quiz request keeps user intent as a user message')
assert(quizRoles.some((v) => v.startsWith('system:') && v.includes('QuizDocument')), 'Quiz protocol system message carries the machine output contract')
assert(!quizRoles.some((v) => v.startsWith('system:') && v.includes('LEGACY CONVERSATION MODE')), 'Quiz request excludes Conversation Mode from the system scope')
const storedQuiz = await getArtifact(quiz.id)
assert(storedQuiz?.promptBundle?.protocol?.protocolDomain === 'quiz-output', 'Quiz durable bundle records the canonical quiz protocol domain')

const legacyPrompt = '旧 Artifact 的 legacy prompt'
const legacy = await createArtifactDraft({ kind: 'note', conversationId, throughMessageId: 'source-assistant', prompt: legacyPrompt })
let legacyRequest: any[] = []
await generateArtifact(legacy.id, { call: async (args) => { legacyRequest = args.messages; return 'legacy regenerated' } })
const legacyText = JSON.stringify(legacyRequest)
assert(legacyText.includes(legacyPrompt), 'legacy Artifact continues to use its stored prompt for regeneration')
assert(!legacyText.includes('LEGACY CONVERSATION MODE MUST NOT ENTER ARTIFACT'), 'legacy Artifact regeneration also avoids cross-domain global prepend')
assert((await getArtifact(legacy.id))?.promptBundle === undefined, 'legacy Artifact is not backfilled with a fabricated durable prompt bundle')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
