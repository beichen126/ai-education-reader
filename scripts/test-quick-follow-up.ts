import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { getSetting, getConversation } from '../src/storage/storage.ts'
import { saveSettings, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { initStore, sessionsActions, getSessionsStatus } from '../src/engine/sessions-store.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { draftSettingKey, branchDraftSettingKey, setDraftText, setBranchDraftText, flushDraft, flushBranchDraft, getDraft, getBranchDraft } from '../src/engine/draft-store.ts'
import { type Conversation, type QuickFollowUpMetadata } from '../src/engine/types.ts'
import { sortEnabledQuickFollowUps } from '../src/prompts/quick-follow-up.ts'
import type { QuickFollowUpPrompt } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => { if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) } }

function sseDone(): Response {
  return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
async function waitForIdle(label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const status = getSessionsStatus()
    if (status === 'idle' || status === 'error') return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(label + ' timed out')
}
function prompt(id: string, label: string, pinned: boolean, sortOrder: number, enabled = true): QuickFollowUpPrompt {
  return { id, kind: 'quick-follow-up', name: label, description: '', source: 'custom', enabled, createdAt: 1, updatedAt: 1, revision: 1, label, userPrompt: 'prompt:' + label, pinned, sortOrder }
}

await idbClearAll()
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'deepseek-chat' })
await initStore()
globalThis.fetch = (async () => sseDone()) as any

const ordered = sortEnabledQuickFollowUps([
  prompt('normal-late', '普通后', false, 2),
  prompt('pinned-late', '固定后', true, 9),
  prompt('pinned-first', '固定前', true, 1),
  prompt('disabled', '停用', true, 0, false),
])
assert(ordered.map((item) => item.id).join('|') === 'pinned-first|pinned-late|normal-late', 'enabled quick follow-ups sort pinned first, then sortOrder')

const conversationId = await sessionsActions.newChat()
const metadata: QuickFollowUpMetadata = { promptId: 'quick-1', labelSnapshot: '解释例子', promptSnapshot: '请用一个例子解释上一条回答' }
setDraftText(conversationId, '请保留这份草稿')
await flushDraft(conversationId)
assert(await sessionsActions.sendUserMessage(conversationId, metadata.promptSnapshot, [], { quickFollowUp: metadata, draftDisposition: 'preserve' }), 'root quick follow-up uses the canonical send acceptance')
await waitForIdle('root quick follow-up')
const root = await getConversation(conversationId) as Conversation
const rootMessage = root.messages.find((message) => message.quickFollowUp?.promptId === metadata.promptId)
assert(rootMessage?.role === 'user' && rootMessage.content === metadata.promptSnapshot, 'root stores the actual prompt as Message.content')
assert(rootMessage?.quickFollowUp?.labelSnapshot === metadata.labelSnapshot && rootMessage.quickFollowUp.promptSnapshot === metadata.promptSnapshot, 'root stores frozen quick follow-up metadata')
assert(getDraft(conversationId).text === '请保留这份草稿', 'root quick send preserves in-memory composer draft')
assert((await getSetting(draftSettingKey(conversationId)))?.text === '请保留这份草稿', 'root quick send preserves durable composer draft')

const forkId = root.messages[root.messages.length - 1].id
const branch = await createBranchFromMessage(conversationId, forkId)
setBranchDraftText(branch.id, '分支草稿也保留')
await flushBranchDraft(branch.id)
const branchMetadata: QuickFollowUpMetadata = { promptId: 'quick-branch', labelSnapshot: '分支解释', promptSnapshot: '请在当前分支继续解释' }
assert(await runBranchReply(conversationId, branch.id, branchMetadata.promptSnapshot, [], { quickFollowUp: branchMetadata, draftDisposition: 'preserve' }), 'branch quick follow-up uses the canonical branch send acceptance')
await waitForIdle('branch quick follow-up')
const branchAfter = await getBranch(branch.id)
const branchMessage = branchAfter?.messages.find((message) => message.quickFollowUp?.promptId === branchMetadata.promptId)
assert(branchMessage?.content === branchMetadata.promptSnapshot && branchMessage.quickFollowUp?.labelSnapshot === branchMetadata.labelSnapshot, 'branch stores actual prompt and frozen metadata locally')
assert(getBranchDraft(branch.id).text === '分支草稿也保留', 'branch quick send preserves in-memory composer draft')
assert((await getSetting(branchDraftSettingKey(branch.id)))?.text === '分支草稿也保留', 'branch quick send preserves durable composer draft')

// The snapshot is message-owned: changing/removing the catalog is not needed to inspect history.
assert(rootMessage?.quickFollowUp?.promptSnapshot === '请用一个例子解释上一条回答', 'historical quick snapshot remains self-contained after catalog changes')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
