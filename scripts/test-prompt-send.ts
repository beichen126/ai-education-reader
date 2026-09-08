import 'fake-indexeddb/auto'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { getConversation, saveConversation, setSetting } from '../src/storage/storage.ts'
import { saveSettings, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { getSessionsStatus, sessionsActions } from '../src/engine/sessions-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch, saveBranch } from '../src/branches/branch-store.ts'
import { prepareAcceptedSendContext, resolveCurrentConversationModeResult } from '../src/prompts/prompt-send.ts'
import { projectLogicalPromptContext } from '../src/prompts/prompt-compile-strategies.ts'
import { savePromptRecord, deletePromptRecord } from '../src/prompts/prompt-store.ts'
import { getPromptPreferences, setBuiltinPromptHidden, setDefaultConversationModeId } from '../src/prompts/prompt-preferences.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import { listEffectivePromptDefinitions, resolvePromptDefinition } from '../src/prompts/prompt-resolution.ts'
import { listPromptCatalog } from '../src/prompts/prompt-service.ts'
import { listConversationModeDefinitions, switchConversationMode } from '../src/prompts/prompt-mode-service.ts'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import type { PromptSnapshot } from '../src/prompts/prompt-types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function snapshot(id: string, name: string, content: string, revision = 1): PromptSnapshot {
  return { profileId: id, kind: 'conversation-mode', name, content, revision, source: 'custom', capturedAt: revision }
}
function definition(id: string, name: string, content: string, revision = 1): any {
  return { id, kind: 'conversation-mode', name, description: name, source: 'custom', enabled: true, createdAt: 1, updatedAt: revision, revision, systemPrompt: content }
}
function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1 }
}
function deltaDone(): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'
}

const backgroundRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown) => { backgroundRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)

async function waitForSettled<T>(label: string, read: () => Promise<T>, done: (value: T, status: string) => boolean, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let lastStatus = getSessionsStatus()
  while (Date.now() <= deadline) {
    last = await read()
    lastStatus = getSessionsStatus()
    if (done(last, lastStatus)) return last
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(label + ' timed out after ' + timeoutMs + 'ms; status=' + lastStatus + '; durable=' + JSON.stringify(last))
}

let requests: any[] = []
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body || '{}')))
  return new Response(deltaDone(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}) as any

await idbClearAll()
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat' })
const modeA = definition('mode-a', '模式 A', 'A prompt')
const modeB = definition('mode-b', '模式 B', 'B prompt')
const modeC = definition('mode-c', '模式 C', 'C prompt')
await savePromptRecord(modeA)
await savePromptRecord(modeB)
await savePromptRecord(modeC)
await setDefaultConversationModeId(modeA.id)

// Root send: transition + user message are both durable before the stream starts.
const conversationId = await sessionsActions.newChat()
requests = []
assert(await sessionsActions.sendUserMessage(conversationId, 'first', []), 'root send accepts through the canonical path')
let conversation = await waitForSettled('root first send', () => getConversation(conversationId) as Promise<Conversation | undefined>, (value, status) => !!value && value.messages.length === 2 && (status === 'idle' || status === 'error')) as Conversation
assert(conversation.messages.length === 2, 'root acceptance stores user plus streamed assistant')
assert(conversation.promptTransitions?.length === 1 && conversation.promptTransitions[0].snapshot.content === 'A prompt', 'root acceptance stores the mode transition with the user message')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('A prompt'), 'request uses the accepted frozen mode snapshot')

// A deprecated route-local mode switch remains a historical boundary, but a
// new send must resolve the current canonical default instead of inheriting it.
await switchConversationMode({ conversationId, modeId: modeB.id })
await sessionsActions.reload(conversationId)
requests = []
assert(await sessionsActions.sendUserMessage(conversationId, 'second', []), 'send after a deprecated mode boundary accepts')
conversation = await waitForSettled('root second send', () => getConversation(conversationId) as Promise<Conversation | undefined>, (value, status) => !!value && value.messages.length === 4 && (status === 'idle' || status === 'error')) as Conversation
assert(conversation.promptTransitions?.map((item) => item.snapshot.content).join('|') === 'A prompt|A prompt', 'new send replaces an unconsumed deprecated route boundary with the current default')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('A prompt') && !String(requests[0].messages[0].content).includes('B prompt'), 'new send ignores the deprecated route mode and uses the default')

