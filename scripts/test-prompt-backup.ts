import 'fake-indexeddb/auto'
import { idbClearAll, idbGetAll, closeDb } from '../src/storage/idb.ts'
import { getSetting, saveConversation, setSetting } from '../src/storage/storage.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup, BackupError } from '../src/export/backup-import.ts'
import { savePromptRecord } from '../src/prompts/prompt-store.ts'
import { savePromptPreferences } from '../src/prompts/prompt-preferences.ts'
import type { PromptDefinition, PromptUserPreferences, PromptSnapshot } from '../src/prompts/prompt-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function mustReject(value: unknown, message: string): void {
  let rejected = false
  try { parseAndValidate(value) } catch (error) { rejected = error instanceof BackupError }
  assert(rejected, 'rejects ' + message)
}

const settings = { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false }
const mode: PromptDefinition = {
  id: 'custom-mode', kind: 'conversation-mode', name: '自定义学习模式', description: 'test', source: 'custom', enabled: true,
  createdAt: 1, updatedAt: 2, revision: 1, systemPrompt: '请用循证方式回答。',
}
const protocol: PromptDefinition = {
  id: 'experimental-toc', kind: 'protocol', name: '自定义目录协议', description: 'test', source: 'experimental', enabled: true,
  createdAt: 1, updatedAt: 2, revision: 1, domain: 'ai-toc-structure', systemPrompt: '只输出结构。', overridePolicy: 'experimental',
}
const preferences: PromptUserPreferences = {
  version: 1, defaultConversationModeId: mode.id, hiddenBuiltinPromptIds: ['builtin-conversation-socratic'],
  activeProtocolOverrideByDomain: { 'ai-toc-structure': protocol.id }, sortPreference: 'name-asc',
}
const rootSnapshot: PromptSnapshot = {
  profileId: 'deleted-profile', kind: 'conversation-mode', name: '已删除的模式', content: '历史内容仍完整', source: 'custom', revision: 3, capturedAt: 3,
}
const protocolSnapshot: PromptSnapshot = {
  kind: 'protocol', name: '协议快照', content: '协议内容', source: 'experimental', capturedAt: 4,
}
const message = (id: string, content = id) => ({ id, role: 'user' as const, content, images: [], createdAt: 1, updatedAt: 1 })

function v6Backup() {
  const root = {
    id: 'conversation-1', title: '历史会话', createdAt: 1, updatedAt: 4,
    messages: [message('m1')],
    promptTransitions: [{ id: 'transition-root', afterMessageId: 'm1', snapshot: rootSnapshot, createdAt: 3 }],
  }
  const branch = {
    id: 'branch-1', conversationId: root.id, forkMessageId: 'm1', title: '分支', createdAt: 2, updatedAt: 4,
    messages: [message('m2', '分支消息')],
    promptTransitions: [{ id: 'transition-branch', afterMessageId: 'm2', snapshot: protocolSnapshot, createdAt: 4 }],
  }
  const artifact = {
    id: 'artifact-1', kind: 'note', title: '笔记', prompt: '旧提示词', createdAt: 4, updatedAt: 4, status: 'ready', content: '内容',
    source: {
      conversationId: root.id, branchId: branch.id, throughMessageId: 'm2', snapshot: {
        conversationId: root.id, branchId: branch.id, throughMessageId: 'm2', createdAt: 4,
        messages: [{ role: 'user', text: '分支消息', imageIds: [] }], provenance: [], sourceLabel: '历史会话', sourceDeleted: false,
      },
    },
    promptBundle: { template: { kind: 'artifact', name: '笔记模板', content: '模板内容', source: 'custom', capturedAt: 4 }, userPrompt: '用户要求', protocol: protocolSnapshot, resolvedAt: 4 },
  }
  return {
    format: 'ai-education-reader-backup', version: 6, exportedAt: 5, settings,
    conversations: [root], annotations: [], attachments: [], documents: [], drafts: [], appearance: 'system',
    branches: [branch], branchDrafts: [], artifacts: [artifact], activeBranches: [], documentNotes: [],
    prompts: [mode, protocol], promptPreferences: preferences,
  }
}

function oldBackup(version: 1 | 2 | 3 | 4 | 5): any {
  const value: any = {
    format: 'ai-education-reader-backup', version, exportedAt: 1, settings,
    conversations: [{ id: 'legacy-conversation', title: '旧会话', createdAt: 1, updatedAt: 1, messages: [message('legacy-message')] }],
    annotations: [], attachments: [],
  }
  if (version >= 2) value.documents = []
  if (version >= 3) { value.drafts = []; value.appearance = 'system' }
  if (version >= 4) { value.branches = []; value.branchDrafts = []; value.artifacts = []; value.activeBranches = [] }
  if (version >= 5) value.documentNotes = []
  return value
}

