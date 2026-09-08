import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { idbClearAll } from '../src/storage/idb.ts'
import { getConversation } from '../src/storage/storage.ts'
import { DEFAULT_SETTINGS, saveSettings } from '../src/engine/settings-store.ts'
import { initStore, sessionsActions } from '../src/engine/sessions-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { BUILTIN_PROMPT_REGISTRY } from '../src/prompts/prompt-registry.ts'
import { copyPromptDefinition } from '../src/prompts/prompt-service.ts'
import { buildEffectivePromptPath } from '../src/prompts/effective-prompt-path.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

async function resetRuntime(): Promise<void> {
  await idbClearAll()
  await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat', apiBaseUrl: 'https://api.deepseek.com' })
  await initStore()
}

function seedMessage(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1 }
}

async function seedBranch(): Promise<{ conversationId: string; branchId: string; forkMessageId: string }> {
  const conversationId = await sessionsActions.newChat()
  await sessionsActions.addAssistant(conversationId, '已有回答')
  const conversation = await getConversation(conversationId) as Conversation
  const forkMessageId = conversation.messages[conversation.messages.length - 1].id
  const branch = await createBranchFromMessage(conversationId, forkMessageId)
  return { conversationId, branchId: branch.id, forkMessageId }
}

async function testBranchFailureOutcome(): Promise<void> {
  await resetRuntime()
  const { conversationId, branchId } = await seedBranch()
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(JSON.stringify({ error: { message: 'forced failure' } }), { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const outcome = await runBranchReply(conversationId, branchId, 'branch request')
  const branch = await getBranch(branchId)
  assert(outcome.kind === 'failed' && outcome.code === 'server', 'V200-FCR-02 branch HTTP 500 returns a typed failed outcome')
  assert(requests === 1, 'V200-FCR-02 sends exactly one mocked failing request')
  assert(branch?.messages.some((message) => message.role === 'user' && message.content === 'branch request') === true, 'V200-FCR-02 accepted user message remains durable after failure')
  const hiddenEmptyAssistant = branch?.messages.some((message) => message.role === 'assistant' && !message.content && !(message as Message & { status?: string; error?: string }).status && !(message as Message & { status?: string; error?: string }).error)
  assert(hiddenEmptyAssistant !== true, 'V200-FCR-02 does not leave an unmarked empty assistant success')
}

async function testEmptyBranchQuickFollowUp(): Promise<void> {
  await resetRuntime()
  const { conversationId, branchId } = await seedBranch()
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const before = (await getBranch(branchId))?.messages.length ?? -1
  const outcome = await runBranchReply(conversationId, branchId, '   ', [], {
    quickFollowUp: { promptId: 'empty-quick', labelSnapshot: '空追问', promptSnapshot: '   ' },
    draftDisposition: 'preserve',
  })
  const after = await getBranch(branchId)
  assert(outcome.kind === 'rejected' && outcome.code === 'empty-input', 'V200-FCR-06 whitespace quick follow-up is rejected before branch acceptance')
  assert(requests === 0, 'V200-FCR-06 whitespace quick follow-up makes zero network requests')
  assert(after?.messages.length === before, 'V200-FCR-06 whitespace quick follow-up adds zero branch messages')
}

async function testProtocolCopyOfCopy(): Promise<void> {
  await resetRuntime()
  const canonical = BUILTIN_PROMPT_REGISTRY.find((definition) => definition.kind === 'protocol')
  if (!canonical || canonical.kind !== 'protocol') throw new Error('protocol builtin fixture is missing')
  const copyA = await copyPromptDefinition(canonical.id, { name: 'RED Protocol A' })
  const copyB = await copyPromptDefinition(copyA.definition.id, { name: 'RED Protocol B' })
  assert(copyA.definition.source === 'experimental', 'V200-FCR-04 copy of canonical creates an experimental protocol')
  assert(copyB.definition.source === 'experimental', 'V200-FCR-04 copy of experimental remains experimental')
  assert(copyB.definition.baseProtocolId === canonical.id, 'V200-FCR-04 copy-of-copy points directly to canonical')
}

function makeBranch(id: string, conversationId: string, forkMessageId: string): ConversationBranch {
  return { id, conversationId, parentBranchId: undefined, forkMessageId, title: id, createdAt: 1, updatedAt: 1, messages: [] }
}

async function testPromptPathDoesNotMapUnrelatedBranches(): Promise<void> {
  const conversation: Conversation = {
    id: 'prompt-path-red',
    title: 'Prompt path RED',
    createdAt: 1,
    updatedAt: 1,
    messages: [seedMessage('prompt-path-root', 'assistant', 'root')],
  }
  const active = makeBranch('active-branch', conversation.id, 'prompt-path-root')
  const branches = [active, ...Array.from({ length: 5000 }, (_, index) => makeBranch('unrelated-' + index, conversation.id, 'prompt-path-root'))]
  let mapCalls = 0
  const observed = new Proxy(branches, {
    get(target, property, receiver) {
      if (property === 'map') mapCalls++
      return Reflect.get(target, property, receiver)
    },
  }) as ConversationBranch[]
  buildEffectivePromptPath(conversation, observed, active.id)
  mapCalls = 0
  const result = buildEffectivePromptPath(conversation, observed, active.id)
  assert(result.resolved, 'V200-FCR-08 effective prompt path remains resolved with unrelated branches')
  assert(mapCalls === 0, 'V200-FCR-08 warm materialization does not map all unrelated branches')
}

function testReleaseRegistration(): void {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
  const release = readFileSync('scripts/test-release.mjs', 'utf8')
  assert(typeof packageJson.scripts?.['test:e2e-v201-regressions'] === 'string', 'V200-FCR-09 has a stable npm script for the regression browser gate')
  assert(release.includes("'e2e-v201-regressions'"), 'V200-FCR-09 registers the regression browser gate in CORE_E2E')
}

await testBranchFailureOutcome()
await testEmptyBranchQuickFollowUp()
await testProtocolCopyOfCopy()
await testPromptPathDoesNotMapUnrelatedBranches()
testReleaseRegistration()

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
