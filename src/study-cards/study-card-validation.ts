import {
  MAX_STUDY_CARD_BODY_LENGTH, MAX_STUDY_CARD_DOCUMENT_REFS, MAX_STUDY_CARD_PAGES_PER_REF,
  MAX_STUDY_CARD_TITLE_LENGTH, STUDY_CARD_SCHEMA_VERSION,
  type StudyCard, type StudyCardCollectionMode, type StudyCardDocumentRef, type StudyCardDocumentRelation, type StudyCardRating, type StudyCardSource, type StudyCardTitleMode,
} from './study-card-types'
import { ANNOTATION_VERSION, type Annotation, type AnnotationTarget } from '../annotations/annotation-types'

export class StudyCardValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StudyCardValidationError'
  }
}

/** A card is plain text plus structural ids. A stored binary/data URL is a defect. */
const FORBIDDEN_PAYLOAD = /(?:data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,|blob:[a-z][a-z0-9+.-]*:\/\/)/i

const TITLE_MODES: StudyCardTitleMode[] = ['auto', 'custom']
const RELATIONS: StudyCardDocumentRelation[] = ['turn', 'prior-context']
const COLLECTION_MODES: StudyCardCollectionMode[] = ['saved', 'marked']

function fail(code: string, message: string): never { throw new StudyCardValidationError(code, message) }

function requireString(value: unknown, code: string, message: string, maxLength?: number): string {
  if (typeof value !== 'string') fail(code, message)
  const text = value as string
  if (maxLength !== undefined && text.length > maxLength) fail(code, message)
  return text
}

function requireNonEmptyString(value: unknown, code: string, message: string, maxLength?: number): string {
  const text = requireString(value, code, message, maxLength)
  if (!text.trim()) fail(code, message)
  return text
}

function requireFiniteTime(value: unknown, code: string, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, message)
  return value as number
}

function validateDocumentRef(input: unknown): StudyCardDocumentRef {
  if (!input || typeof input !== 'object') fail('ref-shape', '来源 PDF 记录必须是对象')
  const raw = input as Record<string, unknown>
  const fileNameSnapshot = requireNonEmptyString(raw.fileNameSnapshot, 'ref-file-name', '来源 PDF 记录缺少文件名快照', 260)
  const relation = raw.relation
  if (typeof relation !== 'string' || !RELATIONS.includes(relation as StudyCardDocumentRelation)) fail('ref-relation', '来源 PDF 记录的上下文类型非法')
  if (!Array.isArray(raw.pageNumbers)) fail('ref-pages', '来源 PDF 记录缺少页码数组')
  if (raw.pageNumbers.length > MAX_STUDY_CARD_PAGES_PER_REF) fail('ref-pages', '来源 PDF 记录的页码过多')
  const pages: number[] = []
  const seen = new Set<number>()
  for (const page of raw.pageNumbers as unknown[]) {
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) fail('ref-pages', '来源 PDF 记录的页码必须是正整数')
    if (!seen.has(page)) { seen.add(page); pages.push(page) }
  }
  pages.sort((a, b) => a - b)
  const ref: StudyCardDocumentRef = { fileNameSnapshot, pageNumbers: pages, relation: relation as StudyCardDocumentRelation }
  if (raw.documentId !== undefined) {
    ref.documentId = requireNonEmptyString(raw.documentId, 'ref-document-id', '来源 PDF 记录的 documentId 非法')
  }
  if (raw.chapterTitleSnapshot !== undefined) {
    ref.chapterTitleSnapshot = requireNonEmptyString(raw.chapterTitleSnapshot, 'ref-chapter', '来源 PDF 记录的章节快照非法', 260)
  }
  return ref
}

function validateSource(input: unknown): StudyCardSource {
  if (!input || typeof input !== 'object') fail('source-shape', '卡片来源必须是对象')
  const raw = input as Record<string, unknown>
  const source: StudyCardSource = {
    conversationId: requireNonEmptyString(raw.conversationId, 'source-conversation', '卡片来源缺少会话 id'),
    assistantMessageId: requireNonEmptyString(raw.assistantMessageId, 'source-assistant-message', '卡片来源缺少 AI 消息 id'),
    conversationTitleSnapshot: requireString(raw.conversationTitleSnapshot, 'source-title', '卡片来源缺少会话标题快照', 200),
    capturedAt: requireFiniteTime(raw.capturedAt, 'source-captured-at', '卡片来源缺少合法时间'),
  }
  if (raw.branchId !== undefined) source.branchId = requireNonEmptyString(raw.branchId, 'source-branch', '卡片来源的分支 id 非法')
  if (raw.userMessageId !== undefined) source.userMessageId = requireNonEmptyString(raw.userMessageId, 'source-user-message', '卡片来源的用户消息 id 非法')
  return source
}

