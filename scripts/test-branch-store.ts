import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation, getConversation } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import { listBranchesByConversation, getBranch, getActiveBranch, setActiveBranch } from '../src/branches/branch-store.ts'
import { createBranchFromMessage, renameBranch, deleteBranchSubtree, acceptBranchUserMessage } from '../src/branches/branch-service.ts'
import { setBranchDraftText, addBranchDraftImages, getBranchDraft, initBranchDrafts, branchDraftSettingKey, getDraft, setDraftText } from '../src/engine/draft-store.ts'
import { getSetting } from '../src/storage/storage.ts'
import { buildEffectiveConversationPath } from '../src/branches/branch-path.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
const join = (s: string[]) => s.join(',')

// Seed a conversation with m0..m3.
const convId = newStableId()
const rootMsgs = [msg('m0'), msg('m1'), msg('m2'), msg('m3')]
const conv: Conversation = { id: convId, title: 't', createdAt: 1, updatedAt: 1, messages: rootMsgs }
await saveConversation(conv)

// ---- create branch from a ROOT message ----
const b1 = await createBranchFromMessage(convId, 'm1')
assert(!!b1.id && b1.conversationId === convId, 'branch gets a stable id + conversation')
assert(b1.parentBranchId === undefined && b1.forkMessageId === 'm1', 'root-fork branch has no parent + fork at m1')
assert(b1.messages.length === 0, 'new branch starts empty')
assert((await getActiveBranch(convId)) === b1.id, 'new branch becomes active')
let branches = await listBranchesByConversation(convId)
assert(branches.length === 1, 'listBranchesByConversation finds the branch')
const eff = buildEffectiveConversationPath(conv, branches, b1.id)
assert(join(eff.map(x => x.id)) === 'm0,m1', 'branch effective path is inherited history through fork only')

// ---- canonical owner: root message forks from root even when a branch is 'active' ----
const b2 = await createBranchFromMessage(convId, 'm0')
assert(b2.parentBranchId === undefined && b2.forkMessageId === 'm0', 'branching a root message forks from root (canonical owner)')

// ---- nested branch: fork from a branch-local message ----
// append a local message to b1 then branch inside b1.
const { acceptBranchUserMessage } = await import('../src/branches/branch-service.ts')
const aMsg = msg('a0')
const accepted = await acceptBranchUserMessage(b1.id, aMsg)
assert(accepted === true, 'accept branch user message returns true')
const b1Now = await getBranch(b1.id)
assert(b1Now!.messages.length === 1 && b1Now!.messages[0].id === 'a0', 'branch record persisted the local message')
const b3 = await createBranchFromMessage(convId, 'a0')
assert(b3.parentBranchId === b1.id && b3.forkMessageId === 'a0', 'nested branch parent is the branch that owns a0')
branches = await listBranchesByConversation(convId)
const effB3 = buildEffectiveConversationPath(conv, branches, b3.id)
assert(join(effB3.map(x => x.id)) === 'm0,m1,a0', 'nested branch effective path correct')

// ---- rename is metadata only ----
const renamed = await renameBranch(b3.id, '新路线')
assert(renamed && renamed.title === '新路线', 'rename persists a new title')
const b3After = await getBranch(b3.id)
assert(b3After!.messages.length === 0 && b3After!.forkMessageId === 'a0' && b3After!.parentBranchId === b1.id, 'rename never changes messages/ancestry')

// ---- branch draft isolation ----
setDraftText(convId, 'main draft text')
setBranchDraftText(b1.id, 'branch b1 draft')
setBranchDraftText(b3.id, 'branch b3 draft')
assert(getDraft(convId).text === 'main draft text', 'root draft isolated')
assert(getBranchDraft(b1.id).text === 'branch b1 draft' && getBranchDraft(b3.id).text === 'branch b3 draft', 'branch drafts isolated per branch')
assert(getDraft(convId).text !== getBranchDraft(b1.id).text, 'root vs branch draft not shared')

// ---- accept branch user message atomically clears branch draft ----
setBranchDraftText(b1.id, 'to-be-cleared')
addBranchDraftImages(b1.id, ['imgX'])
const m2 = msg('a1')
await acceptBranchUserMessage(b1.id, m2)
assert(getBranchDraft(b1.id).text === '' && getBranchDraft(b1.id).imageIds.length === 0, 'branch draft cleared on accept')
assert((await getSetting(branchDraftSettingKey(b1.id))) === undefined, 'branch draft setting row removed atomically')

// ---- active branch fallback when stored branch is gone ----
await setActiveBranch(convId, 'ghost')
const { getActiveBranchForConversation } = await import('../src/branches/branch-service.ts')
assert((await getActiveBranchForConversation(convId)) === undefined, 'stored active branch that no longer exists falls back to root')
await setActiveBranch(convId, b3.id)

// ---- delete branch subtree ----
const sub = await deleteBranchSubtree(b1.id)
assert(sub.deleted.includes(b1.id) && sub.deleted.includes(b3.id), 'delete subtree removes branch + descendants')
branches = await listBranchesByConversation(convId)
assert(branches.length === 1 && branches[0].id === b2.id, 'deleting a subtree never touches siblings/root')
assert((await getBranch(b1.id)) === undefined && (await getBranch(b3.id)) === undefined, 'deleted branches are gone')
const activeAfter = await getActiveBranch(convId)
assert(activeAfter === undefined, 'active branch reset to root after subtree delete')
assert((await getDraft(convId)).text === 'main draft text', 'root draft untouched by branch delete')
// b2 belongs to root, still deletable independently
const sub2 = await deleteBranchSubtree(b2.id)
assert(sub2.deleted.length === 1 && (await listBranchesByConversation(convId)).length === 0, 'independent root branch deletes alone')

// ---- reload restores branch drafts ----
const b4 = await createBranchFromMessage(convId, 'm1')
setBranchDraftText(b4.id, 'survivor draft')
await closeDb()
await initBranchDrafts([b4.id])
assert(getBranchDraft(b4.id).text === 'survivor draft', 'branch draft restored after reload')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
