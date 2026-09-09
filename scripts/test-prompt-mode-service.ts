import 'fake-indexeddb/auto'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getConversation, saveConversation } from '../src/storage/storage.ts'
import { getBranch, listBranchesByConversation, saveBranch } from '../src/branches/branch-store.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import { promptSnapshotNeedsApply, switchConversationMode, PromptModeServiceError } from '../src/prompts/prompt-mode-service.ts'
import { generationRegistry } from '../src/engine/generation-registry.ts'
import { tryWithConversationMutationLock } from '../src/prompts/prompt-mode-lock.ts'
import { buildEffectivePromptPath } from '../src/prompts/effective-prompt-path.ts'
import { deletePromptRecord, savePromptRecord } from '../src/prompts/prompt-store.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function msg(id: string): Message { return { id, role: id.startsWith('a') ? 'assistant' : 'user', content: id, images: [], createdAt: 1, updatedAt: 1 } }
function conversation(id: string, messages: Message[] = []): Conversation { return { id, title: id, createdAt: 1, updatedAt: 1, messages } }

await idbClearAll()

const socratic = { id: 'mode-socratic', kind: 'conversation-mode' as const, name: '苏格拉底式学习', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: '通过问题引导学习。' }
const deepExplanation = { id: 'mode-deep-explanation', kind: 'conversation-mode' as const, name: '深入讲解', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: '完整解释概念与例子。' }
const examCoaching = { id: 'mode-exam-coaching', kind: 'conversation-mode' as const, name: '考试辅导', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: '围绕考点组织学习。' }
await savePromptRecord(socratic)
await savePromptRecord(deepExplanation)
await savePromptRecord(examCoaching)

const empty = conversation('empty')
await saveConversation(empty)
const first = await switchConversationMode({ conversationId: empty.id, modeId: socratic.id, now: 10, id: () => 't-empty-a' })
assert(first.changed && first.transition?.afterMessageId === null, 'empty route writes an initial mode transition')
let stored = await getConversation(empty.id) as Conversation
assert(stored.promptTransitions?.length === 1 && stored.promptTransitions[0].snapshot.name === '苏格拉底式学习', 'initial transition is durable')
const second = await switchConversationMode({ conversationId: empty.id, modeId: deepExplanation.id, now: 11, id: () => 't-empty-b' })
stored = await getConversation(empty.id) as Conversation
assert(second.changed && stored.promptTransitions?.length === 1 && stored.promptTransitions[0].snapshot.name === '深入讲解', 'empty route replaces the initial transition instead of adding a divider segment')

const history = conversation('history', [msg('u0'), msg('a0')])
history.promptTransitions = [{ id: 't-history-a', afterMessageId: null, snapshot: { profileId: BUILTIN_PROMPT_IDS.conversationDefault, kind: 'conversation-mode', name: '默认', content: '', revision: 1, source: 'builtin', capturedAt: 19 }, createdAt: 19 }]
await saveConversation(history)
const historySwitch = await switchConversationMode({ conversationId: history.id, modeId: examCoaching.id, now: 21, id: () => 't-history-b' })
stored = await getConversation(history.id) as Conversation
assert(historySwitch.transition?.afterMessageId === 'a0', 'historical mode switch is anchored after the latest visible message')
assert(stored.promptTransitions?.length === 2 && stored.promptTransitions[1].snapshot.name === '考试辅导', 'historical mode switch preserves the previous immutable snapshot')
const noOp = await switchConversationMode({ conversationId: history.id, modeId: examCoaching.id, now: 22, id: () => 't-no-op' })
assert(!noOp.changed && !(await getConversation(history.id) as Conversation).promptTransitions?.some((item) => item.id === 't-no-op'), 'reselecting the current snapshot does not create a transition')

const branchConversation = conversation('branch', [msg('u1'), msg('a1')])
await saveConversation(branchConversation)
await switchConversationMode({ conversationId: branchConversation.id, modeId: BUILTIN_PROMPT_IDS.conversationDefault, now: 30, id: () => 't-root' })
const branch: ConversationBranch = { id: 'branch-1', conversationId: branchConversation.id, forkMessageId: 'a1', title: '分支 1', createdAt: 1, updatedAt: 1, messages: [] }
await saveBranch(branch)
const branchSwitch = await switchConversationMode({ conversationId: branchConversation.id, branchId: branch.id, modeId: socratic.id, now: 31, id: () => 't-branch' })
const branchStored = await getBranch(branch.id)
const effective = buildEffectivePromptPath(await getConversation(branchConversation.id) as Conversation, await listBranchesByConversation(branchConversation.id), branch.id)
assert(branchSwitch.changed && branchStored?.promptTransitions?.[0].afterMessageId === 'a1', 'branch mode switch writes only a local transition at the route boundary')
assert(effective.transitions.length === 1 && effective.transitions[0].snapshot.name === '苏格拉底式学习', 'child transition overrides an inherited transition at the same boundary without duplication')
assert((await listBranchesByConversation(branchConversation.id)).length === 1, 'mode switching never creates a new branch row')

const custom = { id: 'custom-mode', kind: 'conversation-mode' as const, name: '自定义模式', description: '', source: 'custom' as const, enabled: true, createdAt: 1, updatedAt: 1, revision: 1, systemPrompt: 'v1 prompt' }
await savePromptRecord(custom)
const customConversation = conversation('custom', [msg('u2')])
await saveConversation(customConversation)
await switchConversationMode({ conversationId: customConversation.id, modeId: custom.id, now: 40, id: () => 't-custom' })
const snapshot = (await getConversation(customConversation.id) as Conversation).promptTransitions?.[0].snapshot
const revision2 = { ...custom, revision: 2, updatedAt: 2, systemPrompt: 'v2 prompt' }
assert(!!snapshot && promptSnapshotNeedsApply(snapshot, revision2), 'profile revision change is detectable without mutating the stored snapshot')
await deletePromptRecord(custom.id)
assert(!!(await getConversation(customConversation.id) as Conversation).promptTransitions?.[0].snapshot && (await getConversation(customConversation.id) as Conversation).promptTransitions?.[0].snapshot.content === 'v1 prompt', 'deleting a profile leaves the historical snapshot inspectable')

const generationBusyConversation = conversation('generation-busy')
await saveConversation(generationBusyConversation)
const generationLease = generationRegistry.acquire('root:' + generationBusyConversation.id, new AbortController(), 'sending')
let generationRejected = false
try {
  await switchConversationMode({ conversationId: generationBusyConversation.id, modeId: BUILTIN_PROMPT_IDS.conversationDefault, now: 50, id: () => 't-generation-busy' })
} catch (error) {
  generationRejected = error instanceof PromptModeServiceError && error.code === 'generation-busy'
}
assert(generationRejected, 'mode switch rejects while a root generation lease is active')
generationLease?.release()

let unlockMutation!: () => void
const heldMutation = tryWithConversationMutationLock(generationBusyConversation.id, async () => {
  await new Promise<void>((resolve) => { unlockMutation = resolve })
  return true
})
await Promise.resolve()
let mutationRejected = false
try {
  await switchConversationMode({ conversationId: generationBusyConversation.id, modeId: socratic.id, now: 51, id: () => 't-mutation-busy' })
} catch (error) {
  mutationRejected = error instanceof PromptModeServiceError && error.code === 'mutation-busy'
}
assert(mutationRejected, 'mode switch and send acceptance share one conversation mutation lock')
unlockMutation()
await heldMutation

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
