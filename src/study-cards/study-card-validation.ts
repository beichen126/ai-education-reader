import {
  MAX_STUDY_CARD_BODY_LENGTH, MAX_STUDY_CARD_DOCUMENT_REFS, MAX_STUDY_CARD_PAGES_PER_REF,
  MAX_STUDY_CARD_TITLE_LENGTH, STUDY_CARD_SCHEMA_VERSION,
  type StudyCard, type StudyCardDocumentRef, type StudyCardDocumentRelation, type StudyCardSource, type StudyCardTitleMode,
} from './study-card-types'

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

  const card: StudyCard = {
    schemaVersion: STUDY_CARD_SCHEMA_VERSION,
    id: requireNonEmptyString(raw.id, 'id', '学习卡片 id 不能为空'),
    title,
    titleMode: titleMode as StudyCardTitleMode,
    autoTitleOrdinal,
    bodyMarkdown,
    source: validateSource(raw.source),
    documentRefs,
    documentIds: derivedDocumentIds,
    createdAt: requireFiniteTime(raw.createdAt, 'created-at', '学习卡片缺少合法创建时间'),
    updatedAt: requireFiniteTime(raw.updatedAt, 'updated-at', '学习卡片缺少合法修改时间'),
  }
  if (raw.lastOpenedAt !== undefined) card.lastOpenedAt = requireFiniteTime(raw.lastOpenedAt, 'last-opened-at', '学习卡片最近打开时间非法')
  return card
}

/** Non-throwing variant for list/backup paths that must skip a bad row. */
export function isValidStudyCard(input: unknown): boolean {
  try { validateStudyCard(input); return true } catch { return false }
}
