import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { parseAndValidate } from '../src/export/backup-import.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { canForkFromMessage } from '../src/branches/branch-path.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { clearSessionsSendError, getSessionsSendError, getSessionsStatus, setSessionsSendError } from '../src/engine/sessions-store.ts'
import type { Conversation, Message } from '../src/engine/types.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

const backupMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'message-1', role: 'assistant', content: 'answer', images: [], createdAt: 1, updatedAt: 1, ...overrides,
})

function v1Backup(message: Record<string, unknown>): Record<string, unknown> {
  return {
    format: 'ai-education-reader-backup', version: 1, exportedAt: 1,
    settings: {}, conversations: [{ id: 'conversation-1', title: 'test', createdAt: 1, updatedAt: 1, messages: [message] }],
    annotations: [], attachments: [],
  }
}

function v4Backup(message: Record<string, unknown>): Record<string, unknown> {
  const root = backupMessage({ id: 'root-message', content: 'root' })
  return {
    format: 'ai-education-reader-backup', version: 4, exportedAt: 1,
    settings: {},
    conversations: [{ id: 'conversation-1', title: 'test', createdAt: 1, updatedAt: 1, messages: [root] }],
    annotations: [], attachments: [], documents: [], drafts: [], appearance: 'system',
    branches: [{ id: 'branch-1', conversationId: 'conversation-1', forkMessageId: 'root-message', title: 'branch', createdAt: 1, updatedAt: 1, messages: [message] }],
    branchDrafts: [], artifacts: [], activeBranches: [],
  }
}

function expectRejected(input: unknown, message: string): void {
  let rejected = false
  try { parseAndValidate(input) } catch { rejected = true }
  assert(rejected, message)
}

function expectAccepted(input: unknown, message: string): void {
  let accepted = false
  try { parseAndValidate(input); accepted = true } catch { /* expected only for RED cases */ }
  assert(accepted, message)
}

function testBackupGenerationState(): void {
  expectRejected(v1Backup(backupMessage({ error: {} })), 'V201-CR-01 root assistant error object is rejected')
  expectRejected(v4Backup(backupMessage({ id: 'branch-unknown-status', status: 'unknown' })), 'V201-CR-01 branch unknown status is rejected')
  expectRejected(v4Backup(backupMessage({ id: 'branch-error-without-status', error: 'failure' })), 'V201-CR-01 branch error without status is rejected')
  expectRejected(v4Backup(backupMessage({ id: 'branch-user-status', role: 'user', status: 'failed', error: 'failure' })), 'V201-CR-01 branch user generation state is rejected')
  expectAccepted(v1Backup(backupMessage({ content: 'partial', status: 'failed', error: 'failure' })), 'V201-CR-01 legal failed assistant round-trips')
  expectAccepted(v1Backup(backupMessage({ content: 'partial', status: 'aborted', error: 'stopped' })), 'V201-CR-01 legal aborted assistant round-trips')
}

async function testFailedAssistantConsumption(): Promise<void> {
  const failed: Message = { id: 'failed-message', role: 'assistant', content: 'partial', images: [], createdAt: 1, updatedAt: 1, status: 'failed', error: 'failure' }
  const conversation: Conversation = { id: 'conversation-failed', title: 'failed', createdAt: 1, updatedAt: 1, messages: [failed] }
  assert(!canForkFromMessage(conversation, [], failed.id), 'V201-CR-02 failed assistant is not a stable fork point')

  const cockpit = readFileSync('src/cockpit/Conversation.tsx', 'utf8')
  const stableActionGuard = cockpit.includes('isStableBranchPoint') || (cockpit.includes("m.status !== 'failed'") && cockpit.includes("m.status !== 'aborted'"))
  assert(stableActionGuard, 'V201-CR-02 failed/aborted assistant has no branch/artifact action path')
  const quickFollowUpGuard = cockpit.includes('isCompletedAssistantMessage') || (cockpit.includes("message.status !== 'failed'") && cockpit.includes("message.status !== 'aborted'"))
  assert(quickFollowUpGuard, 'V201-CR-02 failed/aborted assistant has no Quick Follow-up path')

  await idbClearAll()
  await saveConversation(conversation)
  let created = false
  try { await createBranchFromMessage(conversation.id, failed.id); created = true } catch { /* desired after Stage 2 */ }
  assert(!created, 'V201-CR-02 service rejects direct branch creation from failed assistant')
}

async function testRejectedStateVisibility(): Promise<void> {
  await idbClearAll()
  clearSessionsSendError()
  const outcome = await runBranchReply('missing-conversation', 'missing-branch', 'hello')
  assert(outcome.kind === 'rejected' && !!getSessionsSendError(), 'V201-CR-03 branch rejection publishes a visible send error')

  setSessionsSendError({ kind: 'failed', code: 'server', message: 'terminal failure', conversationId: 'conversation-1' })
  clearSessionsSendError({ conversationId: 'conversation-1' })
  assert(!(getSessionsStatus() === 'error' && getSessionsSendError() === undefined), 'V201-CR-03 clearing a terminal error cannot leave orphan status=error')
}

function testReaderBaseline(): void {
  const reader = readFileSync('src/documents/DocumentReader.tsx', 'utf8')
  assert(!reader.includes('data-testid="reader-build"'), 'V202-REQ-01 Reader top-bar reader-build entry is removed')
  const hasConditionalNoteLabels = reader.includes('新建笔记') && reader.includes('查看笔记') && reader.includes('收起笔记')
  assert(hasConditionalNoteLabels, 'V202-REQ-02 note action exposes current-page new/view/collapse states')
}

testBackupGenerationState()
await testFailedAssistantConsumption()
await testRejectedStateVisibility()
testReaderBaseline()

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
