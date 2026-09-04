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
import { createArtifactDraft, markArtifactReady, updateArtifactContent } from '../src/artifacts/artifact-service.ts'
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

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
