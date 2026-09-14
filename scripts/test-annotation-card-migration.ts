import 'fake-indexeddb/auto'
import { makeAnnotation } from '../src/annotations/annotation-ops.ts'
import { migrateAnnotationsToStudyCards } from '../src/annotations/annotation-migration.ts'
import { toggleTextSelection } from '../src/annotations/annotation-service.ts'
import { createStudyCardFromAssistantMessage, getStudyCardBySourceMessage } from '../src/study-cards/study-card-service.ts'
import { getAnnotationsByMessage, saveAnnotation, saveConversation } from '../src/storage/storage.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import { newStableId, type Conversation, type Message } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(value: boolean, label: string) { if (value) { pass++; console.log('  ok: ' + label) } else { fail++; console.log('  FAIL: ' + label) } }
function message(id: string, role: 'user' | 'assistant', content: string): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function conversation(id: string, title: string, userId: string, assistantId: string): Conversation { return { id, title, createdAt: 1, updatedAt: 1, messages: [message(userId, 'user', '问题'), message(assistantId, 'assistant', 'ABCDEFG')] } }

await idbClearAll()
const c1 = newStableId(), u1 = newStableId(), a1 = newStableId()
const c2 = newStableId(), u2 = newStableId(), a2 = newStableId()
await saveConversation(conversation(c1, '仅标记', u1, a1))
await saveConversation(conversation(c2, '已有卡片', u2, a2))
const saved = await createStudyCardFromAssistantMessage({ conversationId: c2, assistantMessageId: a2 })
assert(saved.kind === 'created', 'fixture creates an explicit study card')
const mark1 = makeAnnotation(c1, a1, { scope: 'block', blockId: 'p-0' }, 'ABCDEFG', 0, 3)
const mark2 = makeAnnotation(c2, a2, { scope: 'block', blockId: 'p-0' }, 'ABCDEFG', 3, 6)
const missingConversation = newStableId(), missingMessage = newStableId()
const deferred = makeAnnotation(missingConversation, missingMessage, { scope: 'block', blockId: 'p-0' }, 'ABCDEFG', 0, 1)
await saveAnnotation(mark1); await saveAnnotation(mark2); await saveAnnotation(deferred)

const result = await migrateAnnotationsToStudyCards()
const markedCard = await getStudyCardBySourceMessage(a1)
const existingCard = await getStudyCardBySourceMessage(a2)
assert(result.migrated === 2 && result.deferred === 1, 'migration reports committed and deferred legacy rows')
assert(markedCard?.collectionMode === 'marked' && markedCard.annotations?.[0]?.id === mark1.id, 'annotation-only source becomes a marked study card')
assert(existingCard?.id === (saved.kind === 'created' ? saved.card.id : '') && existingCard?.collectionMode === 'saved', 'existing card is enriched without duplication or demotion')
assert(existingCard?.annotations?.[0]?.id === mark2.id, 'existing card receives the legacy mark')
assert((await getAnnotationsByMessage(c1, a1)).length === 0 && (await getAnnotationsByMessage(c2, a2)).length === 0, 'committed legacy rows are removed')
assert((await getAnnotationsByMessage(missingConversation, missingMessage)).length === 1, 'unresolved legacy row is preserved for a later retry')
const second = await migrateAnnotationsToStudyCards()
assert(second.migrated === 0 && second.deferred === 1, 'migration is idempotent and does not get stuck on deferred data')

const segment = (messageId: string, start: number, end: number) => ({ messageId, blockId: 'p-0', start, end, exact: 'ABCDEFG'.slice(start, end), prefix: '', suffix: '' })
await toggleTextSelection(c1, a1, [segment(a1, 3, 7)], () => 'ABCDEFG')
assert((await getStudyCardBySourceMessage(a1))?.annotations?.[0]?.target.type === 'text', 'new mark edits write directly to the card record')
await toggleTextSelection(c1, a1, [segment(a1, 0, 7)], () => 'ABCDEFG')
assert((await getStudyCardBySourceMessage(a1)) === undefined, 'removing the last mark removes a mark-only card')
await toggleTextSelection(c2, a2, [segment(a2, 3, 6)], () => 'ABCDEFG')
assert(!!(await getStudyCardBySourceMessage(a2)) && (await getStudyCardBySourceMessage(a2))?.annotations?.length === 0, 'removing the last mark keeps an explicitly saved card')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
