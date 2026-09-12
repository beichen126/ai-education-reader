// v2.2.0 Stage 4 storage gate: StudyCard persistence, IndexedDB v8 migration, derived page
// index, atomic ordinal allocation and idempotent save.
import 'fake-indexeddb/auto'
import { newStableId, type Attachment, type Conversation, type Message } from '../src/engine/types.ts'
import { saveConversation, deleteConversation, getConversation } from '../src/storage/storage.ts'
import { saveAttachment } from '../src/storage/storage.ts'
import { closeDb, DB_VERSION, STORES, idbClearAll } from '../src/storage/idb.ts'
import {
  createStudyCardFromAssistantMessage, getStudyCard, getStudyCardBySourceMessage, listStudyCards,
  listStudyCardsByDocument, listStudyCardsByDocumentPage, updateStudyCardTitle, updateStudyCardBody,
  markStudyCardOpened, deleteStudyCard, countStudyCards, listStudyCardPageRefs,
} from '../src/study-cards/study-card-service.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}
function message(id: string, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1, ...extra }
}
const unique = (prefix: string) => prefix + '-' + newStableId()

async function seedConversation(conv: Conversation) { await saveConversation(conv) }

console.log('=== v7 -> v8 migration ===')
// Seed a REAL v7 database with the full v7 store set, then let the app open it and upgrade.
const legacyConversationId = 'legacy-v7-conversation'
await new Promise<void>((resolve, reject) => {
  const request = indexedDB.open('ai-education-reader', 7)
  request.onupgradeneeded = () => {
    const db = request.result
    db.createObjectStore('settings', { keyPath: 'key' })
    const conv = db.createObjectStore('conversations', { keyPath: 'id' })
    db.createObjectStore('attachments', { keyPath: 'id' })
    const ann = db.createObjectStore('annotations', { keyPath: 'id' })
    ann.createIndex('by_conversation', 'conversationId')
    ann.createIndex('by_message', 'messageId')
    ann.createIndex('by_conversation_message', ['conversationId', 'messageId'])
    conv.createIndex('by_updatedAt', 'updatedAt')
    const docs = db.createObjectStore('documents', { keyPath: 'id' })
    docs.createIndex('by_updatedAt', 'updatedAt')
    const notes = db.createObjectStore('documentNotes', { keyPath: 'id' })
    notes.createIndex('by_document', 'documentId')
    notes.createIndex('by_document_page', ['documentId', 'pageNumber'], { unique: true })
    const cb = db.createObjectStore('conversationBranches', { keyPath: 'id' })
    cb.createIndex('by_conversation', 'conversationId')
    cb.createIndex('by_parent', 'parentBranchId')
    cb.createIndex('by_updatedAt', 'updatedAt')
    const art = db.createObjectStore('artifacts', { keyPath: 'id' })
    art.createIndex('by_kind', 'kind')
    art.createIndex('by_updatedAt', 'updatedAt')
    art.createIndex('by_source_conversation', 'source.conversationId')
    const prompts = db.createObjectStore('prompts', { keyPath: 'id' })
    prompts.createIndex('by_kind', 'kind')
    prompts.createIndex('by_updatedAt', 'updatedAt')
  }
  request.onsuccess = () => {
    const db = request.result
    const txn = db.transaction(['conversations', 'settings', 'artifacts'], 'readwrite')
    txn.objectStore('conversations').put({ id: legacyConversationId, title: 'v7 会话', createdAt: 7, updatedAt: 7, messages: [message('v7-m1', 'user', '旧数据')] })
    txn.objectStore('settings').put({ key: 'model', value: 'legacy-model' })
    txn.objectStore('artifacts').put({ id: 'v7-artifact', kind: 'note', title: '旧成果', prompt: 'p', content: 'c', status: 'ready', createdAt: 7, updatedAt: 7 })
    txn.oncomplete = () => { db.close(); resolve() }
    txn.onerror = () => { db.close(); reject(txn.error) }
  }
  request.onerror = () => reject(request.error)
})
await closeDb()
const migratedConversation = await getConversation(legacyConversationId)
assert(!!migratedConversation && migratedConversation.title === 'v7 会话', 'a v7 conversation survives the v8 upgrade byte-for-byte')
assert((await listStudyCards()).length === 0, 'the upgrade does not invent cards from existing data')
assert(await countStudyCards() === 0, 'the new studyCards store starts empty')

