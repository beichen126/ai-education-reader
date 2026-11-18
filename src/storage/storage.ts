import { idbGet, idbGetAll, idbGetAllKeys, idbPut, idbDelete, idbGetAllByIndex, idbDeleteByIndex, idbBatchPut, idbBatchDelete, idbClearAll, idbRunTxn } from './idb'
import { normalizeConversationPdfContexts, type Attachment, type Conversation, type DraftDisposition } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import type { StoredBinary } from './binary-store'
import { MAX_STUDY_CARD_TITLE_LENGTH } from '../study-cards/study-card-types'
import { clearReadingPositions } from '../engine/reading-position'

// Persisted attachment row (Stage 9.4D). Blob bytes live in OPFS-first storage via
// a StoredBinary reference (binary); legacy rows carry a Blob inline (blob).
export type StoredAttachmentRow = { id: string; meta: Attachment; binary?: StoredBinary; blob?: Blob; recordVersion?: 2 }

import { clearOpfsAppRoot } from './binary-store'

// Destructive: clear conversations/attachments/annotations/settings/documents (all stores).
// IDB is cleared FIRST (metadata), THEN the OPFS app root is deleted. A partial OPFS
// failure returns `partialCleanup:true` so the UI can say retry — IDB is already empty, and
// the next clear re-attempts the OPFS cleanup even though nothing is left in IDB.
export async function clearAllLocalData(): Promise<{ partialCleanup: boolean; failedPaths: string[] }> {
  const {stopReadAloud}=await import('../speech/read-aloud');stopReadAloud()
  const {clearSpeechCache}=await import('../speech/audio-cache');await clearSpeechCache()
  const {clearImageSearchRuntime}=await import('../web-images/search');await clearImageSearchRuntime()
  await idbClearAll()
  clearReadingPositions()
  try { if(typeof localStorage!=='undefined') for(const key of Object.keys(localStorage)) if(key.startsWith('dsh.genui.')) localStorage.removeItem(key) } catch { /* Storage may be unavailable in private mode. */ }
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
export async function getConversation(id: string): Promise<any> { const conv = await idbGet('conversations', id); return conv ? normalizeConversationPdfContexts(conv) : conv }
export async function listConversations(): Promise<any[]> { const all = await idbGetAll('conversations'); return all.map(normalizeConversationPdfContexts).sort((a, b) => b.updatedAt - a.updatedAt) }
/** Content writers preserve sidebar changes made after they loaded their conversation. */
function putConversation(store: IDBObjectStore, conversation: Conversation): void {
  const request = store.get(conversation.id)
  request.onsuccess = () => {
    const stored = request.result as Conversation | undefined
    store.put(stored ? { ...conversation, pinnedAt: stored.pinnedAt, archivedAt: stored.archivedAt } : conversation)
  }
}
export async function saveConversation(conv: Conversation): Promise<void> {
  const normalized = normalizeConversationPdfContexts(conv)
  await idbRunTxn(['conversations'], txn => putConversation(txn.objectStore('conversations'), normalized))
}
export async function deleteConversation(id: string): Promise<void> { await idbDelete('conversations', id) }

export type ConversationOrganizationAction = 'pin' | 'unpin' | 'archive' | 'restore'
export async function updateConversationOrganization(id: string, action: ConversationOrganizationAction): Promise<Pick<Conversation, 'pinnedAt' | 'archivedAt'> | undefined> {
  let result: Pick<Conversation, 'pinnedAt' | 'archivedAt'> | undefined
  await idbRunTxn(['conversations'], txn => {
    const store = txn.objectStore('conversations')
    const request = store.get(id)
    request.onsuccess = () => {
      const conversation = request.result as Conversation | undefined
      if (!conversation || (action === 'pin' && conversation.archivedAt !== undefined)) return
      const now = Date.now()
      result = {
        pinnedAt: action === 'pin' ? conversation.pinnedAt ?? now : action === 'unpin' || action === 'archive' ? undefined : conversation.pinnedAt,
        archivedAt: action === 'archive' ? conversation.archivedAt ?? now : action === 'restore' ? undefined : conversation.archivedAt,
      }
      store.put({ ...conversation, ...result })
    }
  })
  return result
}

/**
 * Persist a conversation rename and update its card metadata in the same transaction.
 * Auto-generated card titles follow the conversation name; titles explicitly edited by
 * the user stay untouched. Every card keeps the latest conversation name as its fallback
 * snapshot in case the source conversation is deleted later.
 */
export async function saveConversationRenameAndSyncCards(id: string, title: string, updatedAt: number): Promise<void> {
  await idbRunTxn(['conversations', 'studyCards'], txn => {
    const conversations = txn.objectStore('conversations')
    const lookup = conversations.get(id)
    lookup.onsuccess = () => {
      const conversation = lookup.result
      if (conversation) conversations.put({ ...conversation, title, titleManuallySet: true, updatedAt: Math.max(conversation.updatedAt, updatedAt) })
    }
    const cards = txn.objectStore('studyCards')
    const request = cards.index('by_source_conversation').openCursor(IDBKeyRange.only(id))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const current = cursor.value as any
      const source = current && typeof current.source === 'object' && current.source
        ? { ...current.source, conversationTitleSnapshot: title }
        : current.source
      const ordinal = current.autoTitleOrdinal
      const cardTitle = current.titleMode === 'auto' && Number.isInteger(ordinal) && ordinal >= 1
        ? (title + '-' + ordinal).slice(0, MAX_STUDY_CARD_TITLE_LENGTH)
        : current.title
      const changed = cardTitle !== current.title || source?.conversationTitleSnapshot !== current.source?.conversationTitleSnapshot
      if (changed) {
        const previousRevision = Number.isFinite(current.updatedAt) ? current.updatedAt : 0
        cursor.update({ ...current, title: cardTitle, source, updatedAt: Math.max(Date.now(), previousRevision + 1) })
      }
      cursor.continue()
    }
  })
}

