import { normalizeMessagePdfContexts, pdfContextsOf, type Conversation, type Message, type StableId } from '../engine/types'
import type { ConversationBranch } from '../branches/branch-types'
import { displayTitle } from '../engine/session-title'

/** A concrete message hit for one exact PDF document/page pair. */
export type PdfPageConversationHit = {
  conversationId: StableId
  conversationTitle: string
  messageId: StableId
  messageCreatedAt: number
  documentId: string
  pageNumber: number
  messagePreview: string
  branchId?: StableId
}

function hitFor(conversation: Conversation, message: Message, documentId: string, pageNumber: number, branchId?: StableId): PdfPageConversationHit {
  return {
    conversationId: conversation.id,
    conversationTitle: displayTitle(conversation),
    messageId: message.id,
    messageCreatedAt: message.createdAt,
    documentId,
    pageNumber,
    messagePreview: message.content.trim().replace(/\s+/g, ' ').slice(0, 120),
    ...(branchId ? { branchId } : {}),
  }
}

/**
 * Pure reverse provenance query. It intentionally receives the current records rather
 * than reading IndexedDB or maintaining an inverted index, so stale/deleted records are
 * naturally absent from the result and the matching rule remains directly testable.
 *
 * Root messages and branch-local messages are both considered. A branch hit carries its
 * branchId so the caller can activate the exact thread before positioning the message.
 */
export function findConversationsByDocumentPage(
  documentId: string,
  pageNumber: number,
  conversations: readonly Conversation[],
  branches: readonly ConversationBranch[] = [],
): PdfPageConversationHit[] {
  if (!documentId || !Number.isInteger(pageNumber) || pageNumber < 1) return []

  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const hits: PdfPageConversationHit[] = []
  const seen = new Set<string>()

  const visit = (conversation: Conversation, message: Message, branchId?: StableId) => {
    const key = conversation.id + ':' + message.id + ':' + documentId + ':' + pageNumber
    if (seen.has(key)) return
    const normalized = normalizeMessagePdfContexts(message)
    const matches = pdfContextsOf(normalized).some((context) => context.documentId === documentId && context.pageNumbers.includes(pageNumber))
    if (!matches) return
    seen.add(key)
    hits.push(hitFor(conversation, message, documentId, pageNumber, branchId))
  }

  for (const conversation of conversations) {
    for (const message of conversation.messages) visit(conversation, message)
  }
  for (const branch of branches) {
    const conversation = conversationsById.get(branch.conversationId)
    if (!conversation) continue
    for (const message of branch.messages) visit(conversation, message, branch.id)
  }

  return hits.sort((a, b) => b.messageCreatedAt - a.messageCreatedAt || a.conversationId.localeCompare(b.conversationId) || a.messageId.localeCompare(b.messageId))
}