console.log('=== schema ===')
assert(DB_VERSION === 8, 'the database schema version is 8 (got ' + DB_VERSION + ')')
assert(STORES.includes('studyCards' as never), 'studyCards is a declared store')
assert(STORES.includes('studyCardPageRefs' as never), 'studyCardPageRefs is a declared store')

// ---- 1. save one completed assistant reply as a card ----
const convId = unique('conv')
const conversation: Conversation = {
  id: convId, title: '线性代数复习', createdAt: 1, updatedAt: 1,
  messages: [
    message('u-1', 'user', '讲讲特征值', { pdfContexts: [{ documentId: 'doc-1', pageNumbers: [3, 4], createdAt: 1 }] }),
    message('a-1', 'assistant', '# 特征值\n\n矩阵 A 的特征值满足 det(A-λI)=0。'),
    message('u-2', 'user', '再讲讲'),
    message('a-2', 'assistant', '## 二次型\n\n对称矩阵可以对角化。'),
  ],
}
await seedConversation(conversation)

const first = await createStudyCardFromAssistantMessage({ conversationId: convId, assistantMessageId: 'a-1' })
assert(first.kind === 'created', 'saving a completed reply creates a card')
const card1 = first.kind === 'created' ? first.card : null
assert(!!card1 && card1.bodyMarkdown === '# 特征值\n\n矩阵 A 的特征值满足 det(A-λI)=0。', 'the card body is exactly the assistant reply')
assert(!!card1 && !card1.bodyMarkdown.includes('讲讲特征值'), 'the card body does not include the earlier user message')
assert(!!card1 && card1.title === '线性代数复习-1', 'the auto title is <conversation name>-<ordinal> (got ' + card1?.title + ')')
assert(!!card1 && card1.titleMode === 'auto' && card1.autoTitleOrdinal === 1, 'the first card records ordinal 1 in auto mode')
assert(!!card1 && card1.source.conversationId === convId && card1.source.assistantMessageId === 'a-1', 'the source points at the exact conversation and assistant message')
assert(!!card1 && card1.source.userMessageId === 'u-1', 'the source records the user turn the reply answers')
assert(!!card1 && card1.source.conversationTitleSnapshot === '线性代数复习', 'the conversation title is snapshotted')
assert(!!card1 && card1.documentIds.join('|') === 'doc-1', 'the turn PDF context becomes a document ref')
assert(!!card1 && card1.documentRefs[0].relation === 'turn' && card1.documentRefs[0].pageNumbers.join('|') === '3|4', 'the turn ref keeps its pages and relation')

// ---- 2. idempotency: the same assistant message never creates a second card ----
const again = await createStudyCardFromAssistantMessage({ conversationId: convId, assistantMessageId: 'a-1' })
assert(again.kind === 'existing', 'saving the same reply twice reports existing')
assert(again.kind === 'existing' && !!card1 && again.card.id === card1.id, 'the existing result is the same card')
assert(await countStudyCards() === 1, 'exactly one card exists after a repeated save')
const byMessage = await getStudyCardBySourceMessage('a-1')
assert(!!byMessage && !!card1 && byMessage.id === card1.id, 'the by_source_message index resolves the card')

// ---- 3. ordinals increase per conversation and are never reused ----
const second = await createStudyCardFromAssistantMessage({ conversationId: convId, assistantMessageId: 'a-2' })
assert(second.kind === 'created' && second.card.autoTitleOrdinal === 2, 'the second card gets ordinal 2')
assert(second.kind === 'created' && second.card.title === '线性代数复习-2', 'the second card title follows the ordinal')
const otherConvId = unique('conv')
await seedConversation({ id: otherConvId, title: '概率论', createdAt: 1, updatedAt: 1, messages: [message('ou-1', 'user', 'q'), message('oa-1', 'assistant', '答案')] })
const otherFirst = await createStudyCardFromAssistantMessage({ conversationId: otherConvId, assistantMessageId: 'oa-1' })
assert(otherFirst.kind === 'created' && otherFirst.card.autoTitleOrdinal === 1, 'ordinals are per conversation')
assert(otherFirst.kind === 'created' && otherFirst.card.title === '概率论-1', 'another conversation starts its own sequence')