for (const version of [1, 2, 3, 4, 5] as const) {
  await idbClearAll()
  const legacy = parseAndValidate(oldBackup(version))
  await restoreBackup(legacy)
  const restoredPrompts = await idbGetAll('prompts')
  assert(restoredPrompts.length === 0 && (await getSetting('promptPreferences'))?.version === 1, 'V' + version + ' -> v2 resets prompt data to safe defaults')
}

const full = v6Backup() as any
full.conversations[0].messages[0].quickFollowUp = { promptId: 'quick-follow-up-deleted', labelSnapshot: '继续追问', promptSnapshot: '请继续解释' }
const parsed = parseAndValidate(full)
assert(parsed.version === 6, 'V6 full backup parses')
assert((parsed as any).promptPreferences.activeProtocolOverrideByDomain['ai-toc-structure'] === protocol.id, 'custom protocol override survives validation')
assert((parsed as any).conversations[0].promptTransitions[0].snapshot.profileId === 'deleted-profile', 'deleted profile reference is allowed when snapshot is complete')

mustReject({ ...full, prompts: [{ ...mode, source: 'builtin' }] }, 'persisted builtin prompt definition')
mustReject({ ...full, prompts: [{ ...mode, id: 'builtin-conversation-default' }] }, 'custom prompt definition shadowing a built-in ID')
const badTransition = JSON.parse(JSON.stringify(full))
badTransition.conversations[0].promptTransitions[0].afterMessageId = 'not-on-path'
mustReject(badTransition, 'transition after an unrelated message')
const badBundle = JSON.parse(JSON.stringify(full))
badBundle.artifacts[0].promptBundle.protocol.kind = 'artifact'
mustReject(badBundle, 'artifact protocol snapshot with the wrong kind')

await idbClearAll()
await saveConversation(full.conversations[0])
await savePromptRecord(mode)
await savePromptRecord(protocol)
await savePromptPreferences(preferences)
await setSetting('apiKey', 'must-not-export')
const built = await buildBackup()
assert(built.version === 6 && built.prompts.length === 2 && built.promptPreferences.sortPreference === 'name-asc', 'new build emits V6 prompt data')
assert(!('apiKey' in built.settings), 'V6 backup excludes API key')
parseAndValidate(built)
assert(true, 'new V6 backup passes immediate self-import validation')

await idbClearAll()
await restoreBackup(parsed)
const restoredPromptRows = await idbGetAll('prompts')
const restoredPrefs = await getSetting('promptPreferences')
assert(restoredPromptRows.length === 2 && restoredPromptRows.some((row: any) => row.id === protocol.id), 'V6 restore writes prompt definitions')
assert(restoredPrefs?.activeProtocolOverrideByDomain?.['ai-toc-structure'] === protocol.id, 'V6 restore writes prompt preferences')
const restoredConversation = (await idbGetAll('conversations'))[0] as any
const restoredBranch = (await idbGetAll('conversationBranches'))[0] as any
const restoredArtifact = (await idbGetAll('artifacts'))[0] as any
assert(restoredConversation.promptTransitions.length === 1 && restoredConversation.messages[0].quickFollowUp.labelSnapshot === '继续追问', 'V6 restore preserves root transitions and quick metadata')
assert(restoredBranch.promptTransitions.length === 1 && restoredBranch.promptTransitions[0].afterMessageId === 'm2', 'V6 restore preserves branch transition')
assert(restoredArtifact.promptBundle.protocol.content === '协议内容', 'V6 restore preserves artifact prompt bundle')

const oldPrompt = { ...mode, id: 'old-prompt' }
await idbClearAll()
await savePromptRecord(oldPrompt)
const aborting = {
  ...oldBackup(5), version: 6, documents: [], drafts: [], appearance: 'system', branches: [], branchDrafts: [], artifacts: [], activeBranches: [], documentNotes: [],
  prompts: [], promptPreferences: { version: 1, defaultConversationModeId: 'builtin-conversation-default', hiddenBuiltinPromptIds: [], activeProtocolOverrideByDomain: {} },
  attachments: [
    { id: 'valid-attachment', meta: { id: 'valid-attachment', name: 'a.png', mimeType: 'image/png', size: 1, createdAt: 1, updatedAt: 1 }, mimeType: 'image/png', data: 'AQ==' },
    { id: 'broken-attachment', meta: { id: 'broken-attachment', name: 'b.png', mimeType: 'image/png', size: 1, createdAt: 1, updatedAt: 1 }, mimeType: 'image/png', data: '%%%' },
  ],
} as any
let restoreFailed = false
try { await restoreBackup(aborting) } catch { restoreFailed = true }
assert(restoreFailed, 'restore aborts on a staged binary decode failure')
assert((await idbGetAll('prompts')).some((row: any) => row.id === oldPrompt.id), 'restore abort keeps old prompt data')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
