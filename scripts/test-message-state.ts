import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { acceptBranchUserMessage, createBranchFromMessage, BranchError } from '../src/branches/branch-service.ts'
import { canForkFromMessage } from '../src/branches/branch-path.ts'
import { listBranchesByConversation } from '../src/branches/branch-store.ts'
import { canCreateArtifactFromMessage, hasMeaningfulAssistantContent, isCompletedAssistantMessage, isStableBranchPoint, isTerminalAssistantMessage, type Conversation, type Message } from '../src/engine/types.ts'
import { ArtifactError, createArtifactDraft } from '../src/artifacts/artifact-service.ts'
import { deleteArtifact } from '../src/artifacts/artifact-store.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

function msg(id: string, role: Message['role'], content: string, state: Partial<Message> = {}): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1, ...state }
}

async function expectBranchRejected(conversationId: string, messageId: string, code: string, label: string): Promise<void> {
  let ok = false
  try { await createBranchFromMessage(conversationId, messageId) } catch (error) { ok = error instanceof BranchError && error.code === code }
  assert(ok, label)
}

async function expectArtifactRejected(input: Parameters<typeof createArtifactDraft>[0], code: string, label: string): Promise<void> {
  let ok = false
  try { await createArtifactDraft(input) } catch (error) { ok = error instanceof ArtifactError && error.code === code }
  assert(ok, label)
}

await idbClearAll()
const conversation: Conversation = {
  id: 'state-conversation', title: 'message states', createdAt: 1, updatedAt: 1,
  messages: [
    msg('root-user', 'user', 'user source'),
    msg('root-completed', 'assistant', 'completed answer'),
    msg('root-failed-partial', 'assistant', 'partial failed', { status: 'failed', error: 'server failed' }),
    msg('root-aborted-partial', 'assistant', 'partial aborted', { status: 'aborted', error: '已停止生成' }),
    msg('root-failed-empty', 'assistant', '', { status: 'failed', error: 'empty failed' }),
  ],
}
await saveConversation(conversation)

assert(isTerminalAssistantMessage(conversation.messages[2]), 'failed assistant is terminal')
assert(isTerminalAssistantMessage(conversation.messages[3]), 'aborted assistant is terminal')
assert(!isTerminalAssistantMessage(conversation.messages[1]), 'completed assistant is not terminal')
assert(isCompletedAssistantMessage(conversation.messages[1]), 'completed assistant with content is completed')
assert(!isCompletedAssistantMessage(conversation.messages[2]), 'failed partial assistant is not completed')
assert(!isCompletedAssistantMessage(conversation.messages[3]), 'aborted partial assistant is not completed')
assert(!isCompletedAssistantMessage(conversation.messages[4]), 'failed empty assistant is not completed')
assert(!isCompletedAssistantMessage(conversation.messages[1], { streaming: true }), 'current streaming assistant is not completed')
assert(!hasMeaningfulAssistantContent(' \n\u00a0\t'), 'whitespace-only assistant content is not meaningful')
assert(!isCompletedAssistantMessage({ role: 'assistant', content: ' \n\u00a0\t' }), 'whitespace-only assistant is not completed')
assert(isStableBranchPoint(conversation.messages[0]), 'stable user keeps the existing branch-point rule')
assert(isStableBranchPoint(conversation.messages[1]), 'completed assistant is a stable branch point')
assert(!isStableBranchPoint(conversation.messages[2]), 'failed partial assistant is not a stable branch point')
assert(!isStableBranchPoint(conversation.messages[3]), 'aborted partial assistant is not a stable branch point')
assert(canCreateArtifactFromMessage(conversation.messages[0]), 'stable user remains a valid artifact source')
assert(canCreateArtifactFromMessage(conversation.messages[1]), 'completed assistant is a valid artifact source')
assert(!canCreateArtifactFromMessage(conversation.messages[2]), 'failed assistant is not a valid artifact source')

assert(canForkFromMessage(conversation, [], 'root-user'), 'root stable user can fork')
assert(canForkFromMessage(conversation, [], 'root-completed'), 'root completed assistant can fork')
assert(!canForkFromMessage(conversation, [], 'root-failed-partial'), 'root failed assistant cannot fork')
assert(!canForkFromMessage(conversation, [], 'root-aborted-partial'), 'root aborted assistant cannot fork')
assert(!canForkFromMessage(conversation, [], 'root-failed-empty'), 'root empty failed assistant cannot fork')

await expectBranchRejected(conversation.id, 'root-failed-partial', 'fork-message-not-stable', 'service rejects root failed assistant')
await expectBranchRejected(conversation.id, 'root-aborted-partial', 'fork-message-not-stable', 'service rejects root aborted assistant')
const first = await createBranchFromMessage(conversation.id, 'root-completed')
await acceptBranchUserMessage(first.id, msg('branch-user', 'user', 'branch source'))
await acceptBranchUserMessage(first.id, msg('branch-failed', 'assistant', 'branch partial', { status: 'failed', error: 'branch failed' }))
let branches = await listBranchesByConversation(conversation.id)
assert(!canForkFromMessage(conversation, branches, 'branch-failed'), 'first-level branch failed assistant cannot fork')
await expectBranchRejected(conversation.id, 'branch-failed', 'fork-message-not-stable', 'service rejects first-level branch failed assistant')
const nested = await createBranchFromMessage(conversation.id, 'branch-user')
await acceptBranchUserMessage(nested.id, msg('nested-aborted', 'assistant', 'nested partial', { status: 'aborted', error: 'nested stopped' }))
branches = await listBranchesByConversation(conversation.id)
assert(!canForkFromMessage(conversation, branches, 'nested-aborted'), 'nested branch aborted assistant cannot fork')
await expectBranchRejected(conversation.id, 'nested-aborted', 'fork-message-not-stable', 'service rejects nested branch aborted assistant')
assert(canForkFromMessage(conversation, branches, 'branch-user'), 'first-level stable user remains forkable')

await expectArtifactRejected({ kind: 'note', conversationId: conversation.id, throughMessageId: 'root-failed-partial', prompt: 'p' }, 'source-message-not-stable', 'artifact service rejects root failed assistant')
await expectArtifactRejected({ kind: 'note', conversationId: conversation.id, throughMessageId: 'branch-failed', branchId: first.id, prompt: 'p' }, 'source-message-not-stable', 'artifact service rejects first-level branch failed assistant')
await expectArtifactRejected({ kind: 'note', conversationId: conversation.id, throughMessageId: 'nested-aborted', branchId: nested.id, prompt: 'p' }, 'source-message-not-stable', 'artifact service rejects nested branch aborted assistant')
const userArtifact = await createArtifactDraft({ kind: 'note', conversationId: conversation.id, throughMessageId: 'root-user', prompt: 'user source' })
assert(userArtifact.source.throughMessageId === 'root-user', 'artifact service still accepts stable user source')
await deleteArtifact(userArtifact.id)
const completedArtifact = await createArtifactDraft({ kind: 'note', conversationId: conversation.id, throughMessageId: 'root-completed', prompt: 'completed source' })
assert(completedArtifact.source.throughMessageId === 'root-completed', 'artifact service accepts completed assistant source')
await deleteArtifact(completedArtifact.id)

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