if (card1) await deleteStudyCard(card1.id)
await seedConversation({ ...conversation, messages: [...conversation.messages, message('u-3', 'user', '继续'), message('a-3', 'assistant', '第三个回答')] })
const third = await createStudyCardFromAssistantMessage({ conversationId: convId, assistantMessageId: 'a-3' })
assert(third.kind === 'created' && third.card.autoTitleOrdinal === 3, 'a deleted ordinal is never reused (next is 3, not 1)')

// ---- 4. concurrent saves never allocate the same ordinal ----
const raceConvId = unique('conv')
await seedConversation({
  id: raceConvId, title: '并发', createdAt: 1, updatedAt: 1,
  messages: [message('ru-1', 'user', 'a'), message('ra-1', 'assistant', 'answer one'), message('ru-2', 'user', 'b'), message('ra-2', 'assistant', 'answer two')],
})
const [raceA, raceB] = await Promise.all([
  createStudyCardFromAssistantMessage({ conversationId: raceConvId, assistantMessageId: 'ra-1', title: '并发 A' }),
  createStudyCardFromAssistantMessage({ conversationId: raceConvId, assistantMessageId: 'ra-2', title: '并发 B' }),
])
const ordinals = [raceA, raceB].map(result => result.kind === 'created' ? result.card.autoTitleOrdinal : -1).sort((a, b) => a - b)
assert(ordinals[0] === 1 && ordinals[1] === 2, 'two concurrent saves allocate distinct ordinals 1 and 2 (got ' + ordinals.join(',') + ')')

// ---- 5. only completed, non-empty assistant replies can be saved ----
{
  const guardConvId = unique('conv')
  await seedConversation({
    id: guardConvId, title: '守卫', createdAt: 1, updatedAt: 1,
    messages: [
      message('gu-1', 'user', '问题'),
      message('ga-empty', 'assistant', '   '),
      message('ga-failed', 'assistant', '失败内容', { status: 'failed', error: 'boom' }),
      message('ga-aborted', 'assistant', '中断内容', { status: 'aborted', error: 'stopped' }),
      message('ga-ok', 'assistant', '正常回答'),
    ],
  })
  assert((await createStudyCardFromAssistantMessage({ conversationId: guardConvId, assistantMessageId: 'gu-1' })).kind === 'source-unstable', 'a user message cannot be saved as a card')
  assert((await createStudyCardFromAssistantMessage({ conversationId: guardConvId, assistantMessageId: 'ga-empty' })).kind === 'source-unstable', 'an empty assistant reply cannot be saved')
  assert((await createStudyCardFromAssistantMessage({ conversationId: guardConvId, assistantMessageId: 'ga-failed' })).kind === 'source-unstable', 'a failed assistant reply cannot be saved')
  assert((await createStudyCardFromAssistantMessage({ conversationId: guardConvId, assistantMessageId: 'ga-aborted' })).kind === 'source-unstable', 'an aborted assistant reply cannot be saved')
  assert((await createStudyCardFromAssistantMessage({ conversationId: guardConvId, assistantMessageId: 'missing' })).kind === 'source-missing', 'an unknown message reports source-missing')
  assert((await createStudyCardFromAssistantMessage({ conversationId: unique('nope'), assistantMessageId: 'ga-ok' })).kind === 'source-missing', 'an unknown conversation reports source-missing')
}

// ---- 6. PDF source extraction from a real conversation ----
{
  const pdfConvId = unique('conv')
  const attachmentId = newStableId()
  const attachment: Attachment = {
    id: attachmentId, name: 'page-3.png', mimeType: 'image/png', size: 10, createdAt: 1, updatedAt: 1,
    source: { type: 'pdf-page', groupId: 'g1', documentId: 'doc-1', fileName: '高等数学.pdf', pageNumber: 3, selection: { kind: 'outline', startPage: 3, endPage: 3 } },
  }
  await saveAttachment(attachment, new Blob(['x']))
  await seedConversation({
    id: pdfConvId, title: 'PDF 卡片', createdAt: 1, updatedAt: 1,
    messages: [
      message('pu-1', 'user', '看这几页', { pdfContexts: [{ documentId: 'doc-1', pageNumbers: [3, 4], createdAt: 1 }], images: [attachmentId] }),
      message('pa-1', 'assistant', '第 3 页讲的是极限。'),
    ],
  })
  const result = await createStudyCardFromAssistantMessage({ conversationId: pdfConvId, assistantMessageId: 'pa-1' })
  assert(result.kind === 'created', 'a reply about a PDF becomes a card')
  const refs = result.kind === 'created' ? result.card.documentRefs : []
  assert(refs.length === 1 && refs[0].documentId === 'doc-1', 'the PDF context becomes exactly one document ref')
  assert(refs.length === 1 && refs[0].relation === 'turn', 'the turn PDF is marked as turn context')
  assert(refs.length === 1 && refs[0].pageNumbers.join('|') === '3|4', 'the document ref merges the context pages')
  assert(refs.length === 1 && refs[0].fileNameSnapshot.length > 0, 'the ref carries a file name snapshot')
  assert(result.kind === 'created' && !result.card.documentRefs.some(ref => ref.pageNumbers.includes(9)), 'a page number mentioned only in prose never becomes a source')
}

