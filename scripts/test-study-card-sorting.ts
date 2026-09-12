// v2.2.0 Stage 6 domain gate: card filtering, search and the six frozen sort orders.
import {
  buildStudyCardFilterOptions, matchesStudyCardFilter, matchesStudyCardQuery, sortStudyCards,
  shuffleWithSeed, studyCardPlainText, studyCardSearchText, createStudyCardSeed, STUDY_CARD_SORT_MODES,
  type StudyCardFilterKey,
} from '../src/study-cards/study-card-sorting.ts'
import type { StudyCard } from '../src/study-cards/study-card-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}

function card(id: string, overrides: Partial<StudyCard> = {}): StudyCard {
  return {
    schemaVersion: 1, id, title: '卡片 ' + id, titleMode: 'auto', autoTitleOrdinal: 1,
    bodyMarkdown: '正文 ' + id, source: { conversationId: 'conv-1', assistantMessageId: 'msg-' + id, conversationTitleSnapshot: '线性代数复习', capturedAt: 1 },
    documentRefs: [], documentIds: [], createdAt: 1000, updatedAt: 1000,
    ...overrides,
  }
}
const withDoc = (id: string, documentId: string, fileName: string, created: number, extra: Partial<StudyCard> = {}) =>
  card(id, {
    createdAt: created, updatedAt: created,
    documentRefs: [{ documentId, fileNameSnapshot: fileName, pageNumbers: [1], relation: 'turn' }],
    documentIds: [documentId],
    ...extra,
  })

// ---- 1. the six declared orders exist ----
assert(STUDY_CARD_SORT_MODES.map(mode => mode.id).join('|') === 'created-desc|created-asc|updated-desc|last-opened-desc|random', 'the five sort choices are declared in order')

// ---- 2. deterministic orders ----
{
  const a = card('a', { createdAt: 100, updatedAt: 300 })
  const b = card('b', { createdAt: 300, updatedAt: 100 })
  const c = card('c', { createdAt: 200, updatedAt: 200 })
  const cards = [a, b, c]
  assert(sortStudyCards(cards, 'created-desc', 1).map(x => x.id).join('') === 'bca', 'created-desc is newest first')
  assert(sortStudyCards(cards, 'created-asc', 1).map(x => x.id).join('') === 'acb', 'created-asc is oldest first')
  assert(sortStudyCards(cards, 'updated-desc', 1).map(x => x.id).join('') === 'acb', 'updated-desc is most recently modified first')
}

// ---- 3. never-opened cards sort after opened ones ----
{
  const opened = card('a', { createdAt: 999, lastOpenedAt: 500 })
  const never = card('b', { createdAt: 1000 })
  const older = card('c', { createdAt: 998, lastOpenedAt: 100 })
  const ordered = sortStudyCards([never, older, opened], 'last-opened-desc', 1).map(x => x.id).join('')
  assert(ordered === 'acb', 'last-opened-desc puts never-opened cards last (got ' + ordered + ')')
}

// ---- 4. equal keys fall back to a stable id tie-breaker ----
{
  const x = card('x', { createdAt: 5 })
  const y = card('y', { createdAt: 5 })
  assert(sortStudyCards([y, x], 'created-desc', 1).map(item => item.id).join('') === 'xy', 'equal timestamps break ties by stable id')
  assert(sortStudyCards([x, y], 'created-desc', 1).map(item => item.id).join('') === 'xy', 'the tie-breaker does not depend on input order')
}

// ---- 5. seeded random is stable and does not touch the input ----
{
  const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => card(id, { createdAt: Number(id.charCodeAt(0)) }))
  const first = sortStudyCards(cards, 'random', 42).map(item => item.id).join('')
  const again = sortStudyCards([...cards].reverse(), 'random', 42).map(item => item.id).join('')
  const other = sortStudyCards(cards, 'random', 43).map(item => item.id).join('')
  assert(first === again, 'the same seed and the same ids produce the same order regardless of input order')
  assert(first.length === 6 && new Set(first.split('')).size === 6, 'a random order contains every card exactly once')
  assert(first !== other, 'a different seed produces a different order')
  assert(cards.map(item => item.id).join('') === 'abcdef', 'sorting never mutates the caller array')
  const shuffled = shuffleWithSeed([1, 2, 3, 4, 5], 7)
  assert(shuffleWithSeed([1, 2, 3, 4, 5], 7).join('') === shuffled.join(''), 'shuffleWithSeed is deterministic for one seed')
  assert(typeof createStudyCardSeed() === 'number', 'a fresh random seed can be created')
}

