import { buildEffectivePathThrough } from '../branches/branch-path'
import { isCompletedAssistantMessage, newStableId, type Conversation, type Message, type StableId } from '../engine/types'
import { openIdb } from '../storage/idb'
import type { ConversationBranch } from '../branches/branch-types'
import { extractStudyCardReference, type StudyCardAttachmentMeta } from './study-card-source'
import { validateStudyCard } from './study-card-validation'
import {
  MAX_STUDY_CARD_BODY_LENGTH, MAX_STUDY_CARD_TITLE_LENGTH, STUDY_CARD_SCHEMA_VERSION,
  type StudyCard, type StudyCardDocumentRef,
} from './study-card-types'
import {
  countStudyCards, deleteStudyCardRow, estimateStudyCardTextBytes, getStudyCard, getStudyCardBySourceMessage,
  listStudyCardPageRefs, listStudyCards, listStudyCardsByDocument, listStudyCardsByDocumentPage,
  rebuildStudyCardPageRefs, studyCardReadDiagnostics, updateStudyCardRow,
} from './study-card-store'

export type { StudyCard, StudyCardDocumentRef, StudyCardPageRef } from './study-card-types'
export {
  countStudyCards, estimateStudyCardTextBytes, getStudyCard,
  getStudyCardBySourceMessage, listStudyCardPageRefs, listStudyCards, listStudyCardsByDocument,
  listStudyCardsByDocumentPage, rebuildStudyCardPageRefs, studyCardReadDiagnostics,
}

export const FALLBACK_CARD_CONVERSATION_TITLE = '学习卡片'

export type CreateStudyCardInput = {
  conversationId: StableId
  branchId?: StableId
  assistantMessageId: StableId
  /** Present only when the user supplied an explicit title; otherwise the auto title wins. */
  title?: string
}

export type CreateStudyCardResult =
  | { kind: 'created'; card: StudyCard }
  | { kind: 'existing'; card: StudyCard }
  | { kind: 'source-missing'; message: string }
  | { kind: 'source-unstable'; message: string }

/** The branch a card was saved from. A branch reply must never be recorded as root. */
export function resolveActiveBranchId(branches: ConversationBranch[], branchId: StableId | undefined): StableId | undefined {
  if (!branchId) return undefined
  return branches.some(branch => branch.id === branchId) ? branchId : undefined
}

function autoTitle(conversationTitle: string, ordinal: number): string {
  const base = conversationTitle.trim() || FALLBACK_CARD_CONVERSATION_TITLE
  return (base + '-' + ordinal).slice(0, MAX_STUDY_CARD_TITLE_LENGTH)
}

function attachmentMetaFromRow(row: { meta?: { id?: string; name?: string; source?: { type?: string; documentId?: string; fileName?: string; pageNumber?: number } } } | undefined): StudyCardAttachmentMeta | undefined {
  const meta = row?.meta
  if (!meta || typeof meta.id !== 'string') return undefined
  const source = meta.source
  return {
    id: meta.id,
    name: typeof meta.name === 'string' ? meta.name : '',
    ...(source && typeof source.type === 'string'
      ? { source: { type: source.type, ...(source.documentId ? { documentId: source.documentId } : {}), fileName: typeof source.fileName === 'string' ? source.fileName : '', pageNumber: typeof source.pageNumber === 'number' ? source.pageNumber : 0 } }
      : {}),
  }
}

function pageRefDocuments(path: Message[], attachmentsById: Map<string, StudyCardAttachmentMeta>): string[] {
  const ids = new Set<string>()
  for (const message of path) {
    const contexts = Array.isArray(message.pdfContexts) && message.pdfContexts.length > 0 ? message.pdfContexts : (message.pdfContext ? [message.pdfContext] : [])
    for (const context of contexts) if (context.documentId) ids.add(context.documentId)
    for (const imageId of message.images) {
      const documentId = attachmentsById.get(imageId)?.source?.documentId
      if (documentId) ids.add(documentId)
    }
  }
  return [...ids]
}

/**
 * Save one completed assistant reply as a StudyCard (§7.6).
 *
 * Everything happens inside ONE readwrite transaction: the source conversation, the
 * branch rows, the effective path, the idempotency lookup, the per-conversation ordinal,
 * the attachment metadata, the card row and its derived page rows. Concurrent tabs are
 * serialized by IndexedDB itself, so two saves can never allocate the same ordinal, and
 * a repeated save of the same message returns the existing card instead of a duplicate.
 */