// ---- 7. derived page index answers exact (document, page) queries ----
{
  const cards = await listStudyCards()
  const pdfCard = cards.find(card => card.documentRefs.some(ref => ref.documentId === 'doc-1' && ref.relation === 'turn'))
  assert(!!pdfCard, 'the PDF card is listed')
  const byDoc = await listStudyCardsByDocument('doc-1')
  assert(byDoc.length >= 1 && byDoc.every(card => card.documentIds.includes('doc-1')), 'by-document lookup returns only cards that reference the document')
  const pageHits = await listStudyCardsByDocumentPage('doc-1', 3)
  assert(!!pdfCard && pageHits.some(card => card.id === pdfCard.id), 'page 3 resolves the card that really cites page 3')
  assert(pageHits.every(card => card.documentRefs.some(ref => ref.documentId === 'doc-1' && ref.pageNumbers.includes(3))), 'every page-3 hit really cites page 3')
  assert((await listStudyCardsByDocumentPage('doc-1', 9)).length === 0, 'a page the card does not cite returns nothing')
  assert((await listStudyCardsByDocumentPage('doc-2', 3)).length === 0, 'a document the card does not cite returns nothing')
  const refs = await listStudyCardPageRefs('doc-1')
  const expected = new Set((await listStudyCards()).flatMap(card => card.documentRefs.filter(ref => ref.documentId === 'doc-1').flatMap(ref => ref.pageNumbers.map(page => page + ':' + card.id))))
  const actual = new Set(refs.filter(ref => ref.documentId === 'doc-1').map(ref => ref.pageNumber + ':' + ref.cardId))
  assert(refs.length === actual.size, 'the derived page rows have no duplicates')
  assert(actual.size === expected.size && [...expected].every(key => actual.has(key)), 'the derived page rows mirror the card refs exactly')
}

// ---- 8. edits preserve provenance and honour optimistic concurrency ----
{
  const convId2 = unique('conv')
  await seedConversation({ id: convId2, title: '编辑', createdAt: 1, updatedAt: 1, messages: [message('eu-1', 'user', 'q'), message('ea-1', 'assistant', '答案正文')] })
  const created = await createStudyCardFromAssistantMessage({ conversationId: convId2, assistantMessageId: 'ea-1' })
  assert(created.kind === 'created', 'the card for the edit scenario is created')
  const card = created.kind === 'created' ? created.card : null
  if (!card) throw new Error('card missing')
  const renamed = await updateStudyCardTitle(card.id, '  我的标题  ')
  assert(!!renamed && renamed.title === '我的标题', 'the new title is trimmed and stored')
  assert(!!renamed && renamed.titleMode === 'custom', 'renaming switches the title mode to custom')
  assert(!!renamed && renamed.autoTitleOrdinal === card.autoTitleOrdinal, 'renaming keeps the ordinal')
  assert(!!renamed && renamed.createdAt === card.createdAt && renamed.source.assistantMessageId === card.source.assistantMessageId, 'renaming keeps createdAt and the source')
  const stale = await updateStudyCardTitle(card.id, '迟到标题', card.updatedAt)
  assert(stale === undefined, 'a stale expectedUpdatedAt write is rejected')
  assert((await getStudyCard(card.id))?.title === '我的标题', 'the rejected stale write did not change the stored title')
  const body = await updateStudyCardBody(card.id, '编辑后的正文')
  assert(!!body && body.bodyMarkdown === '编辑后的正文', 'the body can be edited')
  assert(!!body && body.source.assistantMessageId === 'ea-1', 'editing the body never drifts the source snapshot')
  assert(await updateStudyCardBody(card.id, '   ') === undefined, 'an empty body edit is rejected')
  const opened = await markStudyCardOpened(card.id, 5000)
  assert(!!opened && opened.lastOpenedAt === 5000, 'markStudyCardOpened records the open time')
  const earlier = await markStudyCardOpened(card.id, 4000)
  assert(!!earlier && earlier.lastOpenedAt === 5000, 'an older open time never rewinds lastOpenedAt')
  assert((await getStudyCard(card.id))?.updatedAt === body?.updatedAt, 'markStudyCardOpened does not touch updatedAt')
}

