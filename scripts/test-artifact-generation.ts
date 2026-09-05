import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { createArtifactDraft, updateArtifactContent, markArtifactReady } from '../src/artifacts/artifact-service.ts'
import { generateArtifact, ArtifactGenerationError } from '../src/artifacts/artifact-generation.ts'
import { getArtifact } from '../src/artifacts/artifact-store.ts'
import { parseQuizDocument } from '../src/artifacts/artifact-validation.ts'
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

// ---- 8. A1: draft -> generating (only while it owns the lock) -> ready ----
const obsArt = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
let sawGenerating = false
const obsOut = await generateArtifact(obsArt.id, { call: async () => { const inFlight = await getArtifact(obsArt.id); sawGenerating = inFlight?.status === 'generating'; return 'OBS' } })
assert(sawGenerating, 'artifact is GENERATING only while it owns the lock (observed mid-call)')
assert(obsOut.status === 'ready' && obsOut.content === 'OBS', 'generation finalizes ready')

// ---- 9. A1: busy lock after draft creation leaves NO 'generating' zombie ----
globalGenerationLock.tryAcquire('artifact:busy-check', new AbortController())
const busyDraft = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const busyThrown2 = await asyncThrows(() => generateArtifact(busyDraft.id, { call: async () => 'X' }))
const busyAfter = await getArtifact(busyDraft.id)
assert(busyThrown2, 'busy generation is refused')
assert(busyAfter && busyAfter.status === 'draft', 'busy attempt leaves the artifact as DRAFT, never a generating zombie')
globalGenerationLock.release('artifact:busy-check')

// ---- 10. A1: a second simultaneous generation request cannot run concurrently ----
const d1 = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const slowPromise = generateArtifact(d1.id, { call: async () => { await new Promise((res) => setTimeout(res, 60)); return 'D1' } })
const d2 = await createArtifactDraft({ kind: 'note', conversationId: cv, throughMessageId: 'm0', prompt: 'p' })
const d2Res = await asyncThrows(() => generateArtifact(d2.id, { call: async () => 'D2' }))
const d2After = await getArtifact(d2.id)
await slowPromise
assert(d2Res, 'a second generation while one is running is refused (no double)')
assert(d2After && d2After.status === 'draft', 'refused second artifact stays draft (non-zombie)')

// ---- 11. A4: normalization letter answer "B" -> 1, option -> options, "true"/错误 -> boolean ----
const normSingle = parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q', options: ['甲', '乙', '丙', '丁'], answer: 'B' }] }))
assert(normSingle.questions[0].answer === 1, 'normalization maps letter answer "B" -> 1 for single-choice')
const normMulti = parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'multiple-choice', question: 'Q', options: ['A', 'B', 'C'], answers: ['A', 'C'] }] }))
assert(normMulti.questions[0].answers.join(',') === '0,2', 'normalization maps letter answers ["A","C"] -> [0,2]')
const normAlias = parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q', option: ['x', 'y'], answer: 0 }] }))
assert(normAlias.questions[0].options.join(',') === 'x,y', 'normalization maps option -> options')
const normTF = parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'true-false', question: 'Q', answer: 'true' }, { id: 'q2', type: 'true-false', question: 'Q2', answer: '错误' }] }))
assert(normTF.questions[0].answer === true && normTF.questions[1].answer === false, 'normalization maps "true"/错误 to booleans')

// ---- 12. A4: unfixable/ambiguous output is NOT guessed — strict schema error ----
const badText = await asyncThrows(async () => parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q', options: ['a', 'b'], answer: 'the first one' }] })))
assert(badText, 'ambiguous text answer is NOT guessed; strict schema error')
const badLetterRange = await asyncThrows(async () => parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q', options: ['a', 'b'], answer: 'Z' }] })))
assert(badLetterRange, 'out-of-range letter answer is rejected (index out of bounds)')

// ---- 13. A5: invalid quiz generation keeps RAW output + specific per-question reason ----
const rawArt = await createArtifactDraft({ kind: 'quiz', conversationId: cv, throughMessageId: 'm0', prompt: 'make quiz' })
const rawJson = JSON.stringify({ questions: [{ id: 'q1', type: 'multiple-choice', question: 'Q', options: ['a', 'b'], answers: [5] }] })
const rawThrown = await asyncThrows(() => generateArtifact(rawArt.id, { call: async () => rawJson }))
const rawAfter = await getArtifact(rawArt.id)
assert(rawThrown, 'invalid quiz generation throws')
assert(rawAfter && rawAfter.status === 'error', 'invalid quiz marked error (not ready)')
assert(rawAfter && rawAfter.generatedContent === rawJson, 'A5: raw model output preserved on invalid quiz')
assert(rawAfter && /第 1 题/.test(rawAfter.error ?? ''), 'A5: specific failing question appears in error message')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