// ---- 6. PDF filter options carry real counts ----
{
  const cards = [
    withDoc('a', 'doc-1', '高等数学.pdf', 1),
    withDoc('b', 'doc-1', '高等数学.pdf', 2),
    withDoc('c', 'doc-2', '已删除的讲义.pdf', 3),
    card('d'),
    card('e', { documentRefs: [{ fileNameSnapshot: '旧附件.pdf', pageNumbers: [2], relation: 'turn' }] }),
  ]
  const names = new Map<string, string>([['doc-1', '高等数学.pdf']])
  const options = buildStudyCardFilterOptions(cards, names)
  const asText = options.map(option => option.label + '=' + option.count).join(' | ')
  assert(options[0].key.kind === 'all' && options[0].count === 5, 'the first option is 全部来源 with every card (' + asText + ')')
  assert(options.some(option => option.key.kind === 'no-pdf' && option.count === 1), '无 PDF 来源 counts cards without any ref')
  assert(options.some(option => option.key.kind === 'document' && option.key.documentId === 'doc-1' && option.count === 2), 'a live document filter counts its cards')
  assert(options.some(option => option.key.kind === 'document' && option.key.documentId === 'doc-2' && option.count === 1 && option.documentMissing), 'a deleted document keeps a snapshot label and is marked missing')
  assert(options.some(option => option.key.kind === 'unlocated' && option.count === 1), 'refs without a documentId are only reachable as 无法定位的 PDF 来源')
  const deleted = options.find(option => option.key.kind === 'document' && option.key.documentId === 'doc-2')
  assert(!!deleted && deleted.label.includes('已删除的讲义.pdf'), 'the deleted document filter shows the file name snapshot')
}

// ---- 7. filters never mix same-named documents ----
{
  const live = withDoc('a', 'doc-1', '同名.pdf', 1)
  const other = withDoc('b', 'doc-9', '同名.pdf', 2)
  const unlocated = card('c', { documentRefs: [{ fileNameSnapshot: '同名.pdf', pageNumbers: [1], relation: 'turn' }] })
  const key: StudyCardFilterKey = { kind: 'document', documentId: 'doc-1' }
  assert(matchesStudyCardFilter(live, key), 'the document filter matches by stable id')
  assert(!matchesStudyCardFilter(other, key), 'a same-named different document is not merged into the filter')
  assert(!matchesStudyCardFilter(unlocated, key), 'an unlocated ref never matches a live document filter')
  assert(matchesStudyCardFilter(unlocated, { kind: 'unlocated' }), 'an unlocated ref matches 无法定位的 PDF 来源')
  assert(matchesStudyCardFilter(card('d'), { kind: 'no-pdf' }), 'a card without refs matches 无 PDF 来源')
  assert(matchesStudyCardFilter(live, { kind: 'all' }), '全部来源 matches everything')
}

// ---- 8. search covers title, body, conversation snapshot and file names ----
{
  const target = withDoc('a', 'doc-1', '高等数学.pdf', 1, {
    title: '特征值复习',
    bodyMarkdown: '# 特征值\n\n矩阵 A 满足 det(A-λI)=0。',
    source: { conversationId: 'conv-1', assistantMessageId: 'm1', conversationTitleSnapshot: '线性代数复习', capturedAt: 1 },
  })
  assert(matchesStudyCardQuery(target, '特征值'), 'search matches the title')
  assert(matchesStudyCardQuery(target, 'det(A-λI)'), 'search matches the markdown body')
  assert(matchesStudyCardQuery(target, '线性代数'), 'search matches the conversation title snapshot')
  assert(matchesStudyCardQuery(target, '高等数学'), 'search matches the PDF file name snapshot')
  assert(matchesStudyCardQuery(target, 'DET(A-ΛI)'), 'search is case-insensitive')
  assert(!matchesStudyCardQuery(target, '概率论'), 'search does not match unrelated text')
  assert(matchesStudyCardQuery(target, '   '), 'an empty query matches everything')
  assert(studyCardPlainText('# 标题\n\n- 一\n- 二\n\n`code` 与 [链接](https://x)').includes('标题'), 'plain text extraction keeps readable words')
  assert(!studyCardPlainText('# 标题\n\n- 一').includes('#'), 'plain text extraction drops markdown punctuation')
  assert(studyCardSearchText(target).includes('高等数学.pdf'), 'the search text includes every indexed field')
}

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