// Changing the default preference does not rewrite the historical timeline, but
// new sends still resolve the current default.
await setDefaultConversationModeId(modeA.id)
requests = []
assert(await sessionsActions.sendUserMessage(conversationId, 'third', []), 'route snapshot send accepts despite global default reverting')
conversation = await waitForSettled('route snapshot send', () => getConversation(conversationId) as Promise<Conversation | undefined>, (value, status) => !!value && value.messages.length === 6 && (status === 'idle' || status === 'error')) as Conversation
assert(conversation.promptTransitions?.map((item) => item.snapshot.content).join('|') === 'A prompt|A prompt', 'new default sends do not add duplicate transitions at the same message boundary')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('A prompt'), 'current default remains the active request mode')

// Profile edits after acceptance cannot change the already prepared logical request.
const before = conversation.messages
const frozen = await prepareAcceptedSendContext({
  threadRef: { type: 'root', conversationId },
  messagesBeforeAcceptance: before,
  candidateMessages: [...before, msg('frozen-user', 'user', 'frozen')],
  effectiveTransitions: conversation.promptTransitions ?? [],
  localTransitions: conversation.promptTransitions ?? [],
  acceptedMessageId: 'frozen-user',
  currentModeSnapshot: snapshot(modeB.id, '模式 B', 'B prompt', 1),
  now: Date.now() + 1000,
})
await savePromptRecord(definition(modeB.id, '模式 B', 'B prompt edited after send', 2))
const frozenProjected = await projectLogicalPromptContext(frozen.context.logical, frozen.context.compilePolicy.systemMessagePolicy)
assert(JSON.stringify(frozenProjected).includes('B prompt') && !JSON.stringify(frozenProjected).includes('edited after send'), 'profile revision after acceptance cannot alter the frozen request')

// Branch send inherits root history, preserves a deprecated local boundary, and
// then captures the canonical default for the new branch message.
const forkMessageId = conversation.messages[conversation.messages.length - 1].id
const branch = await createBranchFromMessage(conversationId, forkMessageId)
await switchConversationMode({ conversationId, branchId: branch.id, modeId: modeC.id })
requests = []
// The branch path is read before acceptance and becomes the sole input to compile + stream.
assert(await (await import('../src/engine/branch-thread.ts')).runBranchReply(conversationId, branch.id, 'branch', []), 'branch send accepts through the same semantic pipeline')
const branchAfter = await waitForSettled('branch send', () => getBranch(branch.id) as Promise<ConversationBranch | undefined>, (value, status) => !!value && value.messages.length === 2 && (status === 'idle' || status === 'error')) as ConversationBranch
const rootAfterBranch = await getConversation(conversationId) as Conversation
assert(branchAfter.promptTransitions?.length === 1 && branchAfter.promptTransitions[0].snapshot.content === 'A prompt', 'branch replaces an unconsumed deprecated local mode with the canonical default')
assert(rootAfterBranch.promptTransitions?.map((item) => item.snapshot.content).join('|') === 'A prompt|A prompt', 'branch send does not mutate root timeline')
assert(requests[0]?.messages?.[0]?.role === 'system' && String(requests[0].messages[0].content).includes('A prompt') && !String(requests[0].messages[0].content).includes('C prompt'), 'branch request uses the canonical default instead of the deprecated local mode')
assert(rootAfterBranch.messages.every((item) => item.content !== 'branch'), 'branch user message does not pollute root')

// Invalid timeline is rejected before acceptance; no caller should commit its candidate.
const badConversation: Conversation = {
  id: 'bad', title: 'bad', createdAt: 1, updatedAt: 1,
  messages: [msg('bad-m0', 'user', 'bad')],
}
await saveConversation(badConversation)
let rejected = false
try {
  await prepareAcceptedSendContext({
    threadRef: { type: 'root', conversationId: 'bad' },
    messagesBeforeAcceptance: badConversation.messages,
    candidateMessages: [...badConversation.messages, msg('bad-m1', 'user', 'new')],
    effectiveTransitions: [
      { id: 't1', afterMessageId: null, snapshot: snapshot('mode-a', '模式 A', 'A prompt'), createdAt: 1 },
      { id: 't2', afterMessageId: null, snapshot: snapshot('mode-b', '模式 B', 'B prompt'), createdAt: 2 },
    ],
    localTransitions: [],
    acceptedMessageId: 'bad-m1',
    currentModeSnapshot: snapshot('mode-a', '模式 A', 'A prompt'),
  })
} catch { rejected = true }
assert(rejected, 'invalid prompt timeline fails before message acceptance')
assert((await getConversation('bad'))?.messages.length === 1, 'compile failure leaves the durable conversation unchanged')

