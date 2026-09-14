import { listBranchesByConversation } from '../branches/branch-store'
import { getConversation } from '../storage/storage'
import { deleteAnnotationsByIds } from '../storage/storage'
import { idbScan } from '../storage/idb'
import { createStudyCardFromAssistantMessage, getStudyCardBySourceMessage, updateStudyCardAnnotations } from '../study-cards/study-card-service'
import type { Annotation } from './annotation-types'

export type AnnotationMigrationResult = { migrated: number; deferred: number; cardsUpdated: number }

/**
 * Idempotently folds v2.2's separate annotation rows into their source StudyCard.
 * A matching saved card wins and is enriched in place; otherwise marking creates one
 * marked-only card. Legacy rows are removed only after the card commit succeeds. Any
 * unresolved source stays untouched and is retried at the next boot.
 */
export async function migrateAnnotationsToStudyCards(): Promise<AnnotationMigrationResult> {
  const legacy: Annotation[] = []
  await idbScan('annotations', row => { if (row && typeof row === 'object') legacy.push(row as Annotation) })
  const groups = new Map<string, Annotation[]>()
  for (const annotation of legacy) {
    const key = annotation.conversationId + '::' + annotation.messageId
    const group = groups.get(key) ?? []
    group.push(annotation)
    groups.set(key, group)
  }
  let migrated = 0
  let deferred = 0
  let cardsUpdated = 0
  for (const group of groups.values()) {
    const first = group[0]
    try {
      let card = await getStudyCardBySourceMessage(first.messageId)
      if (!card) {
        const conversation = await getConversation(first.conversationId)
        if (!conversation) { deferred += group.length; continue }
        let branchId: string | undefined
        if (!conversation.messages.some(message => message.id === first.messageId)) {
          const branches = await listBranchesByConversation(first.conversationId)
          branchId = branches.find(branch => branch.messages.some(message => message.id === first.messageId))?.id
          if (!branchId) { deferred += group.length; continue }
        }
        const created = await createStudyCardFromAssistantMessage({ conversationId: first.conversationId, assistantMessageId: first.messageId, ...(branchId ? { branchId } : {}), collectionMode: 'marked' })
        if (created.kind !== 'created' && created.kind !== 'existing') { deferred += group.length; continue }
        card = created.card
      }
      if (card.source.conversationId !== first.conversationId) { deferred += group.length; continue }
      const merged = new Map((card.annotations ?? []).map(annotation => [annotation.id, annotation]))
      for (const annotation of group) merged.set(annotation.id, annotation)
      const updated = await updateStudyCardAnnotations(card.id, [...merged.values()])
      if (!updated) { deferred += group.length; continue }
      await deleteAnnotationsByIds(group.map(annotation => annotation.id))
      migrated += group.length
      cardsUpdated++
    } catch {
      deferred += group.length
    }
  }
  return { migrated, deferred, cardsUpdated }
}
