import 'fake-indexeddb/auto'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { getConversation } from '../src/storage/storage.ts'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const legacyContext = { documentId: 'doc-legacy', pageNumbers: [3, 4], createdAt: 10 }
const canonicalContexts = [
  { documentId: 'doc-a', pageNumbers: [3, 4], createdAt: 11 },
  { documentId: 'doc-b', pageNumbers: [17], createdAt: 11 },
]

function backup(version: 1 | 2 | 3 | 4 | 5, message: Record<string, unknown>) {
  const base = {
    format: 'ai-education-reader-backup' as const,
    version,
    exportedAt: 1,
    settings: {},
    conversations: [{ id: 'c1', title: 'provenance', createdAt: 1, updatedAt: 1, messages: [message] }],
    annotations: [],
    attachments: [],
  }
  if (version === 1) return base
  const withDocuments = { ...base, documents: [] }
  if (version === 2) return withDocuments
  const withV3 = { ...withDocuments, drafts: [], appearance: 'system' as const }
  if (version === 3) return withV3
  const withV4 = { ...withV3, branches: [], branchDrafts: [], artifacts: [], activeBranches: [] }
  if (version === 4) return withV4
  return { ...withV4, documentNotes: [] }
}

async function restoreAndRead(input: any) {
  const parsed = parseAndValidate(input)
  await idbClearAll()
  await restoreBackup(parsed)
  return await getConversation('c1')
}

for (const version of [1, 2, 3, 4] as const) {
  const conversation = await restoreAndRead(backup(version, {
    id: 'm-' + version, role: 'user', content: 'legacy', images: [], createdAt: 1, updatedAt: 1, pdfContext: legacyContext,
  }))
  const message = conversation?.messages[0]
  assert(message?.pdfContexts?.length === 1 && message.pdfContexts[0].documentId === 'doc-legacy' && !('pdfContext' in message), `V${version} legacy pdfContext restores canonically`)
}

const v5Conversation = await restoreAndRead(backup(5, {
  id: 'm-5', role: 'user', content: 'canonical', images: [], createdAt: 1, updatedAt: 1, pdfContexts: canonicalContexts,
}))
const v5Message = v5Conversation?.messages[0]
assert(v5Message?.pdfContexts?.length === 2 && v5Message.pdfContexts[1].documentId === 'doc-b' && !('pdfContext' in v5Message), 'V5 canonical pdfContexts round-trip preserves all documents')

await closeDb()
console.log(`\nRESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