// Acceptance contract gates: reject malformed or stale candidates before any
// prompt compilation or durable message transaction can run.
const contractBefore = conversation.messages
const contractTransitions = conversation.promptTransitions ?? []
const contractInput = (overrides: Record<string, unknown> = {}) => ({
  threadRef: { type: 'root' as const, conversationId },
  messagesBeforeAcceptance: contractBefore,
  candidateMessages: [...contractBefore, msg('contract-new', 'user', 'new')],
  effectiveTransitions: contractTransitions,
  localTransitions: contractTransitions,
  acceptedMessageId: 'contract-new',
  currentModeSnapshot: snapshot(modeB.id, '模式 B', 'B prompt', 1),
  ...overrides,
})
async function assertContractReject(input: any, code: string, label: string): Promise<void> {
  let actual = ''
  try { await prepareAcceptedSendContext(input) } catch (error) { actual = String((error as any)?.code ?? '') }
  assert(actual === code, label + ' (' + actual + ')')
}
await assertContractReject(contractInput({ acceptedMessageId: '' }), 'accepted-message-missing', 'acceptance rejects a missing acceptedMessageId')
await assertContractReject(contractInput({ acceptedMessageId: contractBefore[0].id, candidateMessages: [...contractBefore, msg(contractBefore[0].id, 'user', 'duplicate')] }), 'accepted-message-already-exists', 'acceptance rejects an accepted id already present before acceptance')
await assertContractReject(contractInput({ acceptedMessageId: 'contract-assistant', candidateMessages: [...contractBefore, msg('contract-assistant', 'assistant', 'wrong role')] }), 'accepted-message-role', 'acceptance rejects an assistant accepted message')
await assertContractReject(contractInput({ candidateMessages: [msg('wrong-prefix', 'user', 'wrong'), ...contractBefore.slice(1), msg('contract-new', 'user', 'new')] }), 'candidate-not-extension', 'acceptance rejects a candidate that does not extend the previous path')
await assertContractReject(contractInput({ candidateMessages: [...contractBefore, msg('contract-duplicate', 'user', 'duplicate'), msg('contract-duplicate', 'user', 'duplicate')] }), 'duplicate-message-id', 'acceptance rejects duplicate candidate message ids')
await saveBranch({ id: 'wrong-owner-branch', conversationId: 'other-conversation', forkMessageId: contractBefore[0].id, title: 'wrong owner', createdAt: 1, updatedAt: 1, messages: [] })
await assertContractReject(contractInput({
  threadRef: { type: 'branch' as const, conversationId, branchId: 'wrong-owner-branch' },
}), 'thread-owner-mismatch', 'acceptance rejects a branch owned by another conversation')
for (const [field, value] of [
  ['source', 'not-a-source'],
  ['capturedAt', -1],
  ['revision', 0],
  ['name', 42],
] as const) {
  await assertContractReject(contractInput({ currentModeSnapshot: { ...snapshot(modeB.id, '模式 B', 'B prompt', 1), [field]: value } }), 'invalid-prompt-snapshot', 'acceptance rejects malformed snapshot ' + field)
}

const emptyDefault = await prepareAcceptedSendContext({
  threadRef: { type: 'root', conversationId: 'empty-default' },
  messagesBeforeAcceptance: [], candidateMessages: [msg('empty-default-user', 'user', '默认问题')],
  effectiveTransitions: [], localTransitions: [], acceptedMessageId: 'empty-default-user',
  currentModeSnapshot: { profileId: BUILTIN_PROMPT_IDS.conversationDefault, kind: 'conversation-mode', name: '默认', content: '', source: 'builtin', revision: 1, capturedAt: 1 },
})
const emptyDefaultTransport = await projectLogicalPromptContext(emptyDefault.context.logical, 'flattened')
assert(!emptyDefaultTransport.some((item) => item.role === 'system'), 'all-empty default timeline does not inject a transport system message')

await setDefaultConversationModeId(BUILTIN_PROMPT_IDS.conversationSocratic)
await setBuiltinPromptHidden(BUILTIN_PROMPT_IDS.conversationSocratic, true)
const hiddenModeResult = await resolveCurrentConversationModeResult(100)
assert(hiddenModeResult.snapshot?.profileId === BUILTIN_PROMPT_IDS.conversationDefault && hiddenModeResult.snapshot.content === '' && hiddenModeResult.diagnostics.some((item) => item.code === 'disabled'), 'hidden non-empty built-in mode falls back to the canonical empty default with a diagnostic')
const effectiveConversationModes = await listEffectivePromptDefinitions('conversation-mode')
const catalogConversationModes = await listPromptCatalog('conversation-mode')
const pickerConversationModes = await listConversationModeDefinitions()
assert(effectiveConversationModes.find((item) => item.id === BUILTIN_PROMPT_IDS.conversationSocratic)?.enabled === false, 'effective catalog projects hidden built-in to enabled=false')
assert(catalogConversationModes.length === 1 && catalogConversationModes[0].id === BUILTIN_PROMPT_IDS.conversationDefault && !pickerConversationModes.some((item) => item.id === BUILTIN_PROMPT_IDS.conversationSocratic), 'visible catalog exposes only default while hidden deprecated mode stays unavailable to the picker')