function assertNoBinaryPayload(text: string, code: string, message: string): void {
  if (FORBIDDEN_PAYLOAD.test(text)) fail(code, message)
}

function validateAnnotationTarget(input: unknown): AnnotationTarget {
  if (!input || typeof input !== 'object') fail('annotation-target', '标记目标非法')
  const raw = input as Record<string, unknown>
  if (raw.type === 'text') {
    const anchor = raw.anchor as Record<string, unknown> | undefined
    const quote = raw.quote as Record<string, unknown> | undefined
    if (!anchor || !quote || !Number.isInteger(raw.start) || !Number.isInteger(raw.end) || (raw.start as number) < 0 || (raw.end as number) <= (raw.start as number)) fail('annotation-text', '文字标记非法')
    const parsedAnchor = anchor.scope === 'block'
      ? { scope: 'block' as const, blockId: requireNonEmptyString(anchor.blockId, 'annotation-anchor', '文字标记锚点非法') }
      : anchor.scope === 'table-cell' && Number.isInteger(anchor.row) && Number.isInteger(anchor.column)
        ? { scope: 'table-cell' as const, tableId: requireNonEmptyString(anchor.tableId, 'annotation-anchor', '表格标记锚点非法'), row: anchor.row as number, column: anchor.column as number }
        : fail('annotation-anchor', '文字标记锚点非法')
    return { type: 'text', anchor: parsedAnchor, start: raw.start as number, end: raw.end as number, quote: { exact: requireString(quote.exact, 'annotation-quote', '标记引文非法'), prefix: requireString(quote.prefix, 'annotation-quote', '标记引文非法'), suffix: requireString(quote.suffix, 'annotation-quote', '标记引文非法') } }
  }
  if (raw.type === 'math') return { type: 'math', mathId: requireNonEmptyString(raw.mathId, 'annotation-math', '公式标记非法'), mathKind: raw.mathKind === 'inline' || raw.mathKind === 'block' ? raw.mathKind : fail('annotation-math', '公式标记非法') }
  if (raw.type === 'table') return { type: 'table', tableId: requireNonEmptyString(raw.tableId, 'annotation-table', '表格标记非法') }
  if (raw.type === 'table-cells') {
    const bounds = raw.bounds as Record<string, unknown> | undefined
    if (!bounds || !Number.isInteger(bounds.rowStart) || !Number.isInteger(bounds.rowEnd) || !Number.isInteger(bounds.columnStart) || !Number.isInteger(bounds.columnEnd) || (bounds.rowStart as number) < 0 || (bounds.columnStart as number) < 0 || (bounds.rowEnd as number) < (bounds.rowStart as number) || (bounds.columnEnd as number) < (bounds.columnStart as number)) fail('annotation-table', '表格区域标记非法')
    return { type: 'table-cells', tableId: requireNonEmptyString(raw.tableId, 'annotation-table', '表格标记非法'), bounds: { rowStart: bounds.rowStart as number, rowEnd: bounds.rowEnd as number, columnStart: bounds.columnStart as number, columnEnd: bounds.columnEnd as number } }
  }
  fail('annotation-target', '标记目标类型非法')
}

function validateAnnotation(input: unknown, source: StudyCardSource): Annotation {
  if (!input || typeof input !== 'object') fail('annotation-shape', '标记必须是对象')
  const raw = input as Record<string, unknown>
  const conversationId = requireNonEmptyString(raw.conversationId, 'annotation-conversation', '标记会话非法')
  const messageId = requireNonEmptyString(raw.messageId, 'annotation-message', '标记消息非法')
  if (conversationId !== source.conversationId || messageId !== source.assistantMessageId) fail('annotation-source', '标记与学习卡片来源不一致')
  if (raw.version !== ANNOTATION_VERSION) fail('annotation-version', '标记版本非法')
  return { id: requireNonEmptyString(raw.id, 'annotation-id', '标记 id 非法'), conversationId, messageId, target: validateAnnotationTarget(raw.target), createdAt: requireFiniteTime(raw.createdAt, 'annotation-created', '标记时间非法'), updatedAt: requireFiniteTime(raw.updatedAt, 'annotation-updated', '标记时间非法'), version: ANNOTATION_VERSION }
}

/**
 * Strict validator. Unknown fields are DROPPED (never spread), so a hand-edited or
 * foreign row can never smuggle extra state into the store, and callers never need an
 * `as StudyCard` cast.
 */
