import 'fake-indexeddb/auto'
import { idbClearAll, closeDb } from '../src/storage/idb.ts'
import { saveAttachment, getConversation } from '../src/storage/storage.ts'
import { saveSettings, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { sessionsActions } from '../src/engine/sessions-store.ts'
import { runBranchReply } from '../src/engine/branch-thread.ts'
import { createBranchFromMessage } from '../src/branches/branch-service.ts'
import { getBranch } from '../src/branches/branch-store.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function pdfMeta(id: string, documentId: string, pageNumber: number) { return { id, name: id + '.png', mimeType: 'image/png', size: 3, createdAt: 1, updatedAt: 1, source: { type: 'pdf-page', groupId: newStableId(), documentId, fileName: documentId + '.pdf', pageNumber, selection: { kind: 'manual', ranges: [{ startPage: pageNumber, endPage: pageNumber }] } } } }
function mockFetch(): void {
  globalThis.fetch = (async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any
}

await idbClearAll()
await saveSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-test' })
const a = newStableId(); const b = newStableId()
await saveAttachment(pdfMeta(a, 'doc-a', 3), new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
await saveAttachment(pdfMeta(b, 'doc-b', 17), new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }))

const conversationId = await sessionsActions.newChat()
mockFetch()
assert(await sessionsActions.sendUserMessage(conversationId, 'root with two PDFs', [a, b]), 'root send accepted')
const root = await getConversation(conversationId)
const rootContexts = root?.messages[0]?.pdfContexts || []
assert(rootContexts.length === 2 && rootContexts.some((x: any) => x.documentId === 'doc-a' && x.pageNumbers[0] === 3) && rootContexts.some((x: any) => x.documentId === 'doc-b' && x.pageNumbers[0] === 17), 'root send persists all PDF contexts canonically')

const branch = await createBranchFromMessage(conversationId, root.messages[0].id)
mockFetch()
assert(await runBranchReply(conversationId, branch.id, 'branch with PDF A', [a]), 'branch reply accepted')
const branchAfter = await getBranch(branch.id)
const branchMessage = branchAfter?.messages[0]
assert(!!branchMessage?.pdfContexts && branchMessage.pdfContexts.length === 1 && branchMessage.pdfContexts[0].documentId === 'doc-a' && branchMessage.pdfContexts[0].pageNumbers[0] === 3, 'branch reply uses the same canonical provenance derivation')

await new Promise(resolve => setTimeout(resolve, 20))
const reloaded = await getConversation(conversationId)
assert(reloaded?.messages[0]?.pdfContexts?.length === 2 && !('pdfContext' in reloaded.messages[0]), 'reload reads canonical root provenance')
delete (globalThis as any).fetch
await closeDb()
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
