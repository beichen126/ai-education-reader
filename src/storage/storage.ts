import { idbGet, idbGetAll, idbGetAllKeys, idbPut, idbDelete, idbGetAllByIndex, idbDeleteByIndex, idbBatchPut, idbBatchDelete, idbClearAll, idbRunTxn } from './idb'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import type { StoredBinary } from './binary-store'

// Persisted attachment row (Stage 9.4D). Blob bytes live in OPFS-first storage via
// a StoredBinary reference (binary); legacy rows carry a Blob inline (blob).
export type StoredAttachmentRow = { id: string; meta: Attachment; binary?: StoredBinary; blob?: Blob; recordVersion?: 2 }

import { clearOpfsAppRoot } from './binary-store'

// Destructive: clear conversations/attachments/annotations/settings/documents (all stores).
// IDB is cleared FIRST (metadata), THEN the OPFS app root is deleted. A partial OPFS
// failure returns `partialCleanup:true` so the UI can say retry — IDB is already empty, and
// the next clear re-attempts the OPFS cleanup even though nothing is left in IDB.
export async function clearAllLocalData(): Promise<{ partialCleanup: boolean; failedPaths: string[] }> {
  await idbClearAll()
  try {
    const r = await clearOpfsAppRoot()
    return r.completed ? { partialCleanup: false, failedPaths: [] } : { partialCleanup: true, failedPaths: r.failedPaths }
  } catch (e) {
    return { partialCleanup: true, failedPaths: [] }
  }
}

export async function getSetting(key: string): Promise<any> { const row = await idbGet('settings', key); return row ? row.value : undefined }
export async function setSetting(key: string, value: any): Promise<void> { await idbPut('settings', { key, value }) }
export async function deleteSetting(key: string): Promise<void> { await idbDelete('settings', key) }
export async function getConversation(id: string): Promise<any> { return idbGet('conversations', id) }
export async function listConversations(): Promise<any[]> { const all = await idbGetAll('conversations'); return all.sort((a, b) => b.updatedAt - a.updatedAt) }
export async function saveConversation(conv: any): Promise<void> { await idbPut('conversations', conv) }
export async function deleteConversation(id: string): Promise<void> { await idbDelete('conversations', id) }

/** The durable settings key holding the last-active conversation id. */
export const LAST_CONVERSATION_ID_KEY = 'lastConversationId'

/**
 * Atomically ACCEPT a user message into a conversation: in ONE IndexedDB
 * readwrite transaction spanning the conversations + settings stores we:
 *   1. put the updated Conversation (with the new user message);
 *   2. put lastConversationId;
 *   3. delete the draft:<conversationId> setting row (the accepted content must no
 *      longer be considered unsent).
 * The promise resolves ONLY when the transaction commits, so there is never a
 * durable state where only some of these three acceptance operations landed.
 * On failure nothing commits and the caller keeps its Draft intact.
 */
export async function commitAcceptedUserMessage(conv: any, lastConversationId: string, draftKey: string | null): Promise<void> {
  await idbRunTxn(['conversations', 'settings'], (txn) => {
    txn.objectStore('conversations').put(conv)
    txn.objectStore('settings').put({ key: LAST_CONVERSATION_ID_KEY, value: lastConversationId })
    if (draftKey) txn.objectStore('settings').delete(draftKey)
  })
}

/**
 * Atomically persist ALL settings keys in ONE readwrite transaction (P1). A partial
 * failure can no longer leave a mixed configuration after reload (e.g. apiKey committed
 * but model not). Values commit first, then the caller publishes them as saved state.
 */
export async function saveSettingsAtomic(values: { apiBaseUrl: string; apiKey: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: string; appearance: string; visionCapability: string }): Promise<void> {
  await idbRunTxn(['settings'], (txn) => {
    const os = txn.objectStore('settings')
    os.put({ key: 'apiBaseUrl', value: values.apiBaseUrl })
    os.put({ key: 'apiKey', value: values.apiKey })
    os.put({ key: 'model', value: values.model })
    os.put({ key: 'customSystemPrompt', value: values.customSystemPrompt })
    os.put({ key: 'customSystemPromptEnabled', value: values.customSystemPromptEnabled })
    os.put({ key: 'appearance', value: values.appearance })
    os.put({ key: 'visionCapability', value: values.visionCapability })
  })
}

// Legacy-inline seeding helpers (used by tests to set up legacy rows, and available for
// callers that explicitly want an inline IndexedDB Blob). The attachment-service ALWAYS
// writes an OPFS-first StoredBinary ref via saveAttachmentRows — it never uses these.
// Legacy row shape: { id, meta, blob } (recordVersion undefined) — migratable to OPFS.
export async function saveAttachment(meta: Attachment, blob: Blob): Promise<void> { await idbPut('attachments', { id: meta.id, meta, blob }) }
export async function saveAttachments(metas: Attachment[], blobs: Blob[]): Promise<void> { await idbBatchPut('attachments', metas.map((m, i) => ({ id: m.id, meta: m, blob: blobs[i] }))) }
export async function saveAttachmentRow(row: StoredAttachmentRow): Promise<void> { await idbPut('attachments', row) }
export async function saveAttachmentRows(rows: StoredAttachmentRow[]): Promise<void> { await idbBatchPut('attachments', rows) }
export async function getAttachmentRow(id: string): Promise<StoredAttachmentRow | undefined> { return idbGet('attachments', id) }
export async function getAttachmentRows(ids: string[]): Promise<(StoredAttachmentRow | undefined)[]> { const out: any[] = []; for (const id of ids) out.push(await idbGet('attachments', id)); return out }
export async function deleteAttachment(id: string): Promise<void> { await idbDelete('attachments', id) }
export async function attachmentExists(id: string): Promise<boolean> { return !!(await idbGet('attachments', id)) }
export async function listAllAttachmentRows(): Promise<StoredAttachmentRow[]> { return idbGetAll('attachments') }

// annotations: independent store, keyed by id
export async function saveAnnotation(ann: any): Promise<void> { await idbPut('annotations', ann) }
export async function saveAnnotations(anns: any[]): Promise<void> { await idbBatchPut('annotations', anns) }
export async function getAnnotationsByMessage(conversationId: string, messageId: string): Promise<any[]> { return idbGetAllByIndex('annotations', 'by_conversation_message', [conversationId, messageId]) }
export async function getAnnotationsByConversation(conversationId: string): Promise<any[]> { return idbGetAllByIndex('annotations', 'by_conversation', conversationId) }
export async function deleteAnnotationsByIds(ids: string[]): Promise<void> { await idbBatchDelete('annotations', ids) }
export async function deleteConversationAnnotations(conversationId: string): Promise<void> { await idbDeleteByIndex('annotations', 'by_conversation', conversationId) }