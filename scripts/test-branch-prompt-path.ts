import 'fake-indexeddb/auto'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getConversation, getSetting, saveConversation } from '../src/storage/storage.ts'
import { appendBranchPromptTransition, appendConversationPromptTransition, PromptTransitionServiceError } from '../src/prompts/prompt-transition-service.ts'
import { buildEffectivePromptPath } from '../src/prompts/effective-prompt-path.ts'
import type { PromptSnapshot, PromptTransition } from '../src/prompts/prompt-types.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'
import { saveBranch, getBranch } from '../src/branches/branch-store.ts'
import { deleteBranchSubtree, renameBranch } from '../src/branches/branch-service.ts'
import { savePromptRecord, deletePromptRecord } from '../src/prompts/prompt-store.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function msg(id: string, role: 'user' | 'assistant' = 'user'): Message { return { id, role, content: id, images: [], createdAt: 1, updatedAt: 1 } }
function snap(name: string, revision = 1): PromptSnapshot { return { profileId: name, kind: 'conversation-mode', name, content: name, revision, source: 'custom', capturedAt: revision } }
function tr(id: string, afterMessageId: string | null, name: string, revision = 1): PromptTransition { return { id, afterMessageId, snapshot: snap(name, revision), createdAt: Number(id.slice(1)) || revision } }
function branch(id: string, parentBranchId: string | undefined, forkMessageId: string, messages: Message[] = [], promptTransitions?: PromptTransition[]): ConversationBranch {
  return { id, conversationId: 'c1', parentBranchId, forkMessageId, title: id, createdAt: 1, updatedAt: 1, messages, ...(promptTransitions ? { promptTransitions } : {}) }
}

const conversation: Conversation = {
  id: 'c1', title: 'Timeline', createdAt: 1, updatedAt: 1,
  messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')],
  promptTransitions: [tr('tA', null, 'A'), tr('tB', 'm1', 'B'), tr('tD', 'm2', 'D')],
}
const beforeB = branch('before-b', undefined, 'm0')
const afterB = branch('after-b', undefined, 'm1')
const parent = branch('parent', undefined, 'm1', [msg('p1'), msg('p2')], [tr('tP', 'p1', 'P')])
const nested = branch('nested', 'parent', 'p1', [msg('n1')], [tr('tC', 'n1', 'C')])
const childAfterParent = branch('child-after-parent', 'parent', 'p2', [msg('n2')], [tr('tChild', 'p2', 'Child')])

let result = buildEffectivePromptPath(conversation, [beforeB], 'before-b')
assert(result.resolved && result.transitions.map((item) => item.snapshot.name).join(',') === 'A', 'root fork before B does not inherit B')
result = buildEffectivePromptPath(conversation, [afterB], 'after-b')
assert(result.resolved && result.transitions.map((item) => item.snapshot.name).join(',') === 'A,B', 'root fork after B inherits B')
result = buildEffectivePromptPath(conversation, [parent, nested], 'nested')
assert(result.resolved && result.messageIds.join(',') === 'm0,m1,p1,n1', 'nested branch materializes inherited and local message path')
assert(result.transitions.map((item) => item.snapshot.name).join(',') === 'A,B,P,C', 'nested branch inherits root and local parent transitions and adds C')
result = buildEffectivePromptPath(conversation, [parent, childAfterParent], 'child-after-parent')
assert(result.resolved && result.messageIds.join(',') === 'm0,m1,p1,p2,n2', 'child fork path excludes parent messages after the fork')
assert(result.transitions.map((item) => item.snapshot.name).join(',') === 'A,B,P,Child', 'post-fork parent transition is not inherited')

const badBoundary = branch('bad-boundary', undefined, 'm1', [], [tr('tBad', 'missing', 'Bad')])
result = buildEffectivePromptPath(conversation, [badBoundary], 'bad-boundary')
assert(result.resolved && result.transitions.map((item) => item.snapshot.name).join(',') === 'A,B', 'invalid transition boundary is safely omitted')
assert(result.diagnostics.some((item) => item.code === 'invalid-transition'), 'missing boundary produces a transition diagnostic')

const missingParent = branch('missing-parent', 'ghost', 'm1')
result = buildEffectivePromptPath(conversation, [missingParent], 'missing-parent')
assert(!result.resolved && result.messageIds.join(',') === 'm0,m1,m2,m3', 'missing parent falls back to the root message path')
assert(result.diagnostics.some((item) => item.code === 'missing-parent'), 'missing parent produces a diagnostic')
const cycleA = branch('cycle-a', 'cycle-b', 'm1')
const cycleB = branch('cycle-b', 'cycle-a', 'm1')
result = buildEffectivePromptPath(conversation, [cycleA, cycleB], 'cycle-a')
assert(!result.resolved && result.diagnostics.some((item) => item.code === 'cycle'), 'cycle falls back safely with a diagnostic')
const foreign = { ...branch('foreign', undefined, 'm1'), conversationId: 'other' }
result = buildEffectivePromptPath(conversation, [foreign], 'foreign')
assert(!result.resolved && result.diagnostics.some((item) => item.code === 'missing-conversation'), 'foreign conversation branch is rejected safely')

