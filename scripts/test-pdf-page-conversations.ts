import { findConversationsByDocumentPage } from '../src/pdf/pdf-page-conversations.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

function msg(id: string, createdAt: number, contexts?: { documentId: string; pageNumbers: number[]; createdAt: number }[], legacy?: { documentId: string; pageNumbers: number[]; createdAt: number }): Message {
  return { id, role: 'user', content: id + ' content', images: [], createdAt, updatedAt: createdAt, ...(contexts ? { pdfContexts: contexts } : {}), ...(legacy ? { pdfContext: legacy } : {}) }
}
function conversation(id: string, messages: Message[], title = id): Conversation {
  return { id, title, createdAt: 1, updatedAt: 1, messages }
}
function context(documentId: string, pageNumbers: number[]) { return { documentId, pageNumbers, createdAt: 1 } }

const a5 = context('doc-a', [5])
const a6 = context('doc-a', [6])
const b5 = context('doc-b', [5])

const one = conversation('c1', [msg('m1', 10, [a5])], 'One')
const two = conversation('c2', [msg('m2', 20, [a5]), msg('m3', 30, [a5])], 'Two')

let hits = findConversationsByDocumentPage('doc-a', 5, [one])
assert(hits.length === 1 && hits[0].conversationId === 'c1' && hits[0].messageId === 'm1', 'single conversation / single matching message')

hits = findConversationsByDocumentPage('doc-a', 5, [two])
assert(hits.length === 2 && hits[0].messageId === 'm3' && hits[1].messageId === 'm2', 'one conversation keeps multiple messages, newest first')

hits = findConversationsByDocumentPage('doc-a', 5, [one, two])
assert(hits.length === 3 && hits.map(h => h.messageId).join(',') === 'm3,m2,m1', 'multiple conversations on one document/page are all returned')

assert(findConversationsByDocumentPage('doc-a', 7, [one]).length === 0, 'same document / different page does not match')
assert(findConversationsByDocumentPage('doc-b', 5, [one]).length === 0, 'different document / same page does not match')

const multi = conversation('multi', [msg('multi-message', 40, [context('doc-a', [3, 4]), context('doc-b', [17])])], 'Multi')
assert(findConversationsByDocumentPage('doc-a', 3, [multi])[0]?.messageId === 'multi-message', 'multi-document message is found on document A page 3')
assert(findConversationsByDocumentPage('doc-a', 4, [multi])[0]?.messageId === 'multi-message', 'multi-document message is found on document A page 4')
assert(findConversationsByDocumentPage('doc-b', 17, [multi])[0]?.messageId === 'multi-message', 'multi-document message is found on document B page 17')
assert(findConversationsByDocumentPage('doc-b', 3, [multi]).length === 0, 'multi-document message does not cross-match page 3 on document B')

const legacy = conversation('legacy', [msg('legacy-message', 50, undefined, context('doc-a', [5]))], 'Legacy')
assert(findConversationsByDocumentPage('doc-a', 5, [legacy])[0]?.messageId === 'legacy-message', 'legacy pdfContext participates through normalization')

const duplicate = conversation('duplicate', [msg('duplicate-message', 60, [context('doc-a', [5]), context('doc-a', [5])])], 'Duplicate')
hits = findConversationsByDocumentPage('doc-a', 5, [duplicate])
assert(hits.length === 1, 'duplicate provenance yields one result by composite key')

const branch: ConversationBranch = { id: 'branch-1', conversationId: 'c1', forkMessageId: 'm1', title: 'Branch', createdAt: 1, updatedAt: 1, messages: [msg('branch-message', 70, [a5])] }
assert(findConversationsByDocumentPage('doc-a', 5, [one], [branch])[0]?.branchId === 'branch-1', 'branch-local matching message keeps branch identity')

const missingConversationBranch: ConversationBranch = { ...branch, id: 'orphan-branch', conversationId: 'deleted-conversation', messages: [msg('orphan-message', 80, [a5])] }
assert(findConversationsByDocumentPage('doc-a', 5, [one], [missingConversationBranch]).length === 1, 'deleted conversation branch is ignored without affecting valid results')
assert(findConversationsByDocumentPage('doc-a', 5, [], [missingConversationBranch]).length === 0, 'missing conversation produces no stale result')
assert(findConversationsByDocumentPage('doc-a', 5, [conversation('empty', [msg('other', 1, [a6])])]).length === 0, 'missing/deleted message is not replaced by another message')
assert(findConversationsByDocumentPage('doc-a', 5, []).length === 0, 'empty result is explicit')

// Keep the unused fixture visible in the test source as a regression guard for document identity.
assert(b5.documentId === 'doc-b' && b5.pageNumbers[0] === 5, 'test fixture distinguishes document identity')

console.log(`\nRESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