/** The durable settings key holding the last-active conversation id. */
export const LAST_CONVERSATION_ID_KEY = 'lastConversationId'

/**
 * Atomically ACCEPT a user message into a conversation: in ONE IndexedDB
 * readwrite transaction spanning the conversations + settings stores we:
 *   1. put the updated Conversation (with the new user message and any frozen
 *      prompt transition);
 *   2. put lastConversationId;
 *   3. delete the draft:<conversationId> setting row when draftDisposition is 'clear'.
 *      A durable quick follow-up explicitly uses 'preserve' so the user's unrelated
 *      composer draft remains unsent and recoverable.
 * The promise resolves ONLY when the transaction commits, so there is never a
 * durable state where only some of these three acceptance operations landed.
 * On failure nothing commits and the caller keeps its Draft intact.
 */
export async function commitAcceptedUserMessage(conv: Conversation, lastConversationId: string, draftKey: string | null, draftDisposition: DraftDisposition = 'clear'): Promise<void> {
  const normalized = normalizeConversationPdfContexts(conv)
  await idbRunTxn(['conversations', 'settings'], (txn) => {
    putConversation(txn.objectStore('conversations'), normalized)
    txn.objectStore('settings').put({ key: LAST_CONVERSATION_ID_KEY, value: lastConversationId })
    if (draftKey && draftDisposition === 'clear') txn.objectStore('settings').delete(draftKey)
  })
}

/**
 * Atomically persist ALL settings keys in ONE readwrite transaction (P1). A partial
 * failure can no longer leave a mixed configuration after reload (e.g. apiKey committed
 * but model not). Values commit first, then the caller publishes them as saved state.
 */
export async function saveSettingsAtomic(values: { firecrawlApiKey?: string; firecrawlKeys?: {name: string; key: string}[]; apiProfiles?: string; activeApiProfileId?: string; userLocation?: string; userMetadataEnabled?: string; autoTitleEnabled?: string; readUrlEnabled?: string; nativeDeepSeekProxy?: string;  speechVoice?: string; speechApiUrl?: string; speechApiKey?: string; apiBaseUrl: string; apiKey: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: string; appearance: string; visionCapability: string; pdfNavigationMode: string; uiLanguage: string; webSearchEnabled?: string; firecrawlWebSearchEnabled?: string; deepseekWebSearchEnabled?: string; chineseSpeechRate?: string; englishSpeechRate?: string; speechRepeatCount?: string; speechLoop?: string; highlightSpokenSelection?: string; rememberReadingPosition?: string; chatProvider?: string; openaiLocalModel?: string }): Promise<void> {
  await idbRunTxn(['settings'], (txn) => {
    const os = txn.objectStore('settings')
    os.put({key: 'firecrawlApiKey', value: values.firecrawlApiKey || ''})
    os.put({key: 'firecrawlKeys', value: values.firecrawlKeys || []})
    os.put({ key: 'apiBaseUrl', value: values.apiBaseUrl })
    os.put({ key: 'apiKey', value: values.apiKey })
    os.put({ key: 'model', value: values.model })
    os.put({ key: 'customSystemPrompt', value: values.customSystemPrompt })
    os.put({ key: 'customSystemPromptEnabled', value: values.customSystemPromptEnabled })
    os.put({ key: 'appearance', value: values.appearance })
    os.put({ key: 'visionCapability', value: values.visionCapability })
    os.put({ key: 'pdfNavigationMode', value: values.pdfNavigationMode })
    os.put({ key: 'uiLanguage', value: values.uiLanguage })
    os.put({ key: 'webSearchEnabled', value: values.webSearchEnabled ?? 'false' })
    for (const key of ['firecrawlWebSearchEnabled', 'deepseekWebSearchEnabled'] as const) if (values[key] !== undefined) os.put({ key, value: values[key] })
    os.put({ key: 'chineseSpeechRate', value: values.chineseSpeechRate ?? '1' })
    os.put({ key: 'englishSpeechRate', value: values.englishSpeechRate ?? '0.9' })
    for (const key of ['apiProfiles', 'activeApiProfileId', 'speechVoice', 'speechApiUrl', 'speechApiKey', 'userLocation', 'userMetadataEnabled', 'autoTitleEnabled', 'readUrlEnabled', 'nativeDeepSeekProxy'] as const) if(values[key] !== undefined) os.put({key,value:values[key]})
    os.put({ key: 'speechLoop', value: values.speechLoop ?? 'false' })
    os.put({ key: 'highlightSpokenSelection', value: values.highlightSpokenSelection ?? 'false' })
    os.put({ key: 'speechRepeatCount', value: values.speechRepeatCount ?? '3' })
    os.put({ key: 'rememberReadingPosition', value: values.rememberReadingPosition ?? 'false' })
    if (values.chatProvider !== undefined) os.put({ key: 'chatProvider', value: values.chatProvider })
    if (values.openaiLocalModel !== undefined) os.put({ key: 'openaiLocalModel', value: values.openaiLocalModel })
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