export async function createStudyCardFromAssistantMessage(input: CreateStudyCardInput): Promise<CreateStudyCardResult> {
  const db = await openIdb()
  const now = Date.now()
  let result: CreateStudyCardResult | undefined

  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(['conversations', 'conversationBranches', 'attachments', 'documents', 'studyCards', 'studyCardPageRefs'], 'readwrite')
    const conversations = txn.objectStore('conversations')
    const branchesStore = txn.objectStore('conversationBranches')
    const attachmentsStore = txn.objectStore('attachments')
    const documentsStore = txn.objectStore('documents')
    const cards = txn.objectStore('studyCards')
    const pageRefs = txn.objectStore('studyCardPageRefs')
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try { txn.abort() } catch { /* already aborting */ }
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const finish = (value: CreateStudyCardResult) => { result = value }

    const conversationRequest = conversations.get(input.conversationId)
    conversationRequest.onerror = () => fail(conversationRequest.error)
    conversationRequest.onsuccess = () => {
      const conversation = conversationRequest.result as Conversation | undefined
      if (!conversation) { finish({ kind: 'source-missing', message: '原会话已不存在' }); return }
      const branchRequest = branchesStore.index('by_conversation').getAll(input.conversationId)
      branchRequest.onerror = () => fail(branchRequest.error)
      branchRequest.onsuccess = () => {
        try {
          const branches = (branchRequest.result ?? []) as ConversationBranch[]
          const path = buildEffectivePathThrough(conversation, branches, { branchId: input.branchId }, input.assistantMessageId)
          if (path.length === 0) { finish({ kind: 'source-missing', message: '未在会话中找到这条 AI 回复' }); return }
          const assistantMessage = path.find(message => message.id === input.assistantMessageId)
          if (!assistantMessage || !isCompletedAssistantMessage(assistantMessage)) {
            finish({ kind: 'source-unstable', message: '只能保存已完成且非空的 AI 回复' })
            return
          }
          const existingRequest = cards.index('by_source_message').get(input.assistantMessageId)
          existingRequest.onerror = () => fail(existingRequest.error)
          existingRequest.onsuccess = () => {
            const existingRow = existingRequest.result
            if (existingRow !== undefined) {
              try { finish({ kind: 'existing', card: validateStudyCard(existingRow) }) } catch (error) { fail(error) }
              return
            }
            const ordinalRequest = cards.index('by_source_conversation').getAll(input.conversationId)
            ordinalRequest.onerror = () => fail(ordinalRequest.error)
            ordinalRequest.onsuccess = () => {
              try {
                const existingCards = (ordinalRequest.result ?? []) as unknown[]
                let maxOrdinal = 0
                for (const row of existingCards) {
                  const value = (row as { autoTitleOrdinal?: unknown }).autoTitleOrdinal
                  if (typeof value === 'number' && Number.isInteger(value) && value > maxOrdinal) maxOrdinal = value
                }
                const ordinal = maxOrdinal + 1
                const imageIds = [...new Set(path.flatMap(message => message.images))]
                const attachmentRows = new Map<string, StudyCardAttachmentMeta>()
                let pending = imageIds.length
                const afterAttachments = () => {
                  if (pending > 0) return
                  const documentIds = pageRefDocuments(path, attachmentRows)
                  const documentNames = new Map<string, string>()
                  let documentsPending = documentIds.length
                  const afterDocuments = () => {
                    try { writeCard(conversation, branches, path, ordinal, attachmentRows, documentNames) } catch (error) { fail(error) }
                  }
                  if (documentsPending === 0) { afterDocuments(); return }
                  for (const documentId of documentIds) {
                    const documentRequest = documentsStore.get(documentId)
                    documentRequest.onerror = () => fail(documentRequest.error)
                    documentRequest.onsuccess = () => {
                      const row = documentRequest.result as { fileName?: unknown } | undefined
                      if (row && typeof row.fileName === 'string' && row.fileName) documentNames.set(documentId, row.fileName)
                      documentsPending--
                      if (documentsPending === 0) afterDocuments()
                    }
                  }
                }
                if (pending === 0) { afterAttachments() }
                else {
                  for (const imageId of imageIds) {
                    const attachmentRequest = attachmentsStore.get(imageId)
                    attachmentRequest.onerror = () => fail(attachmentRequest.error)
                    attachmentRequest.onsuccess = () => {
                      const meta = attachmentMetaFromRow(attachmentRequest.result)
                      if (meta) attachmentRows.set(imageId, meta)
                      pending--
                      if (pending === 0) afterAttachments()
                    }
                  }
                }

                function writeCard(conv: Conversation, branchRows: ConversationBranch[], effectivePath: Message[], allocatedOrdinal: number, attachmentsById: Map<string, StudyCardAttachmentMeta>, documentNames: Map<string, string>) {
                  const reference = extractStudyCardReference({ path: effectivePath, assistantMessageId: input.assistantMessageId, attachmentsById, documentNames })
                  const explicitTitle = input.title?.trim()
                  const card: StudyCard = {
                    schemaVersion: STUDY_CARD_SCHEMA_VERSION,
                    id: newStableId(),
                    title: explicitTitle ? explicitTitle.slice(0, MAX_STUDY_CARD_TITLE_LENGTH) : autoTitle(conv.title, allocatedOrdinal),
                    titleMode: explicitTitle ? 'custom' : 'auto',
                    autoTitleOrdinal: allocatedOrdinal,
                    bodyMarkdown: assistantMessage!.content,
                    source: {
                      conversationId: conv.id,
                      ...(resolveActiveBranchId(branchRows, input.branchId) ? { branchId: input.branchId } : {}),
                      ...(reference.userMessageId ? { userMessageId: reference.userMessageId } : {}),
                      assistantMessageId: input.assistantMessageId,
                      conversationTitleSnapshot: conv.title,
                      capturedAt: now,
                    },
                    documentRefs: reference.documentRefs,
                    documentIds: [...new Set(reference.documentRefs.map(ref => ref.documentId).filter((id): id is string => !!id))].sort(),
                    createdAt: now,
                    updatedAt: now,
                  }
                  const validated = validateStudyCard(card)
                  cards.put(validated)
                  for (const ref of validated.documentRefs) {
                    if (!ref.documentId) continue
                    for (const pageNumber of ref.pageNumbers) {
                      pageRefs.put({ id: ref.documentId + ':' + pageNumber + ':' + validated.id, documentId: ref.documentId, pageNumber, cardId: validated.id })
                    }
                  }
                  finish({ kind: 'created', card: validated })
                }
              } catch (error) { fail(error) }
            }
          }
        } catch (error) { fail(error) }
      }
    }
    txn.oncomplete = () => { if (!settled) { settled = true; resolve() } }
    txn.onerror = () => fail(txn.error)
    txn.onabort = () => { if (!settled) { settled = true; resolve() } }
  })

  if (!result) throw new Error('学习卡片保存事务未返回结果')
  return result
}

