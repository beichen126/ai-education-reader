import 'fake-indexeddb/auto'
import { idbClearAll, idbPut } from '../src/storage/idb.ts'
import { getConversation } from '../src/storage/storage.ts'
import { DEFAULT_SETTINGS, saveSettings } from '../src/engine/settings-store.ts'
import { initStore, getSessionsSendError, getSessionsSendErrorTarget, getSessionsStatus, sessionsActions } from '../src/engine/sessions-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { getPromptDefinitionIssues } from '../src/prompts/prompt-validation.ts'
import { listPromptCatalog } from '../src/prompts/prompt-service.ts'
import { parseAndValidate, BackupError } from '../src/export/backup-import.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { PromptDefinition } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

function delta(content: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n'
}
function done(): string { return 'data: [DONE]\n\n' }
function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
async function resetRuntime(): Promise<void> {
  await idbClearAll()
  await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com' })
  await initStore()
}
async function seedBranch(): Promise<{ conversationId: string; branchId: string }> {
  const conversationId = await sessionsActions.newChat()
  await sessionsActions.addAssistant(conversationId, '已有回答')
  const conversation = await getConversation(conversationId) as Conversation
  const branch = await createBranchFromMessage(conversationId, conversation.messages[conversation.messages.length - 1].id)
  return { conversationId, branchId: branch.id }
}
async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(label + ' timed out')
}
function assistantOf(value: Conversation | undefined): Message | undefined {
  return value?.messages.find((message) => message.role === 'assistant')
}

// FCR-02: root HTTP failure is a typed failure, visible, durable for the user,
// and never materializes an unmarked empty assistant success.
await resetRuntime()
{
  const conversationId = await sessionsActions.newChat()
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(JSON.stringify({ error: { message: 'forced root failure' } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const outcome = await sessionsActions.sendUserMessage(conversationId, 'root failure', [])
  const stored = await getConversation(conversationId)
  assert(outcome.kind === 'failed' && outcome.code === 'server', 'root HTTP 500 returns failed/server outcome')
  assert(requests === 1, 'root HTTP 500 makes exactly one request')
  assert(stored?.messages.some((message) => message.role === 'user' && message.content === 'root failure') === true, 'root accepted user message remains durable after failure')
  assert(assistantOf(stored)?.content === undefined, 'root HTTP 500 removes an empty assistant placeholder')
  assert(!!getSessionsSendError() && getSessionsSendErrorTarget()?.conversationId === conversationId && !getSessionsSendErrorTarget()?.branchId, 'root failure is visible through a root-scoped error channel')
  assert(getSessionsStatus() === 'error', 'root failure leaves an observable error status')
}

// FCR-02: branch HTTP failure uses the same outcome and error semantics.
await resetRuntime()
{
  const { conversationId, branchId } = await seedBranch()
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'forced branch failure' } }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const outcome = await runBranchReply(conversationId, branchId, 'branch failure', [])
  const branch = await getBranch(branchId)
  const localAssistant = branch?.messages.find((message) => message.role === 'assistant')
  assert(outcome.kind === 'failed' && outcome.code === 'server', 'branch HTTP 500 returns the same failed/server outcome')
  assert(branch?.messages.some((message) => message.role === 'user' && message.content === 'branch failure') === true, 'branch accepted user message remains durable after failure')
  assert(localAssistant === undefined, 'branch HTTP 500 removes an empty assistant placeholder')
  assert(!!getSessionsSendError() && getSessionsSendErrorTarget()?.conversationId === conversationId && getSessionsSendErrorTarget()?.branchId === branchId, 'branch failure is visible with branch ownership')
}

// FCR-02: a network error with partial tokens retains content and marks failure.
await resetRuntime()
{
  const conversationId = await sessionsActions.newChat()
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(delta('部分内容')))
      setTimeout(() => controller.error(new Error('socket closed')), 15)
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const outcome = await sessionsActions.sendUserMessage(conversationId, 'partial root', [])
  const stored = await getConversation(conversationId)
  const assistant = assistantOf(stored)
  assert(outcome.kind === 'failed' && outcome.code === 'network-or-cors', 'partial root network error returns failed/network outcome')
  assert(assistant?.content === '部分内容' && assistant.status === 'failed' && !!assistant.error, 'partial root assistant content is durable and marked failed')
assert(getSessionsSendErrorTarget()?.conversationId === conversationId, 'partial root failure keeps error ownership')
}

// The branch path retains and marks partial output under the same stream contract.
await resetRuntime()
{
  const { conversationId, branchId } = await seedBranch()
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(delta('分支部分')))
      setTimeout(() => controller.error(new Error('branch socket closed')), 15)
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const outcome = await runBranchReply(conversationId, branchId, 'partial branch', [])
  const assistant = (await getBranch(branchId))?.messages.find((message) => message.role === 'assistant')
  assert(outcome.kind === 'failed' && outcome.code === 'network-or-cors', 'partial branch network error returns failed/network outcome')
  assert(assistant?.content === '分支部分' && assistant.status === 'failed' && !!assistant.error, 'partial branch assistant content is durable and marked failed')
}

