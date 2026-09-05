import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation, deleteConversation, getConversation } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import { createBranchFromMessage, acceptBranchUserMessage } from '../src/branches/branch-service.ts'
import { listBranchesByConversation } from '../src/branches/branch-store.ts'
import { buildSourceSnapshot, createArtifactDraft, materializeSourceMessages, updateArtifactContent, updateArtifactTitle, markArtifactReady, markArtifactError, removeArtifact, isArtifactSourceLive } from '../src/artifacts/artifact-service.ts'
import { getArtifact, listArtifacts } from '../src/artifacts/artifact-store.ts'
import { parseQuizDocument, validateQuizDocument, QuizValidationError, validateArtifact } from '../src/artifacts/artifact-validation.ts'
import { presetForKind, TRANSFORMATION_PRESETS } from '../src/artifacts/artifact-prompts.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function throws(fn: () => unknown): boolean { try { fn(); return false } catch { return true } }

const convId = newStableId()
const conv: Conversation = { id: convId, title: 't', createdAt: 1, updatedAt: 1, messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')] }
await saveConversation(conv)

// ---- 1. snapshot freezes through selected message ----
const snap = await buildSourceSnapshot(convId, undefined, 'm1')
assert(snap.messages.map((m) => m.text).join(',') === 'hi,hi', 'snapshot has messages through m1 only')
assert(snap.messages.length === 2, 'snapshot excludes post-fork later messages')
assert(snap.throughMessageId === 'm1' && !snap.sourceDeleted, 'snapshot records source point + not deleted')

// ---- 2. nested branch source materializes correctly ----
const b = await createBranchFromMessage(convId, 'm1')
await acceptBranchUserMessage(b.id, msg('a0', 'user', 'branchcontent'))
const snapB = await buildSourceSnapshot(convId, b.id, 'a0')
assert(snapB.messages.map((m) => m.text).join(',') === 'hi,hi,branchcontent', 'branch snapshot includes inherited + local through a0')
const mat = materializeSourceMessages({ conversationId: convId, branchId: b.id, throughMessageId: 'a0', snapshot: snapB })
assert(mat.map((m) => m.content).join(',') === 'hi,hi,branchcontent', 'materializeSourceMessages returns frozen source messages')
assert(mat.length === 3 && mat[2].content === 'branchcontent', 'frozen source messages exclude no later messages')

// ---- 3. custom prompt stored exactly + preset registry present ----
const art = await createArtifactDraft({ kind: 'note', conversationId: convId, branchId: b.id, throughMessageId: 'a0', prompt: 'MY CUSTOM PROMPT', presetId: 'note' })
assert(art.prompt === 'MY CUSTOM PROMPT', 'custom prompt stored exactly')
assert(art.status === 'draft' && art.source.snapshot.sourceDeleted === false, 'new artifact is a draft (NOT generating until it owns the lock) with frozen snapshot')
assert(presetForKind('note')!.defaultPrompt.length > 0, 'preset prompt exists in registry (not JSX)')
assert(TRANSFORMATION_PRESETS.length === 5 && presetForKind('custom')!.kind === 'custom', 'five presets incl. custom')

// ---- 4. note edits persist + generatedContent preserved ----
const ready = await markArtifactReady(art.id, { content: 'ORIGINAL NOTE', generatedText: 'ORIGINAL NOTE' }, art.updatedAt)
assert(ready && ready.status === 'ready' && ready.generatedContent === 'ORIGINAL NOTE', 'generation finalized to ready')
const edited = await updateArtifactContent(art.id, 'MY EDIT')
assert(edited && edited.content === 'MY EDIT' && edited.generatedContent === 'ORIGINAL NOTE', 'user edit persists, generated original distinguishable')
const edited2 = await updateArtifactTitle(art.id, 'new note title')
assert(edited2 && edited2.title === 'new note title', 'title edit persists')

// ---- 5. regeneration does not silently destroy edits (stale write dropped) ----
const nowArt = await getArtifact(art.id)
const stale = await markArtifactReady(art.id, { content: 'REGENERATED', generatedText: 'REGENERATED' }, nowArt!.updatedAt - 10000)
assert(stale === undefined, 'stale generation write rejected (does not overwrite edit)')
const stillEdited = await getArtifact(art.id)
assert(stillEdited && stillEdited.content === 'MY EDIT', 'edited content not destroyed by stale regeneration')

// ---- 6. note survives source conversation deletion ----
const noteArt = await createArtifactDraft({ kind: 'note', conversationId: convId, throughMessageId: 'm3', prompt: 'note prompt' })
await markArtifactReady(noteArt.id, { content: 'KEEP ME', generatedText: 'KEEP ME' }, noteArt.updatedAt)
assert(await isArtifactSourceLive(noteArt) === true, 'artifact live while source conversation exists')
await deleteConversation(convId)
const afterDelete = await getArtifact(noteArt.id)
assert(!!afterDelete && afterDelete.content === 'KEEP ME', 'finished artifact survives source-conversation deletion')
assert(await isArtifactSourceLive(noteArt) === false, 'artifact provenance reports source gone')
const allArt = await listArtifacts()
assert(allArt.some((a) => a.id === noteArt.id || a.id === art.id), 'artifact still discoverable after source deleted')

// ---- 7. invalid quiz JSON rejected, valid round-trips ----
assert(throws(() => parseQuizDocument('not json at all')), 'non-JSON quiz output rejected')
const badIdx = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'x', options: ['a', 'b'], answer: 5 }] })
assert(throws(() => parseQuizDocument(badIdx)), 'single-choice answer index out of range rejected')
const badOpt = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'x', options: [], answer: 0 }] })
assert(throws(() => parseQuizDocument(badOpt)), 'empty options rejected')
const good = JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q', options: ['A', 'B'], answer: 1, explanation: 'e' },{ id: 'q2', type: 'multiple-choice', question: 'M', options: ['A', 'B', 'C'], answers: [0, 2] },{ id: 'q3', type: 'true-false', question: 'T', answer: true },{ id: 'q4', type: 'short-answer', question: 'S', answer: 'ans' }] })
const quiz = parseQuizDocument(good)
assert(quiz.questions.length === 4 && quiz.questions[0].answer === 1 && quiz.questions[1].answers.join() === '0,2', 'valid quiz parses + index sets preserved')
const round = parseQuizDocument(JSON.stringify(quiz))
assert(round.questions.length === 4, 'valid quiz round-trips through JSON')
assert(throws(() => validateQuizDocument({ questions: [{ id: 'x', type: 'bad', question: 'q' }] })), 'unknown type rejected by validateQuizDocument')

// ---- 8. artifact deletion during generation cannot resurrect ----
const convId2 = newStableId()
await saveConversation({ id: convId2, title: 't2', createdAt: 1, updatedAt: 1, messages: [msg('d0'), msg('d1')] })
const delArt = await createArtifactDraft({ kind: 'note', conversationId: convId2, throughMessageId: 'd0', prompt: 'p' })
await removeArtifact(delArt.id)
const resurrect = await markArtifactReady(delArt.id, { content: 'x', generatedText: 'x' }, delArt.updatedAt)
assert(resurrect === undefined, 'late write cannot resurrect a deleted artifact')

// ---- 9. validateArtifact sanity ----
const shaped = { id: 'a1', kind: 'note', title: 't', source: { conversationId: 'c', throughMessageId: 'm', snapshot: { conversationId: 'c', throughMessageId: 'm', createdAt: 1, messages: [], provenance: [], sourceLabel: 'x', sourceDeleted: false } }, prompt: 'p', createdAt: 1, updatedAt: 1, status: 'ready', content: 'x' }
assert(!!validateArtifact(shaped), 'well-shaped artifact validates')
assert(validateArtifact({ ...shaped, kind: 'bogus' }) === null, 'bad kind rejected by validateArtifact')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
