import { idbGet, idbGetAll, idbGetAllKeys, idbPut, idbDelete, idbGetAllByIndex, idbDeleteByIndex, idbBatchPut, idbBatchDelete, idbClearAll } from './idb'
import type { Attachment } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'

/** Destructive: clear conversations/attachments/annotations/settings/documents (all stores). */
export async function clearAllLocalData(): Promise<void> { await idbClearAll() }

export async function getSetting(key) { const row = await idbGet('settings', key); return row ? row.value : undefined }
export async function setSetting(key, value) { await idbPut('settings', { key, value }) }
export async function deleteSetting(key) { await idbDelete('settings', key) }
export async function getConversation(id) { return idbGet('conversations', id) }
export async function listConversations() { const all = await idbGetAll('conversations'); return all.sort((a, b) => b.updatedAt - a.updatedAt) }
export async function saveConversation(conv) { await idbPut('conversations', conv) }
export async function deleteConversation(id) { await idbDelete('conversations', id) }

export async function saveAttachment(a, blob) { await idbPut('attachments', { id: a.id, meta: a, blob }) }
/** Batch-write attachments in ONE readwrite transaction (all-or-nothing). */
export async function saveAttachments(metas, blobs) { await idbBatchPut('attachments', metas.map((m, i) => ({ id: m.id, meta: m, blob: blobs[i] }))) }
export async function getAttachmentRow(id) { return idbGet('attachments', id) }
export async function deleteAttachment(id) { await idbDelete('attachments', id) }
export async function attachmentExists(id) { return !!(await idbGet('attachments', id)) }

/* annotations: independent store, keyed by id */
export async function saveAnnotation(ann) { await idbPut('annotations', ann) }
export async function saveAnnotations(anns) { await idbBatchPut('annotations', anns) }
export async function getAnnotationsByMessage(conversationId, messageId) { return idbGetAllByIndex('annotations', 'by_conversation_message', [conversationId, messageId]) }
export async function getAnnotationsByConversation(conversationId) { return idbGetAllByIndex('annotations', 'by_conversation', conversationId) }
export async function deleteAnnotationsByIds(ids) { await idbBatchDelete('annotations', ids) }
export async function deleteConversationAnnotations(conversationId) { await idbDeleteByIndex('annotations', 'by_conversation', conversationId) }