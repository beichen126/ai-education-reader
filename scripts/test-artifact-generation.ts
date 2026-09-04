import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { createArtifactDraft, updateArtifactContent, markArtifactReady } from '../src/artifacts/artifact-service.ts'
import { generateArtifact, ArtifactGenerationError } from '../src/artifacts/artifact-generation.ts'
import { getArtifact } from '../src/artifacts/artifact-store.ts'
import { globalGenerationLock } from '../src/engine/chat-generation-service.ts'
import { saveSettings, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function asyncThrows(fn: () => Promise<unknown>): Promise<boolean> { return fn().then(() => false, () => true) }

await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test' })
const cv = newStableId()
await saveConversation({ id: cv, title: 't', createdAt: 1, updatedAt: 1, messages: [msg('m0', 'user', 'source text')] })

// ---- 1. note generation success ----
const note = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'make note' })
const noteOut = await generateArtifact(note.id, { call: async () => 'NOTE CONTENT' })
assert(noteOut.status === 'ready' && noteOut.content === 'NOTE CONTENT' && noteOut.generatedContent === 'NOTE CONTENT', 'note generation finalizes ready')

// ---- 2. quiz generation success ----
const quiz = await createArtifactDraft({ kind: 'quiz', conversationId: cv, throughMessageId: 'm0', prompt: 'make quiz' })
const qJson = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q?', options: ['A', 'B'], answer: 0 }] })
const quizOut = await generateArtifact(quiz.id, { call: async () => qJson })
assert(quizOut.status === 'ready' && quizOut.quiz && quizOut.quiz.questions.length === 1, 'quiz generation parses + stores structured quiz')

// ---- 3. malformed quiz -> error + retryable, never saved ready ----
const qbad = await createArtifactDraft({ kind: 'quiz', conversationId: cv, throughMessageId: 'm0', prompt: 'make quiz' })
const badThrown = await asyncThrows(() => generateArtifact(qbad.id, { call: async () => 'THIS IS NOT JSON' }))
const qbadAfter = await getArtifact(qbad.id)
assert(badThrown && qbadAfter && qbadAfter.status === 'error', 'malformed quiz marked error (not ready)')

// ---- 4. regeneration must not silently destroy edits ----
const editArt = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
await generateArtifact(editArt.id, { call: async () => 'ORIGINAL' })
await updateArtifactContent(editArt.id, 'MY EDIT')
const regenThrown = await asyncThrows(() => generateArtifact(editArt.id, { call: async () => 'REGENERATED' }))
const editAfter = await getArtifact(editArt.id)
assert(regenThrown && editAfter && editAfter.content === 'MY EDIT', 'regenerate on finalized artifact is rejected; edit preserved')

// ---- 5. stale write dropped when edited mid-generation ----
const midArt = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const midThrown = await asyncThrows(() => generateArtifact(midArt.id, { call: async () => { await updateArtifactContent(midArt.id, 'EDITED-DURING-GEN'); return 'GEN' } }))
const midAfter = await getArtifact(midArt.id)
assert(midThrown && midAfter && midAfter.content === 'EDITED-DURING-GEN', 'late generation write dropped; mid-edit preserved')

// ---- 6. global generation lock: busy generation refused ----
const busyArt = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const acq = globalGenerationLock.tryAcquire('other-job', new AbortController())
assert(acq === true, 'lock acquired for a foreign job')
const busyThrown = await asyncThrows(() => generateArtifact(busyArt.id, { call: async () => 'X' }))
assert(busyThrown, 'second generation refused while another model job holds the lock')
globalGenerationLock.release('other-job')

// ---- 7. deleted artifact cannot be generated (not-found) ----
const gone = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const { removeArtifact } = await import('../src/artifacts/artifact-service.ts')
await removeArtifact(gone.id)
const goneThrown = await asyncThrows(() => generateArtifact(gone.id, { call: async () => 'X' }))
assert(goneThrown, 'generating a deleted artifact is refused (cannot resurrect)')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