const sameBoundaryRevision = branch('same-boundary-revision', undefined, 'm1', [msg('r2')], [tr('tR1', 'm1', 'R', 1), tr('tR2', 'r2', 'R', 2)])
result = buildEffectivePromptPath(conversation, [sameBoundaryRevision], 'same-boundary-revision')
assert(result.transitions.some((item) => item.snapshot.revision === 1) && result.transitions.some((item) => item.snapshot.revision === 2), 'same profile revisions remain distinct snapshots')

const sameBoundaryParent = branch('same-boundary-parent', undefined, 'm1', [msg('sbp')], [tr('tParentBoundary', 'm1', 'Parent boundary')])
const sameBoundaryChild = branch('same-boundary-child', 'same-boundary-parent', 'm1', [msg('sbc')], [tr('tChildBoundary', 'm1', 'Child boundary')])
result = buildEffectivePromptPath(conversation, [sameBoundaryParent, sameBoundaryChild], 'same-boundary-child')
assert(result.transitions.some((item) => item.snapshot.name === 'Child boundary') && !result.transitions.some((item) => item.snapshot.name === 'Parent boundary'), 'deepest route owner wins at a shared message boundary')

const nestedBoundaryParent = branch('nested-boundary-parent', undefined, 'm1', [msg('nbp')], [tr('tNestedParent', null, 'Nested parent initial')])
const nestedBoundaryChild = branch('nested-boundary-child', 'nested-boundary-parent', 'nbp', [msg('nbc')], [tr('tNestedChild', null, 'Nested child initial')])
result = buildEffectivePromptPath(conversation, [nestedBoundaryParent, nestedBoundaryChild], 'nested-boundary-child')
assert(result.transitions.some((item) => item.snapshot.name === 'Nested child initial') && !result.transitions.some((item) => item.snapshot.name === 'Nested parent initial'), 'deepest route owner wins at the null boundary')

const duplicateOwner = branch('duplicate-owner', undefined, 'm1', [], [tr('tDupA', 'm1', 'First'), tr('tDupB', 'm1', 'Second')])
result = buildEffectivePromptPath(conversation, [duplicateOwner], 'duplicate-owner')
assert(!result.resolved && result.diagnostics.some((item) => item.code === 'duplicate-transition' && item.message === 'same owner has duplicate transition boundary'), 'same-owner duplicate boundary is diagnostic and unresolved')

const realSentinelMessage: Conversation = {
  id: 'sentinel-conversation', title: 'sentinel', createdAt: 1, updatedAt: 1,
  messages: [msg('__initial__'), msg('sentinel-next')],
  promptTransitions: [tr('sentinel-initial', null, 'Initial'), tr('sentinel-message', '__initial__', 'After real message')],
}
result = buildEffectivePromptPath(realSentinelMessage, [], undefined)
assert(result.transitions.map((item) => item.snapshot.name).join(',') === 'Initial,After real message', 'real message id __initial__ does not collide with the null boundary')

await idbClearAll()
await saveConversation(conversation)
await saveBranch(afterB)
await appendConversationPromptTransition(conversation.id, tr('tRootDurable', 'm3', 'Root durable'))
await appendBranchPromptTransition(afterB.id, tr('tBranchDurable', 'm1', 'Branch durable'))
const durableConversation = await getConversation(conversation.id) as Conversation | undefined
const durableBranch = await getBranch(afterB.id)
assert(durableConversation?.promptTransitions?.some((item) => item.id === 'tRootDurable') === true, 'root service writes transition to Conversation')
assert(durableBranch?.promptTransitions?.some((item) => item.id === 'tBranchDurable') === true, 'branch service writes transition to Branch')
assert(await getSetting('promptMigrationV1') === undefined, 'timeline writes do not create a legacy migration marker')

await renameBranch(afterB.id, 'renamed')
const renamed = await getBranch(afterB.id)
assert(renamed?.promptTransitions?.some((item) => item.id === 'tBranchDurable') === true, 'renaming a route does not change its timeline')

const customPrompt = { id: 'deletable-profile', kind: 'conversation-mode' as const, name: '可删除', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: 'snapshot remains' }
await savePromptRecord(customPrompt)
await appendConversationPromptTransition(conversation.id, tr('tFrozen', 'm3', 'Frozen'))
await deletePromptRecord(customPrompt.id)
const afterDelete = await getConversation(conversation.id) as Conversation | undefined
assert(afterDelete?.promptTransitions?.some((item) => item.id === 'tFrozen') === true, 'deleting a profile does not alter stored snapshots')

const doomed = branch('doomed', undefined, 'm1', [], [tr('tDoomed', 'm1', 'Doomed')])
await saveBranch(doomed)
await deleteBranchSubtree(doomed.id)
const deletedBranch = await getBranch(doomed.id)
const rootAfterBranchDelete = await getConversation(conversation.id) as Conversation | undefined
assert(deletedBranch === undefined, 'deleting a branch subtree removes its local transition row')
assert(rootAfterBranchDelete?.promptTransitions?.some((item) => item.id === 'tFrozen') === true, 'deleting a branch subtree leaves root transitions intact')

let rejected = false
try { await appendBranchPromptTransition('missing-branch', tr('tX', null, 'X')) } catch (error) { rejected = error instanceof PromptTransitionServiceError && error.code === 'branch-not-found' }
assert(rejected, 'missing branch transition write is an explicit domain error')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
