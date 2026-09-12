// v2.2.0 Stage 8 gate: Backup V7 round-trips study cards, V1-V6 still import, and a bad
// package is rejected before anything durable changes.
import 'fake-indexeddb/auto'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { saveConversation, getConversation, setSetting, getSetting } from '../src/storage/storage.ts'
import { idbClearAll, closeDb, idbGetAll } from '../src/storage/idb.ts'
import {
  createStudyCardFromAssistantMessage, listStudyCards, listStudyCardPageRefs, getStudyCardBySourceMessage,
} from '../src/study-cards/study-card-service.ts'
import { STUDY_CARD_PREFERENCES_KEY } from '../src/study-cards/learning-ui-store.ts'
import { BUILTIN_PROMPT_IDS } from '../src/prompts/prompt-registry.ts'
import { DEFAULT_PROMPT_PREFERENCES } from '../src/prompts/prompt-preferences.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}
function message(id: string, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1, ...extra }
}
const unique = (prefix: string) => prefix + '-' + newStableId()

async function seedCards(): Promise<{ conversationId: string; cardIds: string[] }> {
  const conversationId = unique('conv')
  const conversation: Conversation = {
    id: conversationId, title: '备份会话', createdAt: 1, updatedAt: 1,
    messages: [
      message('bk-u1', 'user', '看这几页', { pdfContexts: [{ documentId: 'doc-bk', pageNumbers: [2, 3], createdAt: 1 }] }),
      message('bk-a1', 'assistant', '# 第一张\n\n正文一。'),
      message('bk-u2', 'user', '继续'),
      message('bk-a2', 'assistant', '## 第二张\n\n正文二。'),
    ],
  }
  await saveConversation(conversation)
  const first = await createStudyCardFromAssistantMessage({ conversationId, assistantMessageId: 'bk-a1' })
  const second = await createStudyCardFromAssistantMessage({ conversationId, assistantMessageId: 'bk-a2' })
  const cardIds = [first, second].map(result => result.kind === 'created' || result.kind === 'existing' ? result.card.id : '')
  return { conversationId, cardIds }
}

await idbClearAll()
const seeded = await seedCards()
assert((await listStudyCards()).length === 2, 'two cards are seeded')

// ---- 1. export carries every validated card and nothing derived ----
const backup = await buildBackup()
assert(backup.version === 7, 'the exported package is version 7 (got ' + backup.version + ')')
assert(backup.studyCards.length === 2, 'the export carries both cards')
assert(backup.studyCards.every(card => card.schemaVersion === 1 && card.bodyMarkdown.length > 0), 'exported cards are validated records')
assert(!('studyCardPageRefs' in backup), 'the derived page index is never exported')
assert(backup.settings && !('apiKey' in (backup.settings as object)), 'the API key is never exported')
assert(backup.studyCards.every(card => !JSON.stringify(card).includes('base64')), 'cards never carry binaries')

// Preferences round-trip separately from the cards themselves.
await setSetting(STUDY_CARD_PREFERENCES_KEY, { sort: 'last-opened-desc', documentFilter: { kind: 'document', documentId: 'doc-bk' } })
const backupWithPrefs = await buildBackup()
assert(!!backupWithPrefs.studyCardPreferences, 'the exported package carries the card list preference')

// ---- 2. V7 round-trip ----
await idbClearAll()
assert((await listStudyCards()).length === 0, 'clearing local data removes every card')
await restoreBackup(backupWithPrefs)
const restored = await listStudyCards()
assert(restored.length === 2, 'importing a V7 package restores both cards')
assert(restored.map(card => card.title).sort().join('|') === '备份会话-1|备份会话-2', 'restored cards keep their titles and ordinals')
const restoredFirst = restored.find(card => card.source.assistantMessageId === 'bk-a1')
assert(!!restoredFirst && restoredFirst.bodyMarkdown === '# 第一张\n\n正文一。', 'a restored card keeps its exact body')
assert((await getStudyCardBySourceMessage('bk-a1'))?.id === restoredFirst?.id, 'the unique source-message index is restored')
const refs = await listStudyCardPageRefs('doc-bk')
const expectedRefKeys = new Set(restored.flatMap(card => card.documentRefs.filter(ref => ref.documentId === 'doc-bk').flatMap(ref => ref.pageNumbers.map(page => page + ':' + card.id))))
const actualRefKeys = new Set(refs.map(ref => ref.pageNumber + ':' + ref.cardId))
assert(refs.length === actualRefKeys.size && actualRefKeys.size === expectedRefKeys.size && [...expectedRefKeys].every(key => actualRefKeys.has(key)), 'the derived page index is rebuilt from the imported cards (got ' + refs.length + ' rows)')
const preferences = await getSetting(STUDY_CARD_PREFERENCES_KEY)
assert(preferences?.sort === 'last-opened-desc', 'the card list preference is restored')

