import 'fake-indexeddb/auto'
import { parseAndValidate, restoreBackup, BackupError } from '../src/export/backup-import.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import { getConversation, saveConversation } from '../src/storage/storage.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

type BackupVersion = 1 | 2 | 3 | 4 | 5 | 6

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'message-1', role: 'assistant', content: 'answer', images: [], createdAt: 1, updatedAt: 1, ...overrides }
}

function backup(version: BackupVersion, rootMessage: Record<string, unknown>, branchMessage?: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    format: 'ai-education-reader-backup', version, exportedAt: 1, settings: {},
    conversations: [{ id: 'conversation-1', title: 'backup', createdAt: 1, updatedAt: 1, messages: [rootMessage] }],
    annotations: [], attachments: [],
  }
  if (version >= 2) Object.assign(base, { documents: [] })
  if (version >= 3) Object.assign(base, { drafts: [], appearance: 'system' })
  if (version >= 4) Object.assign(base, {
    branches: branchMessage ? [{ id: 'branch-1', conversationId: 'conversation-1', forkMessageId: 'message-1', title: 'branch', createdAt: 1, updatedAt: 1, messages: [branchMessage] }] : [],
    branchDrafts: [], artifacts: [], activeBranches: [],
  })
  if (version >= 5) Object.assign(base, { documentNotes: [] })
  if (version >= 6) Object.assign(base, {
    prompts: [],
    promptPreferences: { version: 1, defaultConversationModeId: 'builtin-conversation-default', hiddenBuiltinPromptIds: [], activeProtocolOverrideByDomain: {} },
    conversations: [{ id: 'conversation-1', title: 'backup', createdAt: 1, updatedAt: 1, messages: [rootMessage], promptTransitions: [] }],
  })
  return base
}

function accepts(input: unknown, messageText: string): void {
  let ok = false
  try { parseAndValidate(input); ok = true } catch { /* assertion below */ }
  assert(ok, messageText)
}

function rejects(input: unknown, messageText: string): void {
  let ok = false
  try { parseAndValidate(input) } catch (error) { ok = error instanceof BackupError }
  assert(ok, messageText)
}

for (const version of [1, 2, 3, 4, 5, 6] as const) {
  accepts(backup(version, { id: 'message-1', role: 'user', content: 'question', images: [], createdAt: 1, updatedAt: 1 }), `V${version} valid user message remains importable`)
}

for (const version of [1, 2, 3, 4, 5, 6] as const) {
  const input = backup(version, message({ content: '', status: 'failed', error: 'server failed' }))
  accepts(input, `V${version} failed assistant with empty content is accepted`)
  const parsed = parseAndValidate(input) as any
  assert(parsed.conversations[0].messages[0].error === 'server failed', `V${version} failed error text is preserved verbatim`)
}

for (const version of [1, 2, 3, 4, 5, 6] as const) {
  accepts(backup(version, message({ content: 'partial', status: 'aborted', error: '已停止生成' })), `V${version} aborted assistant is accepted`)
}

const invalidStates: Array<[Record<string, unknown>, string]> = [
  [message({ status: 'failed' }), 'failed without error'],
  [message({ status: 'aborted', error: '' }), 'aborted with empty error'],
  [message({ status: 'failed', error: '   ' }), 'failed with whitespace error'],
  [message({ status: 'failed', error: 42 }), 'failed with non-string error'],
  [message({ status: 'failed', error: {} }), 'failed with object error'],
  [message({ status: 'unknown', error: 'failure' }), 'unknown status'],
  [message({ status: null, error: 'failure' }), 'null status'],
  [message({ status: '', error: 'failure' }), 'empty status'],
  [message({ error: 'orphan error' }), 'error without status'],
  [message({ role: 'user', status: 'failed', error: 'failure' }), 'user with generation state'],
]
for (const [invalid, label] of invalidStates) {
  rejects(backup(1, invalid), 'root rejects ' + label)
  rejects(backup(4, { id: 'message-1', role: 'assistant', content: 'root', images: [], createdAt: 1, updatedAt: 1 }, { ...invalid, id: 'branch-message-1' }), 'branch rejects ' + label)
}

accepts(backup(4, { id: 'message-1', role: 'assistant', content: 'root', images: [], createdAt: 1, updatedAt: 1 }, message({ id: 'branch-failed', content: '', status: 'failed', error: 'failure' })), 'branch failed assistant with empty content is accepted')
accepts(backup(4, { id: 'message-1', role: 'assistant', content: 'root', images: [], createdAt: 1, updatedAt: 1 }, message({ id: 'branch-aborted', content: 'partial', status: 'aborted', error: '已停止生成' })), 'branch aborted assistant with partial content is accepted')
const whitespaceErrorBackup = backup(1, message({ status: 'failed', error: '  preserve surrounding whitespace  ' }))
const whitespaceErrorParsed = parseAndValidate(whitespaceErrorBackup) as any
assert(whitespaceErrorParsed.conversations[0].messages[0].error === '  preserve surrounding whitespace  ', 'error trim is only a predicate and does not rewrite persisted text')

await idbClearAll()
await saveConversation({ id: 'existing', title: 'keep me', createdAt: 1, updatedAt: 1, messages: [{ id: 'existing-message', role: 'user', content: 'durable', images: [], createdAt: 1, updatedAt: 1 }] })
const invalidBackup = backup(1, message({ status: 'failed', error: {} }))
let restoreRejected = false
try { await restoreBackup(invalidBackup as any) } catch (error) { restoreRejected = error instanceof BackupError }
const existingAfter = await getConversation('existing')
assert(restoreRejected, 'invalid generation state rejects before restore')
assert(existingAfter?.title === 'keep me' && existingAfter.messages[0]?.content === 'durable', 'invalid import leaves existing IndexedDB data untouched')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