export function validateStudyCard(input: unknown): StudyCard {
  if (!input || typeof input !== 'object') fail('shape', '学习卡片必须是对象')
  const raw = input as Record<string, unknown>
  if (raw.schemaVersion !== STUDY_CARD_SCHEMA_VERSION) fail('schema-version', '学习卡片 schemaVersion 非法')

  const title = requireNonEmptyString(raw.title, 'title', '学习卡片标题不能为空', MAX_STUDY_CARD_TITLE_LENGTH).trim()
  if (!title) fail('title', '学习卡片标题不能为空')

  const titleMode = raw.titleMode
  if (typeof titleMode !== 'string' || !TITLE_MODES.includes(titleMode as StudyCardTitleMode)) fail('title-mode', '学习卡片标题模式非法')

  const autoTitleOrdinal = raw.autoTitleOrdinal
  if (typeof autoTitleOrdinal !== 'number' || !Number.isInteger(autoTitleOrdinal) || autoTitleOrdinal < 1) fail('ordinal', '学习卡片序号必须是 >= 1 的整数')

  const bodyMarkdown = requireNonEmptyString(raw.bodyMarkdown, 'body', '学习卡片正文不能为空', MAX_STUDY_CARD_BODY_LENGTH)
  assertNoBinaryPayload(bodyMarkdown, 'body-payload', '学习卡片正文不能内嵌二进制或 data/blob URL')

  if (!Array.isArray(raw.documentRefs)) fail('refs', '学习卡片来源列表必须是数组')
  if (raw.documentRefs.length > MAX_STUDY_CARD_DOCUMENT_REFS) fail('refs', '学习卡片来源过多')
  const documentRefs = (raw.documentRefs as unknown[]).map(validateDocumentRef)
  for (const ref of documentRefs) assertNoBinaryPayload(ref.fileNameSnapshot, 'ref-payload', '来源 PDF 文件名快照不能内嵌二进制或 data/blob URL')

  const derivedDocumentIds = [...new Set(documentRefs.map(ref => ref.documentId).filter((id): id is string => !!id))].sort()
  if (raw.documentIds !== undefined) {
    if (!Array.isArray(raw.documentIds)) fail('document-ids', 'documentIds 必须是数组')
    const declared = [...new Set((raw.documentIds as unknown[]).map(id => requireNonEmptyString(id, 'document-ids', 'documentIds 元素非法')))].sort()
    if (declared.length !== derivedDocumentIds.length || declared.some((id, index) => id !== derivedDocumentIds[index])) {
      fail('document-ids', 'documentIds 必须等于来源记录中 documentId 的去重集合')
    }
  }

  const source = validateSource(raw.source)
  const card: StudyCard = {
    schemaVersion: STUDY_CARD_SCHEMA_VERSION,
    id: requireNonEmptyString(raw.id, 'id', '学习卡片 id 不能为空'),
    title,
    titleMode: titleMode as StudyCardTitleMode,
    autoTitleOrdinal,
    bodyMarkdown,
    source,
    documentRefs,
    documentIds: derivedDocumentIds,
    createdAt: requireFiniteTime(raw.createdAt, 'created-at', '学习卡片缺少合法创建时间'),
    updatedAt: requireFiniteTime(raw.updatedAt, 'updated-at', '学习卡片缺少合法修改时间'),
  }
  if (raw.lastOpenedAt !== undefined) card.lastOpenedAt = requireFiniteTime(raw.lastOpenedAt, 'last-opened-at', '学习卡片最近打开时间非法')
  if (raw.rating !== undefined) {
    if (typeof raw.rating !== 'number' || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5) fail('rating', '学习卡片评分必须是 1–5 的整数')
    card.rating = raw.rating as StudyCardRating
  }
  if (raw.collectionMode !== undefined) {
    if (typeof raw.collectionMode !== 'string' || !COLLECTION_MODES.includes(raw.collectionMode as StudyCardCollectionMode)) fail('collection-mode', '学习卡片收集方式非法')
    card.collectionMode = raw.collectionMode as StudyCardCollectionMode
  }
  if (raw.annotations !== undefined) {
    if (!Array.isArray(raw.annotations)) fail('annotations', '学习卡片标记必须是数组')
    const seen = new Set<string>()
    card.annotations = raw.annotations.map(item => validateAnnotation(item, source)).filter(annotation => !seen.has(annotation.id) && !!seen.add(annotation.id))
  }
  return card
}

/** Non-throwing variant for list/backup paths that must skip a bad row. */
export function isValidStudyCard(input: unknown): boolean {
  try { validateStudyCard(input); return true } catch { return false }
}