// FCR-02: stop is distinct from failure and marks partial output as aborted.
await resetRuntime()
{
  const conversationId = await sessionsActions.newChat()
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  globalThis.fetch = (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(new TextEncoder().encode(delta('已生成')))
      ;(init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const pending = sessionsActions.sendUserMessage(conversationId, 'stop root', [])
  await waitFor(() => getSessionsStatus() === 'streaming', 'root stream start')
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  assert(!!streamController, 'root stop fixture started a controllable stream')
  sessionsActions.stopGenerating()
  const outcome = await pending
  const assistant = assistantOf(await getConversation(conversationId))
  assert(outcome.kind === 'aborted', 'root stop returns aborted rather than failed')
  assert(assistant?.status === 'aborted' && assistant.content === '已生成', 'root stop retains partial output with aborted marker')
}

// FCR-06: root and branch reject blank quick follow-ups before acceptance/network.
await resetRuntime()
{
  const conversationId = await sessionsActions.newChat()
  let requests = 0
  globalThis.fetch = (async () => { requests++; return sse(done()) }) as typeof fetch
  const before = (await getConversation(conversationId))?.messages.length ?? -1
  const rootOutcome = await sessionsActions.sendUserMessage(conversationId, '   ', [], { quickFollowUp: { promptId: 'empty-root', labelSnapshot: '空', promptSnapshot: '   ' } })
  const after = (await getConversation(conversationId))?.messages.length ?? -1
  assert(rootOutcome.kind === 'rejected' && rootOutcome.code === 'empty-input', 'root whitespace quick follow-up is rejected')
  assert(requests === 0 && before === after, 'root whitespace quick follow-up makes zero requests and messages')

  const { branchId } = await seedBranch()
  const branchBefore = (await getBranch(branchId))?.messages.length ?? -1
  const branchOutcome = await runBranchReply(conversationId, branchId, '', [], { quickFollowUp: { promptId: 'empty-branch', labelSnapshot: '空', promptSnapshot: '' }, draftDisposition: 'preserve' })
  const branchAfter = (await getBranch(branchId))?.messages.length ?? -1
  assert(branchOutcome.kind === 'rejected' && branchOutcome.code === 'empty-input', 'branch empty quick follow-up is rejected')
  assert(requests === 0 && branchBefore === branchAfter, 'branch empty quick follow-up makes zero requests and messages')
}

const quickBase: PromptDefinition = {
  id: 'stage2-quick', kind: 'quick-follow-up', name: 'Stage 2', description: '', source: 'custom', enabled: true,
  createdAt: 1, updatedAt: 1, revision: 1, label: '继续', userPrompt: '继续', pinned: false, sortOrder: 0,
}
assert(getPromptDefinitionIssues({ ...quickBase, userPrompt: '   ' }).some((issue) => issue.code === 'INVALID_USER_PROMPT'), 'quick-follow-up domain validation rejects whitespace content')

function minimalV6(): any {
  return {
    format: 'ai-education-reader-backup', version: 6, exportedAt: 1,
    settings: { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false },
    conversations: [{ id: 'backup-conversation', title: '备份', createdAt: 1, updatedAt: 1, messages: [{ id: 'backup-message', role: 'user', content: '问题', images: [] }], promptTransitions: [] }],
    annotations: [], attachments: [], documents: [], drafts: [], appearance: 'system',
    branches: [], branchDrafts: [], artifacts: [], activeBranches: [], documentNotes: [],
    prompts: [], promptPreferences: { version: 1, defaultConversationModeId: 'builtin-conversation-default', hiddenBuiltinPromptIds: [], activeProtocolOverrideByDomain: {} },
  }
}
function mustRejectBackup(value: unknown, label: string): void {
  let rejected = false
  try { parseAndValidate(value) } catch (error) { rejected = error instanceof BackupError }
  assert(rejected, label)
}
{
  const emptyPromptBackup = minimalV6()
  emptyPromptBackup.prompts = [{ ...quickBase, userPrompt: '   ' }]
  mustRejectBackup(emptyPromptBackup, 'V6 backup rejects an empty quick-follow-up definition atomically')
  const emptySnapshotBackup = minimalV6()
  emptySnapshotBackup.conversations[0].messages[0].quickFollowUp = { promptId: 'q', labelSnapshot: '继续', promptSnapshot: '   ' }
  mustRejectBackup(emptySnapshotBackup, 'V6 backup rejects an empty quick-follow-up message snapshot')
}

// Existing local dirty rows are isolated from prompt catalog boot instead of crashing it.
await idbClearAll()
await idbPut('prompts', { ...quickBase, userPrompt: '   ' })
let catalog: PromptDefinition[] = []
let catalogThrew = false
try { catalog = await listPromptCatalog('quick-follow-up') } catch { catalogThrew = true }
assert(!catalogThrew && !catalog.some((item) => item.id === quickBase.id), 'invalid local quick prompt is isolated from catalog boot')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
