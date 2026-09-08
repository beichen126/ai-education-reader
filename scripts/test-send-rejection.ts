import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { DEFAULT_SETTINGS, saveSettings } from '../src/engine/settings-store.ts'
import { clearSessionsSendError, getSessionsSendError, getSessionsSendErrorTarget, getSessionsStatus, initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { generationRegistry } from '../src/engine/generation-registry.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { getConversation } from '../src/storage/storage.ts'
import { getDraft, resetDrafts, setBranchDraftText, setDraftText } from '../src/engine/draft-store.ts'
import { shouldPresentRejectedSend, type SendTarget } from '../src/engine/send-outcome.ts'
import type { Conversation } from '../src/engine/types.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

function sseDone(): Response {
  const delta = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n'
  return new Response(delta + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function resetRuntime(apiKey = 'sk-test'): Promise<void> {
  generationRegistry.cancel()
  clearSessionsSendError()
  resetDrafts()
  await idbClearAll()
  await saveSettings({ ...DEFAULT_SETTINGS, apiKey, model: 'deepseek-chat' })
  await initStore()
}

async function createRootAndBranch(): Promise<{ conversationId: string; branchId: string }> {
  const conversationId = await sessionsActions.newChat()
  await sessionsActions.addAssistant(conversationId, '稳定回答')
  const conversation = await getConversation(conversationId) as Conversation
  const branch = await createBranchFromMessage(conversationId, conversation.messages[conversation.messages.length - 1].id)
  return { conversationId, branchId: branch.id }
}

function failNextAcceptance(storeNames: string[]): () => void {
  const proto = IDBDatabase.prototype
  const original = proto.transaction
  let armed = true
  proto.transaction = function (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction {
    const list = Array.isArray(names) ? names : [names]
    if (armed && mode === 'readwrite' && storeNames.every((name) => list.includes(name))) {
      armed = false
      throw new Error('forced acceptance failure')
    }
    return original.call(this, names as any, mode as any, options as any)
  } as typeof proto.transaction
  return () => { proto.transaction = original }
}

assert(shouldPresentRejectedSend({ kind: 'rejected', code: 'no-api-key', message: 'no key' }, 'composer'), 'no-api-key rejection is visible')
assert(shouldPresentRejectedSend({ kind: 'rejected', code: 'prompt-path-unresolved', message: 'prompt' }, 'composer'), 'prompt-path rejection is visible')
assert(shouldPresentRejectedSend({ kind: 'rejected', code: 'empty-input', message: 'empty' }, 'composer') === false, 'ordinary empty composer input is silent')
assert(shouldPresentRejectedSend({ kind: 'rejected', code: 'empty-input', message: 'empty' }, 'quick-follow-up'), 'quick-follow-up rejection is visible')
assert(shouldPresentRejectedSend({ kind: 'rejected', code: 'generation-busy', message: 'busy' }, 'composer') === false, 'generation-busy does not create an error state')

await resetRuntime('')
const rootNoKeyId = await sessionsActions.newChat()
setDraftText(rootNoKeyId, '保留 root 草稿')
const rootNoKey = await sessionsActions.sendUserMessage(rootNoKeyId, 'root message')
assert(rootNoKey.kind === 'rejected' && rootNoKey.code === 'no-api-key', 'root no-key rejection returns typed outcome')
assert(getSessionsStatus() === 'error' && getSessionsSendError() === '未配置 API Key，请先在设置中填写。', 'root no-key rejection sets visible error status')
assert(getSessionsSendErrorTarget()?.conversationId === rootNoKeyId && !getSessionsSendErrorTarget()?.branchId, 'root error target is root-scoped')
assert(getDraft(rootNoKeyId).text === '保留 root 草稿', 'root rejected send preserves draft')

await resetRuntime('sk-test')
const { conversationId, branchId } = await createRootAndBranch()
const rootId = conversationId
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: '' , model: 'deepseek-chat' })
setBranchDraftText(branchId, '保留 branch 草稿')
const branchNoKey = await runBranchReply(conversationId, branchId, 'branch message')
assert(branchNoKey.kind === 'rejected' && branchNoKey.code === 'no-api-key', 'branch no-key rejection returns typed outcome')
assert(getSessionsStatus() === 'error' && getSessionsSendError() === '未配置 API Key，请先在设置中填写。', 'branch no-key rejection uses the same visible message/status')
assert(getSessionsSendErrorTarget()?.conversationId === conversationId && getSessionsSendErrorTarget()?.branchId === branchId, 'branch error target keeps branch ownership')
assert(getDraft('B:' + branchId).text === '保留 branch 草稿', 'branch rejected send preserves draft')
assert((await getBranch(branchId))?.messages.length === 0, 'branch rejection does not accept a user message')

const quickBefore = (await getBranch(branchId))?.messages.length ?? -1
const quickRejected = await runBranchReply(conversationId, branchId, '', [], { quickFollowUp: { promptId: 'q', labelSnapshot: '继续', promptSnapshot: '   ' }, draftDisposition: 'preserve' })
assert(quickRejected.kind === 'rejected' && quickRejected.code === 'empty-input', 'branch invalid Quick Follow-up is rejected before acceptance')
assert(getSessionsStatus() === 'error' && !!getSessionsSendError(), 'branch invalid Quick Follow-up has visible feedback')
assert(((await getBranch(branchId))?.messages.length ?? -1) === quickBefore, 'branch invalid Quick Follow-up adds no message')

const rootTarget: SendTarget = { conversationId }
const branchTarget: SendTarget = { conversationId, branchId }
clearSessionsSendError(rootTarget)
assert(!!getSessionsSendError() && getSessionsSendErrorTarget()?.branchId === branchId, 'clearing root target does not clear branch error')
clearSessionsSendError(branchTarget)
assert(!getSessionsSendError() && getSessionsStatus() === 'idle', 'clearing matching error restores idle state atomically')

await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat' })
setDraftText(rootId, 'root acceptance draft')
const restoreRoot = failNextAcceptance(['conversations', 'settings'])
const rootAcceptance = await sessionsActions.sendUserMessage(rootId, 'root acceptance failure')
restoreRoot()
assert(rootAcceptance.kind === 'rejected' && rootAcceptance.code === 'acceptance-failed', 'root acceptance failure is a visible rejection')
assert(getSessionsStatus() === 'error' && !!getSessionsSendError(), 'root acceptance failure sets error status with error text')
assert(getDraft(rootId).text === 'root acceptance draft', 'root acceptance failure preserves draft')
assert((await getConversation(rootId))?.messages.some((message) => message.content === 'root acceptance failure') !== true, 'root acceptance failure persists no user message')

setBranchDraftText(branchId, 'branch acceptance draft')
const restoreBranch = failNextAcceptance(['conversationBranches', 'settings'])
const branchAcceptance = await runBranchReply(conversationId, branchId, 'branch acceptance failure')
restoreBranch()
assert(branchAcceptance.kind === 'rejected' && branchAcceptance.code === 'branch-acceptance-failed', 'branch acceptance failure is a visible rejection')
assert(getSessionsStatus() === 'error' && getSessionsSendErrorTarget()?.branchId === branchId, 'branch acceptance failure remains branch-scoped')
assert(getDraft('B:' + branchId).text === 'branch acceptance draft', 'branch acceptance failure preserves draft')
assert((await getBranch(branchId))?.messages.some((message) => message.content === 'branch acceptance failure') !== true, 'branch acceptance failure persists no user message')

globalThis.fetch = (async () => sseDone()) as typeof fetch
const retry = await runBranchReply(conversationId, branchId, 'successful retry')
assert(retry.kind === 'completed', 'successful retry completes after rejection')
assert(!getSessionsSendError() && getSessionsStatus() === 'idle', 'successful retry clears the old error and returns idle')
assert((await getBranch(branchId))?.messages.some((message) => message.content === 'successful retry') === true, 'successful retry accepts the user message')

await resetRuntime('sk-test')
const emptyRoot = await sessionsActions.newChat()
const empty = await sessionsActions.sendUserMessage(emptyRoot, '   ')
assert(empty.kind === 'rejected' && empty.code === 'empty-input', 'ordinary empty input is rejected without acceptance')
assert(!getSessionsSendError() && getSessionsStatus() === 'idle', 'empty input leaves no orphan error status')

delete (globalThis as any).fetch
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
