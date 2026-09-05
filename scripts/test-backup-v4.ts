import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { saveConversation, getConversation, saveAttachment, setSetting, getSetting } from '../src/storage/storage.ts'
import { idbGetAll, idbClearAll, closeDb } from '../src/storage/idb.ts'
import { setAppearance } from '../src/engine/settings-store.ts'
import { setDraftText, addDraftImages, initDrafts, initBranchDrafts, resetDrafts, getDraft, getBranchDraft, setBranchDraftText, addBranchDraftImages } from '../src/engine/draft-store.ts'
import { createBranchFromMessage, acceptBranchUserMessage } from '../src/branches/branch-service.ts'
import { getBranch, listBranchesByConversation, getActiveBranch, setActiveBranch } from '../src/branches/branch-store.ts'
import { buildEffectiveConversationPath } from '../src/branches/branch-path.ts'
import { createArtifactDraft, markArtifactReady, markArtifactError, markArtifactGenerating, updateArtifactContent } from '../src/artifacts/artifact-service.ts'
import { getArtifact, listArtifacts } from '../src/artifacts/artifact-store.ts'
import { parseQuizDocument } from '../src/artifacts/artifact-validation.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
const join = (s: string[]) => s.join(',')

await idbClearAll(); resetDrafts()
const cv = newStableId()
// A PDF-page attachment (for provenance) + an ordinary image on the root path.
const pdfImg = newStableId()
await saveAttachment({ id: pdfImg, name: 'book.pdf', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1, source: { type: 'pdf-page', groupId: 'g1', documentId: 'doc-1', fileName: 'book.pdf', pageNumber: 3, selection: { kind: 'outline', title: '4.1', pages: [{ startPage: 3, endPage: 3 }], selectedChapterIds: [] } } }, new Blob([new Uint8Array([1,2,3])], { type: 'image/png' }))
const conv: Conversation = { id: cv, title: 't', createdAt: 1, updatedAt: 1, messages: [msg('m0', 'user', 'hi'), { id: 'm1', role: 'assistant', content: 'answer', images: [pdfImg], createdAt: 1, updatedAt: 1 }, msg('m2', 'user', 'more')] }
await saveConversation(conv)

