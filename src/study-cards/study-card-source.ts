import type { Message } from '../engine/types'
import type { StudyCardDocumentRef, StudyCardDocumentRelation } from './study-card-types'

/**
 * Which PDFs a saved reply really used (v2.2.0 §7.7).
 *
 * Sources come ONLY from structured relations:
 *   - the PDF contexts / PDF-page attachments of the user message this reply answers
 *     become `turn` refs;
 *   - PDF contexts still present earlier on the effective path become `prior-context`.
 * Prose is never parsed: "第 3 页" in the answer creates nothing.
 */

export type StudyCardAttachmentMeta = {
  id: string
  name: string
  source?: {
    type: string
    documentId?: string
    fileName: string
    pageNumber: number
  }
}

export type StudyCardReferenceInput = {
  /** Effective path through the assistant message, root-most first. */
  path: Message[]
  assistantMessageId: string
  attachmentsById: Map<string, StudyCardAttachmentMeta>
  /** documentId -> file name snapshot (used when the attachment is gone). */
  documentNames: Map<string, string>
}

export type StudyCardReferenceResult = {
  userMessageId?: string
  documentRefs: StudyCardDocumentRef[]
}

type RefKey = string

function refKey(documentId: string | undefined, fileName: string, relation: StudyCardDocumentRelation): RefKey {
  return (documentId ? 'id:' + documentId : 'name:' + fileName) + '|' + relation
}

class RefAccumulator {
  private readonly byKey = new Map<RefKey, StudyCardDocumentRef>()

  add(documentId: string | undefined, fileName: string, pages: readonly number[]): void {
    const relation: StudyCardDocumentRelation = 'turn'
    this.merge(refKey(documentId, fileName, relation), documentId, fileName, relation, pages)
  }

  addPrior(documentId: string | undefined, fileName: string, pages: readonly number[]): void {
    const relation: StudyCardDocumentRelation = 'prior-context'
    this.merge(refKey(documentId, fileName, relation), documentId, fileName, relation, pages)
  }

  private merge(key: RefKey, documentId: string | undefined, fileName: string, relation: StudyCardDocumentRelation, pages: readonly number[]): void {
    const existing = this.byKey.get(key)
    if (existing) {
      const merged = new Set(existing.pageNumbers)
      for (const page of pages) if (Number.isInteger(page) && page > 0) merged.add(page)
      existing.pageNumbers = [...merged].sort((a, b) => a - b)
      return
    }
    const unique = [...new Set(pages.filter(page => Number.isInteger(page) && page > 0))].sort((a, b) => a - b)
    this.byKey.set(key, { ...(documentId ? { documentId } : {}), fileNameSnapshot: fileName, pageNumbers: unique, relation })
  }

  /** The turn relation is strictly stronger: every page of the same document folds into
   *  the turn ref so the card still shows all real pages, with the stronger relation. */
  toArray(): StudyCardDocumentRef[] {
    const refs = [...this.byKey.values()]
    const keyOf = (ref: StudyCardDocumentRef) => ref.documentId ?? 'name:' + ref.fileNameSnapshot
    const turnByDocument = new Map<string, StudyCardDocumentRef>()
    for (const ref of refs) if (ref.relation === 'turn') turnByDocument.set(keyOf(ref), ref)
    const kept: StudyCardDocumentRef[] = []
    for (const ref of refs) {
      if (ref.relation === 'turn') { kept.push(ref); continue }
      const turn = turnByDocument.get(keyOf(ref))
      if (turn) {
        turn.pageNumbers = [...new Set([...turn.pageNumbers, ...ref.pageNumbers])].sort((a, b) => a - b)
        continue
      }
      kept.push(ref)
    }
    return kept.sort((a, b) => {
      if (a.relation !== b.relation) return a.relation === 'turn' ? -1 : 1
      const aKey = a.documentId ?? a.fileNameSnapshot
      const bKey = b.documentId ?? b.fileNameSnapshot
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
    })
  }
}

/** Structured PDF provenance of one message: contexts plus real PDF-page attachments. */
function collectMessagePdfSources(message: Message, attachmentsById: Map<string, StudyCardAttachmentMeta>, documentNames: Map<string, string>): { documentId?: string; fileName: string; pages: number[] }[] {
  const out: { documentId?: string; fileName: string; pages: number[] }[] = []
  const contexts = Array.isArray(message.pdfContexts) && message.pdfContexts.length > 0
    ? message.pdfContexts
    : (message.pdfContext ? [message.pdfContext] : [])
  for (const context of contexts) {
    const documentId = typeof context.documentId === 'string' && context.documentId ? context.documentId : undefined
    const fileName = (documentId && documentNames.get(documentId)) || '未命名 PDF'
    out.push({ ...(documentId ? { documentId } : {}), fileName, pages: Array.isArray(context.pageNumbers) ? context.pageNumbers : [] })
  }
  for (const imageId of message.images) {
    const attachment = attachmentsById.get(imageId)
    const source = attachment?.source
    if (!attachment || !source || source.type !== 'pdf-page') continue
    const documentId = typeof source.documentId === 'string' && source.documentId ? source.documentId : undefined
    // A PDF page attachment without a context is still real provenance for this message.
    const fileName = source.fileName || attachment.name || '未命名 PDF'
    out.push({ ...(documentId ? { documentId } : {}), fileName, pages: Number.isInteger(source.pageNumber) ? [source.pageNumber] : [] })
  }
  return out
}

export function extractStudyCardReference(input: StudyCardReferenceInput): StudyCardReferenceResult {
  const { path, assistantMessageId, attachmentsById, documentNames } = input
  const assistantIndex = path.findIndex(message => message.id === assistantMessageId)
  if (assistantIndex < 0) return { documentRefs: [] }
  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (path[index].role === 'user') { userIndex = index; break }
  }
  const accumulator = new RefAccumulator()
  // Earlier messages first, so the turn's stronger relation is applied last on top.
  for (let index = 0; index < assistantIndex; index++) {
    if (index === userIndex) continue
    for (const source of collectMessagePdfSources(path[index], attachmentsById, documentNames)) {
      accumulator.addPrior(source.documentId, source.fileName, source.pages)
    }
  }
  if (userIndex >= 0) {
    for (const source of collectMessagePdfSources(path[userIndex], attachmentsById, documentNames)) {
      accumulator.add(source.documentId, source.fileName, source.pages)
    }
  }
  return {
    ...(userIndex >= 0 ? { userMessageId: path[userIndex].id } : {}),
    documentRefs: accumulator.toArray(),
  }
}
