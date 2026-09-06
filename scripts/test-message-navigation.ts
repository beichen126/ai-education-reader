import 'fake-indexeddb/auto'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { getConversation } from '../src/storage/storage.ts'
import { getSessionsCurrent, getSessionsFocusTarget, initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { resolveMessageNavigation } from '../src/cockpit/message-navigation.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

await idbClearAll()
await initStore()
const conversationA = getSessionsCurrent()!
await sessionsActions.addAssistant(conversationA, 'first message')
await sessionsActions.addAssistant(conversationA, 'second message')
const storedA = await getConversation(conversationA)
const firstMessage = storedA!.messages[0]
const secondMessage = storedA!.messages[1]

assert(await sessionsActions.openAtMessage(conversationA, firstMessage.id), 'already-open conversation accepts a valid target')
assert(getSessionsCurrent() === conversationA && getSessionsFocusTarget()?.messageId === firstMessage.id, 'already-open target intent retains exact message id')
sessionsActions.clearMessageFocus()
assert(getSessionsFocusTarget() === undefined, 'successful target consumption can clear the one-shot intent')

const conversationB = await sessionsActions.newChat()
await sessionsActions.addAssistant(conversationB, 'target conversation message')
const storedB = await getConversation(conversationB)
const targetB = storedB!.messages[0]
await sessionsActions.open(conversationA)
assert(await sessionsActions.openAtMessage(conversationB, targetB.id), 'closed/non-current conversation opens with a valid target')
assert(getSessionsCurrent() === conversationB && getSessionsFocusTarget()?.conversationId === conversationB && getSessionsFocusTarget()?.messageId === targetB.id, 'cross-conversation navigation carries exact target')

assert(!(await sessionsActions.openAtMessage(conversationB, 'deleted-message')), 'missing target message is rejected gracefully')
assert(getSessionsFocusTarget() === undefined, 'missing target clears stale navigation intent')
assert(!(await sessionsActions.openAtMessage('deleted-conversation', secondMessage.id)), 'missing conversation is rejected gracefully')

// ---- branch readiness/navigation decisions ----
const branchTarget = { id: 'branch-target', role: 'assistant' as const, content: 'branch target', images: [], createdAt: 2, updatedAt: 2 }
const branch: ConversationBranch = { id: 'branch-x', conversationId: conversationB, forkMessageId: targetB.id, title: 'Branch X', createdAt: 2, updatedAt: 2, messages: [branchTarget] }
const branchFocus = { conversationId: conversationB, messageId: branchTarget.id, branchId: branch.id }
assert(resolveMessageNavigation({ session: storedB!, focusMessage: branchFocus, branches: [], branchReady: false, activeBranchId: undefined, targetRendered: false }).kind === 'wait', 'branch data not ready keeps the focus intent')
assert(resolveMessageNavigation({ session: storedB!, focusMessage: branchFocus, branches: [branch], branchReady: true, activeBranchId: undefined, targetRendered: false }).kind === 'switch-branch', 'ready cross-target requests the target branch')
assert(resolveMessageNavigation({ session: storedB!, focusMessage: branchFocus, branches: [branch], branchReady: true, activeBranchId: branch.id, targetRendered: true }).kind === 'focus', 'active branch with rendered exact message focuses')
assert(resolveMessageNavigation({ session: storedB!, focusMessage: { ...branchFocus, messageId: 'missing' }, branches: [branch], branchReady: true, activeBranchId: branch.id, targetRendered: false }).kind === 'clear', 'ready branch with missing message clears intent')
assert(resolveMessageNavigation({ session: storedB!, focusMessage: branchFocus, branches: [], branchReady: true, activeBranchId: undefined, targetRendered: false }).kind === 'clear', 'deleted branch clears intent without root fallback')

const nestedBranch: ConversationBranch = { id: 'branch-y', conversationId: conversationB, parentBranchId: branch.id, forkMessageId: branchTarget.id, title: 'Branch Y', createdAt: 3, updatedAt: 3, messages: [{ ...branchTarget, id: 'nested-target', content: 'nested target' }] }
assert(resolveMessageNavigation({ session: storedB!, focusMessage: { conversationId: conversationB, messageId: 'nested-target', branchId: nestedBranch.id }, branches: [branch, nestedBranch], branchReady: true, activeBranchId: nestedBranch.id, targetRendered: true }).kind === 'focus', 'nested branch exact message focuses')

await closeDb()
console.log(`\nRESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