// ---- 3. a package with a bad card is rejected and changes nothing ----
{
  const before = await listStudyCards()
  const broken = { ...backupWithPrefs, studyCards: [{ ...backupWithPrefs.studyCards[0], documentRefs: [{ fileNameSnapshot: 'a.pdf', pageNumbers: [0], relation: 'turn' }], documentIds: [] }] }
  let rejected = false
  try { await restoreBackup(structuredClone(broken)) } catch { rejected = true }
  assert(rejected, 'a card with an illegal page number is rejected')
  assert((await listStudyCards()).length === before.length, 'a rejected package leaves the local cards untouched')
  assert((await getConversation(seeded.conversationId)) !== undefined, 'a rejected package leaves conversations untouched')
}

// ---- 4. duplicate ids and duplicate source messages reject the whole package ----
{
  const duplicatedId = { ...backupWithPrefs, studyCards: [backupWithPrefs.studyCards[0], { ...backupWithPrefs.studyCards[1], id: backupWithPrefs.studyCards[0].id }] }
  let rejectedId = false
  try { parseAndValidate(structuredClone(duplicatedId)) } catch { rejectedId = true }
  assert(rejectedId, 'a duplicated card id rejects the package')

  const duplicatedSource = { ...backupWithPrefs, studyCards: [backupWithPrefs.studyCards[0], { ...backupWithPrefs.studyCards[1], source: { ...backupWithPrefs.studyCards[1].source, assistantMessageId: backupWithPrefs.studyCards[0].source.assistantMessageId } }] }
  let rejectedSource = false
  try { parseAndValidate(structuredClone(duplicatedSource)) } catch { rejectedSource = true }
  assert(rejectedSource, 'two cards pointing at the same AI reply reject the package')

  const overlong = { ...backupWithPrefs, studyCards: [{ ...backupWithPrefs.studyCards[0], bodyMarkdown: 'x'.repeat(200001) }] }
  let rejectedLong = false
  try { parseAndValidate(structuredClone(overlong)) } catch { rejectedLong = true }
  assert(rejectedLong, 'an over-long card body rejects the package')

  const notArray = { ...backupWithPrefs, studyCards: 'nope' }
  let rejectedShape = false
  try { parseAndValidate(structuredClone(notArray)) } catch { rejectedShape = true }
  assert(rejectedShape, 'a v7 package without a studyCards array is rejected')
}

// ---- 5. a detached card (source conversation missing) imports fine ----
{
  const detached = { ...backupWithPrefs, conversations: [], studyCards: [backupWithPrefs.studyCards[0]] }
  await idbClearAll()
  await restoreBackup(structuredClone(detached))
  const cards = await listStudyCards()
  assert(cards.length === 1, 'a detached card is imported and kept')
  assert(cards[0].source.conversationId === backupWithPrefs.studyCards[0].source.conversationId, 'the detached card keeps its source snapshot')
}

// ---- 6. V1-V6 packages import with studyCards = [] ----
{
  const v6 = { ...structuredClone(backupWithPrefs), version: 6 }
  delete v6.studyCards
  delete v6.studyCardPreferences
  await idbClearAll()
  await restoreBackup(v6)
  assert((await listStudyCards()).length === 0, 'a V6 package imports with no cards')
  assert((await idbGetAll('studyCardPageRefs')).length === 0, 'a V6 package leaves no derived page rows behind')
  const preferencesAfterLegacy = await getSetting(STUDY_CARD_PREFERENCES_KEY)
  assert(preferencesAfterLegacy === undefined || preferencesAfterLegacy?.sort === undefined, 'a legacy package resets the card list preference instead of inheriting it')
  assert((await getConversation(seeded.conversationId)) !== undefined, 'the legacy import still restores conversations')
  assert(!!DEFAULT_PROMPT_PREFERENCES && BUILTIN_PROMPT_IDS.conversationDefault.length > 0, 'prompt defaults remain available after a legacy import')
}

// ---- 7. re-importing a V7 package replaces the local card set, not merges it ----
{
  await restoreBackup(structuredClone(backupWithPrefs))
  assert((await listStudyCards()).length === 2, 're-importing restores the package cards')
  const onlyOne = { ...structuredClone(backupWithPrefs), studyCards: [backupWithPrefs.studyCards[0]] }
  await restoreBackup(onlyOne)
  assert((await listStudyCards()).length === 1, 'a package with one card replaces the previous two')
  assert((await listStudyCardPageRefs('doc-bk')).length === 2, 'the derived page rows match the replaced card set')
}

console.log(`RESULT pass=${pass} fail=${fail}`)
await closeDb()
if (fail > 0) process.exitCode = 1