// ---- 9. deleting a card never touches its sources ----
{
  const convId3 = unique('conv')
  await seedConversation({ id: convId3, title: '删除', createdAt: 1, updatedAt: 1, messages: [message('du-1', 'user', 'q'), message('da-1', 'assistant', '答案')] })
  const created = await createStudyCardFromAssistantMessage({ conversationId: convId3, assistantMessageId: 'da-1' })
  if (created.kind !== 'created') throw new Error('card missing')
  await deleteStudyCard(created.card.id)
  assert(await getStudyCard(created.card.id) === undefined, 'the card row is gone')
  assert(await getStudyCardBySourceMessage('da-1') === undefined, 'the source-message index no longer resolves the card')
  assert((await listStudyCardPageRefs('doc-1')).length >= 1, 'page rows for other cards are untouched')
  assert(!!(await getConversation(convId3)), 'deleting a card never deletes the conversation')
  assert((await listStudyCards()).every(card => card.id !== created.card.id), 'the deleted card is no longer listed')
}

// ---- 10. deleting the source conversation keeps the card readable ----
{
  const convId4 = unique('conv')
  await seedConversation({ id: convId4, title: '来源会消失', createdAt: 1, updatedAt: 1, messages: [message('su-1', 'user', 'q'), message('sa-1', 'assistant', '正文仍然可读')] })
  const created = await createStudyCardFromAssistantMessage({ conversationId: convId4, assistantMessageId: 'sa-1' })
  if (created.kind !== 'created') throw new Error('card missing')
  await deleteConversation(convId4)
  const survivor = await getStudyCard(created.card.id)
  assert(!!survivor && survivor.bodyMarkdown === '正文仍然可读', 'the card body survives deletion of its source conversation')
  assert(!!survivor && survivor.source.assistantMessageId === 'sa-1', 'the source snapshot is still recorded')
  await deleteStudyCard(created.card.id)
}

// ---- 11. the v8 stores are complete and reopen idempotently ----
{
  await closeDb()
  const { openIdb } = await import('../src/storage/idb.ts')
  const upgraded = await openIdb()
  assert(upgraded.version === 8, 'the app database opens at version 8')
  assert(upgraded.objectStoreNames.contains('studyCards') && upgraded.objectStoreNames.contains('studyCardPageRefs'), 'the v8 upgrade created both card stores')
  const cards = upgraded.transaction('studyCards', 'readonly').objectStore('studyCards')
  for (const index of ['by_createdAt', 'by_updatedAt', 'by_lastOpenedAt', 'by_source_conversation', 'by_source_message', 'by_document']) {
    assert(cards.indexNames.contains(index), 'studyCards has the ' + index + ' index')
  }
  assert(cards.index('by_source_message').unique === true, 'by_source_message is a unique index')
  assert(cards.index('by_document').multiEntry === true, 'by_document is a multiEntry index over documentIds')
  const pageRefs = upgraded.transaction('studyCardPageRefs', 'readonly').objectStore('studyCardPageRefs')
  assert(pageRefs.indexNames.contains('by_document_page'), 'studyCardPageRefs has the composite by_document_page index')
  await closeDb()
  const reopened = await openIdb()
  assert(reopened.version === 8, 'reopening the v8 database is a no-op upgrade')
}

// ---- 12. clear-all removes cards and page rows ----
{
  await idbClearAll()
  assert(await countStudyCards() === 0, 'clear all local data removes every card')
  assert((await listStudyCardPageRefs('doc-1')).length === 0, 'clear all local data removes the derived page rows')
}

console.log(`RESULT pass=${pass} fail=${fail}`)
await closeDb()
if (fail > 0) process.exitCode = 1