await setBuiltinPromptHidden(BUILTIN_PROMPT_IDS.conversationSocratic, false)
const disabledMode = definition('disabled-mode', '禁用模式', 'should not send')
await savePromptRecord({ ...disabledMode, enabled: false })
await setDefaultConversationModeId(disabledMode.id)
const disabledModeResult = await resolveCurrentConversationModeResult(101)
assert(disabledModeResult.snapshot?.profileId === BUILTIN_PROMPT_IDS.conversationDefault && disabledModeResult.diagnostics.some((item) => item.code === 'disabled'), 'disabled custom mode falls back to the canonical empty default')

let invalidDefaultRejected = false
try { await setDefaultConversationModeId('missing-mode-id') } catch (error) { invalidDefaultRejected = (error as any)?.code === 'invalid-default-mode' }
assert(invalidDefaultRejected, 'preference setter rejects a missing default mode id')
await setSetting('promptPreferences', { ...(await getPromptPreferences()), defaultConversationModeId: 'missing-mode-id' })
const missingModeResult = await resolveCurrentConversationModeResult(102)
assert(missingModeResult.snapshot?.profileId === BUILTIN_PROMPT_IDS.conversationDefault && missingModeResult.diagnostics.some((item) => item.code === 'missing'), 'missing mode id falls back with a structured diagnostic')

let wrongDefaultRejected = false
try { await setDefaultConversationModeId(BUILTIN_PROMPT_IDS.artifactNote) } catch (error) { wrongDefaultRejected = (error as any)?.code === 'invalid-default-mode' }
assert(wrongDefaultRejected, 'preference setter rejects a non-conversation default mode')
await setSetting('promptPreferences', { ...(await getPromptPreferences()), defaultConversationModeId: BUILTIN_PROMPT_IDS.artifactNote })
const wrongKindModeResult = await resolveCurrentConversationModeResult(103)
assert(wrongKindModeResult.snapshot?.profileId === BUILTIN_PROMPT_IDS.conversationDefault && wrongKindModeResult.diagnostics.some((item) => item.code === 'kind-mismatch'), 'wrong-kind mode id falls back without sending an artifact prompt')
const wrongFallback = resolvePromptDefinition('missing', [
  { ...definition('fallback-artifact', 'artifact fallback', 'wrong'), kind: 'artifact', artifactKind: 'note', userPrompt: 'wrong' },
], { expectedKind: 'conversation-mode', fallbackId: 'fallback-artifact' })
assert(!wrongFallback.definition && wrongFallback.diagnostics.some((item) => item.code === 'fallback-kind-mismatch'), 'fallback kind mismatch is rejected instead of returning a wrong-scope prompt')

const resetNow = Date.now() + 1000
await setDefaultConversationModeId(modeB.id)
const resetContext = await prepareAcceptedSendContext({
  threadRef: { type: 'root', conversationId },
  messagesBeforeAcceptance: conversation.messages,
  candidateMessages: [...conversation.messages, msg('reset-user', 'user', 'reset')],
  effectiveTransitions: conversation.promptTransitions ?? [],
  localTransitions: conversation.promptTransitions ?? [],
  acceptedMessageId: 'reset-user',
  currentModeSnapshot: { profileId: BUILTIN_PROMPT_IDS.conversationDefault, kind: 'conversation-mode', name: '默认', content: '', source: 'builtin', revision: 1, capturedAt: resetNow },
  now: resetNow,
})
const resetInterleaved = await projectLogicalPromptContext(resetContext.context.logical, 'interleaved')
assert(resetInterleaved.some((item) => item.role === 'system' && String(item.content).includes('current-mode-reset')), 'switching from a non-empty mode to empty default emits a deterministic reset frame')
const resetFlattened = await projectLogicalPromptContext(resetContext.context.logical, 'flattened')
assert(resetFlattened.some((item) => item.role === 'system' && String(item.content).includes('currentMode') && String(item.content).includes('"content":""')), 'flattened history keeps a deterministic summary when current mode is empty')

await setDefaultConversationModeId(BUILTIN_PROMPT_IDS.conversationDefault)
await deletePromptRecord(disabledMode.id)
await setBuiltinPromptHidden(BUILTIN_PROMPT_IDS.conversationSocratic, false)

await deletePromptRecord(modeA.id)
await deletePromptRecord(modeB.id)
await deletePromptRecord(modeC.id)
await closeDb()
await new Promise<void>((resolve) => setImmediate(resolve))
process.off('unhandledRejection', onUnhandledRejection)
assert(backgroundRejections.length === 0, 'background send tasks settle without unhandled rejection')
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