/** Rename a card. Never changes createdAt, ordinal or source, and refuses to overwrite a
 *  newer revision from another tab. */
export async function updateStudyCardTitle(id: StableId, title: string, expectedUpdatedAt?: number): Promise<StudyCard | undefined> {
  const clean = title.trim()
  if (!clean) return undefined
  return updateStudyCardRow(id, current => {
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return undefined
    return { ...current, title: clean.slice(0, MAX_STUDY_CARD_TITLE_LENGTH), titleMode: 'custom', updatedAt: Date.now() }
  })
}

/** Edit the user's own card body. The frozen source snapshot never drifts. */
export async function updateStudyCardBody(id: StableId, markdown: string, expectedUpdatedAt?: number): Promise<StudyCard | undefined> {
  if (!markdown.trim()) return undefined
  if (markdown.length > MAX_STUDY_CARD_BODY_LENGTH) return undefined
  return updateStudyCardRow(id, current => {
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return undefined
    return { ...current, bodyMarkdown: markdown, updatedAt: Date.now() }
  })
}

/** Record that the detail really opened. Never rewinds and never touches updatedAt. */
export async function markStudyCardOpened(id: StableId, openedAt: number): Promise<StudyCard | undefined> {
  if (!Number.isFinite(openedAt)) return undefined
  const updated = await updateStudyCardRow(id, current => {
    if (current.lastOpenedAt !== undefined && current.lastOpenedAt >= openedAt) return undefined
    return { ...current, lastOpenedAt: openedAt }
  })
  return updated ?? getStudyCard(id)
}

export async function deleteStudyCard(id: StableId): Promise<void> { await deleteStudyCardRow(id) }