// Branch A from m1, local image message; nested Branch B; branch draft on B.
const bA = await createBranchFromMessage(cv, 'm1')
const branchImg = newStableId()
await saveAttachment({ id: branchImg, name: 'b.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, new Blob([new Uint8Array([4,5,6])], { type: 'image/png' }))
await acceptBranchUserMessage(bA.id, { id: 'a0', role: 'user', content: 'branch text', images: [branchImg], createdAt: 2, updatedAt: 2 })
const bB = await createBranchFromMessage(cv, 'a0')
await acceptBranchUserMessage(bB.id, msg('b0', 'user', 'nested text'))
setBranchDraftText(bB.id, 'unsent branch draft')
const bDraftImg = newStableId()
await saveAttachment({ id: bDraftImg, name: 'bd.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, new Blob([new Uint8Array([7,8,9])], { type: 'image/png' }))
addBranchDraftImages(bB.id, [bDraftImg])
await setActiveBranch(cv, bB.id)

// Note artifact (generated + edited) and Quiz artifact.
const noteArt = await createArtifactDraft({ kind: 'note', conversationId: cv, branchId: bA.id, throughMessageId: 'a0', prompt: 'make note' })
await markArtifactReady(noteArt.id, { content: 'ORIGINAL NOTE', generatedText: 'ORIGINAL NOTE' }, noteArt.updatedAt)
await updateArtifactContent(noteArt.id, 'MY EDITED NOTE')
const quizArt = await createArtifactDraft({ kind: 'quiz', conversationId: cv, branchId: bA.id, throughMessageId: 'a0', prompt: 'make quiz' })
const quizDoc = parseQuizDocument(JSON.stringify({ questions: [{ id: 'q1', type: 'single-choice', question: 'Q?', options: ['A', 'B'], answer: 0 }] }))
await markArtifactReady(quizArt.id, { quiz: quizDoc, generatedText: '[...]' }, quizArt.updatedAt)

await setAppearance('dark')
await setSetting('apiKey', 'sk-secret')

// ---- build V4 backup ----
const backup = await buildBackup()
assert(backup.version === 4, 'backup version is 4 (got ' + backup.version + ')')
const v4 = backup as any
assert(v4.branches.length === 2, 'backup includes both branches')
assert(v4.branchDrafts.length === 1 && v4.branchDrafts[0].branchId === bB.id, 'backup includes branch draft')
assert(v4.artifacts.length === 2, 'backup includes both artifacts')
const active = v4.activeBranches.find((x: any) => x.conversationId === cv)
assert(active && active.branchId === bB.id, 'backup includes active branch')
assert(v4.appearance === 'dark', 'backup appearance dark')
assert(!('apiKey' in v4.settings), 'backup settings EXCLUDE apiKey')
const attIds = (v4.attachments as any[]).map((a) => a.id)
assert(attIds.includes(pdfImg) && attIds.includes(branchImg) && attIds.includes(bDraftImg), 'attachment union includes root + branch message + branch draft refs')
const quizBackup = v4.artifacts.find((a: any) => a.kind === 'quiz')
assert(quizBackup && quizBackup.quiz && quizBackup.quiz.questions.length === 1, 'backup preserves structured quiz data')
parseAndValidate(backup)
console.log('  ok: built backup passes parseAndValidate')

// ---- clear all + restore ----
await idbClearAll(); resetDrafts()
await restoreBackup(backup)
resetDrafts()
await initDrafts([cv]); await initBranchDrafts([bA.id, bB.id])

const convAfter = await getConversation(cv)
assert(!!convAfter && convAfter.messages.length === 3, 'restored: root conversation preserved')
const branchesAfter = await listBranchesByConversation(cv)
assert(branchesAfter.length === 2, 'restored: branch tree preserved (2 branches)')
const bAAfter = branchesAfter.find((b) => b.id === bA.id)!
const bBAfter = branchesAfter.find((b) => b.id === bB.id)!
assert(bAAfter && bAAfter.messages.length === 1 && bAAfter.messages[0].images.includes(branchImg), 'restored: branch A local message + image')
assert(bBAfter && bBAfter.parentBranchId === bA.id && bBAfter.messages.length === 1, 'restored: nested branch B ancestry + message')
const eff = buildEffectiveConversationPath(convAfter!, branchesAfter, bB.id)
assert(join(eff.map((m) => m.id)) === 'm0,m1,a0,b0', 'restored: nested effective path identical')
const activeAfter = await getActiveBranch(cv)
assert(activeAfter === bB.id, 'restored: active branch restored')
const bdAfter = getBranchDraft(bB.id)
assert(bdAfter.text === 'unsent branch draft' && bdAfter.imageIds.includes(bDraftImg), 'restored: branch draft text + image')
const noteAfter = await getArtifact(noteArt.id)
assert(noteAfter && noteAfter.content === 'MY EDITED NOTE' && noteAfter.generatedContent === 'ORIGINAL NOTE', 'restored: note artifact + manual edit preserved')
const quizAfter = await getArtifact(quizArt.id)
assert(quizAfter && quizAfter.kind === 'quiz' && quizAfter.quiz && quizAfter.quiz.questions.length === 1, 'restored: quiz structured artifacts preserved')
assert((await getSetting('appearance')) === 'dark', 'restored: appearance dark')
const apiKey = await getSetting('apiKey')
assert(apiKey === '' || apiKey === undefined, 'restored: apiKey NOT restored')


// ================= Agent F (F3): artifact lifecycle state + backup compatibility =================
// A failed / in-progress / draft quiz may legitimately carry NO `quiz` payload. A v1.1.1 backup
// must never fail to generate just because such an artifact is present, and a restored
// mid-generation artifact must never resurrect as a zombie 'generating' spinner.
{
  await idbClearAll(); resetDrafts()
  const cv2 = newStableId()
  await saveConversation({ id: cv2, title: 't2', createdAt: 1, updatedAt: 1, messages: [msg('x0', 'user', 'hi'), { id: 'x1', role: 'assistant', content: 'a', images: [], createdAt: 1, updatedAt: 1 }] })
  // seed the artifacts under a fresh conversation to keep the earlier assertions isolated
  const seed = async (kind: 'quiz' | 'note', status: 'draft' | 'generating' | 'error', o: { genContent?: string; error?: string } = {}) => {
    const a = await createArtifactDraft({ kind, conversationId: cv2, throughMessageId: 'x1', prompt: 'p' })
    if (status === 'error') await markArtifactError(a.id, o.error || 'boom', o.genContent !== undefined ? { generatedContent: o.genContent } : undefined)
    else if (status === 'generating') await markArtifactGenerating(a.id)
    return await getArtifact(a.id)!
  }
  const draftQuiz = await seed('quiz', 'draft')
  const errQuizNoQuiz = await seed('quiz', 'error', { error: '解析失败' })
  const errQuizRaw = await seed('quiz', 'error', { error: 'boom', genContent: 'RAW OUTPUT' })
  const genNote = await seed('note', 'generating')
  const genQuiz = await seed('quiz', 'generating')

  // buildBackup must NOT fail because these non-ready quiz artifacts lack a quiz payload
  const b2 = await buildBackup()
  parseAndValidate(b2)
  const b2v = b2 as any
  const a2 = b2v.artifacts
  assert(a2.find((x: any) => x.id === errQuizNoQuiz.id && x.status === 'error' && x.quiz === undefined), 'error quiz (no quiz) exported with status=error, no quiz field')
  assert(a2.find((x: any) => x.id === errQuizRaw.id && x.generatedContent === 'RAW OUTPUT'), 'error quiz raw generatedContent exported')
  assert(a2.find((x: any) => x.id === draftQuiz.id && x.status === 'draft'), 'draft quiz exported')
  assert(a2.find((x: any) => x.id === genNote.id && x.status === 'generating'), 'generating note exported (export is allowed)')

  // restore: generating -> error (no zombie spinner), content/quiz/generatedContent preserved
  await idbClearAll(); resetDrafts()
  await restoreBackup(b2)
  const dra = await getArtifact(draftQuiz.id)
  assert(dra && dra.status === 'draft' && dra.kind === 'quiz' && dra.quiz === undefined, 'draft quiz round-trip keeps draft/empty quiz')
  const eq = await getArtifact(errQuizNoQuiz.id)
  assert(eq && eq.status === 'error' && eq.quiz === undefined, 'error quiz round-trip keeps error/empty quiz')
  const eqr = await getArtifact(errQuizRaw.id)
  assert(eqr && eqr.generatedContent === 'RAW OUTPUT' && eqr.status === 'error', 'error quiz raw generatedContent preserved after restore')
  const gn = await getArtifact(genNote.id)
  assert(gn && gn.status === 'error' && String(gn.error).includes('仍在生成'), 'generating note restored -> error (no zombie)')
  const gq = await getArtifact(genQuiz.id)
  assert(gq && gq.status === 'error' && String(gq.error).includes('仍在生成'), 'generating quiz restored -> error (no zombie)')

  // ready quiz WITHOUT quiz payload must be REJECTED by validation
  const readyMiss = JSON.parse(JSON.stringify(b2)); (readyMiss as any).artifacts = (readyMiss as any).artifacts.map((a: any) => a.id === genNote.id ? { ...a, id: 'ready-miss', kind: 'quiz', status: 'ready', quiz: undefined } : a)
  let rej = false; try { parseAndValidate(readyMiss) } catch { rej = true }
  assert(rej, 'ready quiz without quiz -> rejected (strict validation preserved)')
  // ready quiz with a MALFORMED payload must be REJECTED
  const readyBad = JSON.parse(JSON.stringify(b2)); (readyBad as any).artifacts = (readyBad as any).artifacts.map((a: any) => a.id === genNote.id ? { ...a, id: 'ready-bad', kind: 'quiz', status: 'ready', quiz: { questions: [{ id: 'q', type: 'single-choice', question: 'q', options: 'bad', answer: 0 }] } } : a)
  let rej2 = false; try { parseAndValidate(readyBad) } catch { rej2 = true }
  assert(rej2, 'ready malformed quiz -> rejected (strict validation preserved)')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
