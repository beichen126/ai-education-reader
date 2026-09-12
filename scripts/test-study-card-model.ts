// v2.2.0 Stage 4 domain gate: the StudyCard record has a strict, self-consistent validator.
import {
  StudyCardValidationError, validateStudyCard, isValidStudyCard,
} from '../src/study-cards/study-card-validation.ts'
import { STUDY_CARD_SCHEMA_VERSION, MAX_STUDY_CARD_BODY_LENGTH, MAX_STUDY_CARD_TITLE_LENGTH, type StudyCard } from '../src/study-cards/study-card-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}
function throws(fn: () => unknown): boolean { try { fn(); return false } catch { return true } }

function baseCard(overrides: Partial<StudyCard> = {}): StudyCard {
  return {
    schemaVersion: STUDY_CARD_SCHEMA_VERSION,
    id: 'card-1',
    title: '线性代数复习-1',
    titleMode: 'auto',
    autoTitleOrdinal: 1,
    bodyMarkdown: '# 特征值\n\n矩阵 A 的特征值满足 det(A-λI)=0。',
    source: {
      conversationId: 'conv-1',
      branchId: 'branch-1',
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
      conversationTitleSnapshot: '线性代数复习',
      capturedAt: 1700000000000,
    },
    documentRefs: [
      { documentId: 'doc-1', fileNameSnapshot: '高等数学.pdf', pageNumbers: [3, 12, 15], relation: 'turn' },
      { documentId: 'doc-2', fileNameSnapshot: '习题解答.pdf', pageNumbers: [88], relation: 'prior-context' },
    ],
    documentIds: ['doc-1', 'doc-2'],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

// ---- 1. a well-formed card round-trips ----
{
  const card = validateStudyCard(baseCard())
  assert(card.id === 'card-1' && card.title === '线性代数复习-1', 'a valid card survives validation')
  assert(card.documentIds.join('|') === 'doc-1|doc-2', 'documentIds are kept when they match the refs')
  assert(card.documentRefs[0].pageNumbers.join('|') === '3|12|15', 'page numbers are preserved')
  assert(isValidStudyCard(baseCard()) === true, 'isValidStudyCard agrees with validateStudyCard')
}

// ---- 2. identity and schema ----
{
  assert(throws(() => validateStudyCard(baseCard({ id: '' }))), 'an empty id is rejected')
  assert(throws(() => validateStudyCard(baseCard({ id: '   ' }))), 'a blank id is rejected')
  assert(throws(() => validateStudyCard(baseCard({ schemaVersion: 2 as never }))), 'an unknown schemaVersion is rejected')
  assert(throws(() => validateStudyCard({ ...baseCard(), schemaVersion: undefined as never })), 'a missing schemaVersion is rejected')
  assert(isValidStudyCard({ ...baseCard(), id: '' }) === false, 'isValidStudyCard never throws on a bad row')
}

// ---- 3. title rules ----
{
  const trimmed = validateStudyCard(baseCard({ title: '  标题  ' }))
  assert(trimmed.title === '标题', 'the title is trimmed')
  assert(throws(() => validateStudyCard(baseCard({ title: '   ' }))), 'a blank title is rejected')
  assert(throws(() => validateStudyCard(baseCard({ title: 'x'.repeat(MAX_STUDY_CARD_TITLE_LENGTH + 1) }))), 'an over-long title is rejected')
  assert(throws(() => validateStudyCard(baseCard({ titleMode: 'manual' as never }))), 'an unknown titleMode is rejected')
}

// ---- 4. ordinal and timestamps ----
{
  assert(throws(() => validateStudyCard(baseCard({ autoTitleOrdinal: 0 }))), 'ordinal 0 is rejected')
  assert(throws(() => validateStudyCard(baseCard({ autoTitleOrdinal: 1.5 }))), 'a fractional ordinal is rejected')
  assert(throws(() => validateStudyCard(baseCard({ createdAt: Number.NaN }))), 'a non-finite createdAt is rejected')
  assert(throws(() => validateStudyCard(baseCard({ updatedAt: Number.POSITIVE_INFINITY }))), 'a non-finite updatedAt is rejected')
  const withOpened = validateStudyCard(baseCard({ lastOpenedAt: 1700000009999 }))
  assert(withOpened.lastOpenedAt === 1700000009999, 'a finite lastOpenedAt is kept')
  assert(throws(() => validateStudyCard({ ...baseCard(), lastOpenedAt: 'yesterday' as never })), 'a non-numeric lastOpenedAt is rejected')
}

// ---- 5. body rules ----
{
  assert(throws(() => validateStudyCard(baseCard({ bodyMarkdown: '   ' }))), 'an empty body is rejected')
  assert(throws(() => validateStudyCard(baseCard({ bodyMarkdown: 'x'.repeat(MAX_STUDY_CARD_BODY_LENGTH + 1) }))), 'an over-long body is rejected')
  assert(throws(() => validateStudyCard({ ...baseCard(), bodyMarkdown: 42 as never })), 'a non-string body is rejected')
}

// ---- 6. source rules ----
{
  assert(throws(() => validateStudyCard(baseCard({ source: { ...baseCard().source, conversationId: '' } }))), 'a blank source conversationId is rejected')
  assert(throws(() => validateStudyCard(baseCard({ source: { ...baseCard().source, assistantMessageId: '' } }))), 'a blank source assistantMessageId is rejected')
  assert(throws(() => validateStudyCard(baseCard({ source: { ...baseCard().source, capturedAt: Number.NaN } }))), 'a non-finite capturedAt is rejected')
  const rootCard = validateStudyCard(baseCard({ source: { conversationId: 'conv-1', assistantMessageId: 'a-1', conversationTitleSnapshot: '会话', capturedAt: 1 } }))
  assert(rootCard.source.branchId === undefined && rootCard.source.userMessageId === undefined, 'a root card may omit branch and user message')
}

// ---- 7. document refs and documentIds consistency ----
{
  assert(throws(() => validateStudyCard(baseCard({ documentIds: ['doc-1'] }))), 'documentIds that drop a ref are rejected')
  assert(throws(() => validateStudyCard(baseCard({ documentIds: ['doc-1', 'doc-2', 'doc-3'] }))), 'documentIds with an invented id are rejected')
  const deduped = validateStudyCard(baseCard({ documentIds: ['doc-2', 'doc-1', 'doc-1'] }))
  assert(deduped.documentIds.join('|') === 'doc-1|doc-2', 'documentIds are normalized to a sorted unique set')
  assert(throws(() => validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: '', pageNumbers: [1], relation: 'turn' }], documentIds: [] }))), 'a blank fileNameSnapshot is rejected')
  assert(throws(() => validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: 'a.pdf', pageNumbers: [0], relation: 'turn' }], documentIds: [] }))), 'page 0 is rejected')
  assert(throws(() => validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: 'a.pdf', pageNumbers: [-3], relation: 'turn' }], documentIds: [] }))), 'a negative page is rejected')
  assert(throws(() => validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: 'a.pdf', pageNumbers: [1.5], relation: 'turn' }], documentIds: [] }))), 'a fractional page is rejected')
  assert(throws(() => validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: 'a.pdf', pageNumbers: [1], relation: 'cited' as never }], documentIds: [] }))), 'an unknown relation is rejected')
  const normalized = validateStudyCard(baseCard({ documentRefs: [{ documentId: 'doc-9', fileNameSnapshot: 'a.pdf', pageNumbers: [5, 3, 5, 4], relation: 'turn' }], documentIds: ['doc-9'] }))
  assert(normalized.documentRefs[0].pageNumbers.join('|') === '3|4|5', 'page numbers are sorted and deduplicated')
  const withoutId = validateStudyCard(baseCard({ documentRefs: [{ fileNameSnapshot: '旧文件.pdf', pageNumbers: [2], relation: 'turn' }], documentIds: [] }))
  assert(withoutId.documentRefs[0].documentId === undefined, 'a legacy ref without a documentId is allowed and never invented')
  assert(withoutId.documentIds.length === 0, 'a ref without a documentId contributes nothing to documentIds')
}

// ---- 8. no binary payloads, no unknown fields leaking through ----
{
  const dirty = { ...baseCard(), blob: new Blob(['x']), objectUrl: 'blob:http://x/y', extra: 'nope' } as unknown
  const clean = validateStudyCard(dirty) as unknown as Record<string, unknown>
  assert(clean.blob === undefined && clean.objectUrl === undefined && clean.extra === undefined, 'unknown and binary-carrying fields are dropped')
  assert(throws(() => validateStudyCard(baseCard({ bodyMarkdown: 'data:application/pdf;base64,AAAA' }))), 'a data URL body is rejected')
  assert(throws(() => validateStudyCard(baseCard({ bodyMarkdown: 'blob:http://localhost/abc' }))), 'a blob URL body is rejected')
}

// ---- 9. the thrown error carries a stable code ----
{
  try {
    validateStudyCard({})
    assert(false, 'an empty object is rejected')
  } catch (error) {
    assert(error instanceof StudyCardValidationError, 'validation throws StudyCardValidationError')
    assert(typeof (error as StudyCardValidationError).code === 'string' && (error as StudyCardValidationError).code.length > 0, 'the validation error carries a code')
  }
}

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
