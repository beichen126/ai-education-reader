export const DB_NAME = 'ai-education-reader'
export const DB_VERSION = 7
export const STORES = ['settings', 'conversations', 'attachments', 'annotations', 'documents', 'documentNotes', 'conversationBranches', 'artifacts', 'prompts'] as const

let dbPromise: Promise<IDBDatabase> | null = null

/** Recoverable error surfaced when a schema upgrade is blocked or the open fails.
 *  The app can catch this, show a retry, and call openDb() again. */
export class IdbOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'IdbOpenError' }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' })
      let ann = db.objectStoreNames.contains('annotations') ? req.transaction!.objectStore('annotations') : db.createObjectStore('annotations', { keyPath: 'id' })
      if (!ann.indexNames.contains('by_conversation')) ann.createIndex('by_conversation', 'conversationId')
      if (!ann.indexNames.contains('by_message')) ann.createIndex('by_message', 'messageId')
      if (!ann.indexNames.contains('by_conversation_message')) ann.createIndex('by_conversation_message', ['conversationId', 'messageId'])
      const conv = req.transaction!.objectStore('conversations')
      if (!conv.indexNames.contains('by_updatedAt')) conv.createIndex('by_updatedAt', 'updatedAt')
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' })
      const docs = req.transaction!.objectStore('documents')
      if (!docs.indexNames.contains('by_updatedAt')) docs.createIndex('by_updatedAt', 'updatedAt')
      if (!db.objectStoreNames.contains('documentNotes')) db.createObjectStore('documentNotes', { keyPath: 'id' })
      const notes = req.transaction!.objectStore('documentNotes')
      if (!notes.indexNames.contains('by_document')) notes.createIndex('by_document', 'documentId')
      if (!notes.indexNames.contains('by_document_page')) notes.createIndex('by_document_page', ['documentId', 'pageNumber'], { unique: true })
      // Branch + Artifact stores (post-v1 feature line). Store creation is guarded so an
      // upgrade from a DB that already has them (e.g. after a re-run) is a no-op.
      if (!db.objectStoreNames.contains('conversationBranches')) db.createObjectStore('conversationBranches', { keyPath: 'id' })
      const cb = req.transaction!.objectStore('conversationBranches')
      if (!cb.indexNames.contains('by_conversation')) cb.createIndex('by_conversation', 'conversationId')
      if (!cb.indexNames.contains('by_parent')) cb.createIndex('by_parent', 'parentBranchId')
      if (!cb.indexNames.contains('by_updatedAt')) cb.createIndex('by_updatedAt', 'updatedAt')
      if (!db.objectStoreNames.contains('artifacts')) db.createObjectStore('artifacts', { keyPath: 'id' })
      const art = req.transaction!.objectStore('artifacts')
      if (!art.indexNames.contains('by_kind')) art.createIndex('by_kind', 'kind')
      if (!art.indexNames.contains('by_updatedAt')) art.createIndex('by_updatedAt', 'updatedAt')
      if (!art.indexNames.contains('by_source_conversation')) art.createIndex('by_source_conversation', 'source.conversationId')
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' })
      const prompts = req.transaction!.objectStore('prompts')
      if (!prompts.indexNames.contains('by_kind')) prompts.createIndex('by_kind', 'kind')
      if (!prompts.indexNames.contains('by_updatedAt')) prompts.createIndex('by_updatedAt', 'updatedAt')
    }
    req.onsuccess = () => {
      const db = req.result
      // When a NEWER app version opens the DB, this old tab must release its
      // connection and invalidate the cache so a later call re-opens at the new version.
      db.onversionchange = () => { try { db.close() } catch { /* ignore */ }; if (dbPromise) dbPromise = null }
      settle(() => resolve(db))
    }
    req.onerror = () => {
      // A rejected open must not stay cached forever: reset so a later call can retry.
      dbPromise = null
      settle(() => reject(req.error))
    }
    req.onblocked = () => {
      // A blocked upgrade (another tab still holds an old version) must settle the
      // open deterministically instead of leaving it pending forever. Clear the cache
      // so a later retry can attempt the open again once the old tab releases.
      dbPromise = null
      settle(() => reject(new IdbOpenError('IndexedDB 版本升级被其他页面阻塞，请关闭其它标签页后重试。')))
    }
  })
  return dbPromise
}

function asPromise(req: IDBRequest<any>): Promise<any> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) }) }
function tx(db: IDBDatabase, name: string, mode: IDBTransactionMode) { return db.transaction(name, mode).objectStore(name) }

/** Resolve only when a readwrite transaction COMMITS; reject on error/abort.
 *  Request success is NOT the same as transaction commit — a write is only durable
 *  after oncomplete. Awaiting this primitive guarantees the write is truly committed. */
function txnDone(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const settle = (fn: () => void) => { if (!done) { done = true; fn() } }
    txn.oncomplete = () => settle(resolve)
    txn.onerror = (e) => settle(() => reject((e as any).target?.error || new Error('transaction error')))
    txn.onabort = () => settle(() => reject(new Error('transaction aborted')))
  })
}

export async function idbGet(store: string, key: any): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').get(key)) }
export async function idbGetAll(store: string): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').getAll()) }
export async function idbGetAllKeys(store: string): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').getAllKeys()) }
/** idbPut resolves only after the write transaction commits. */
export async function idbPut(store: string, value: any): Promise<void> { const db = await openDb(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(value); await txnDone(t) }
/** idbDelete resolves only after the delete transaction commits. */
export async function idbDelete(store: string, key: any): Promise<void> { const db = await openDb(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); await txnDone(t) }
export async function idbGetAllByIndex(store: string, index: string, key: any): Promise<any> {
  const db = await openDb(); const os = tx(db, store, 'readonly'); return asPromise(os.index(index).getAll(key))
}
/** Walk every row of a store with a cursor (one row in flight, never the whole store in memory). */
export async function idbScan(store: string, onRow: (row: any) => void): Promise<void> {
  const db = await openDb(); const os = tx(db, store, 'readonly')
  await new Promise<void>((resolve, reject) => {
    const req = os.openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (cur) { try { onRow(cur.value) } catch { /* never fail diagnostics on a bad row */ } cur.continue() }
      else resolve(undefined)
    }
    req.onerror = () => reject(req.error)
  })
}
/** Delete all rows matching an index value; resolves only after the transaction commits. */
/** Delete all rows matching an index value; ONE readwrite transaction, resolves on commit. */
export async function idbDeleteByIndex(store: string, index: string, key: any): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(store, 'readwrite')
  const os = txn.objectStore(store)
  const indexKeys = await asPromise(os.index(index).getAllKeys(key))
  // The getAllKeys request is part of txn; the deletes must also be in the same txn.
  for (const k of indexKeys) os.delete(k)
  await txnDone(txn)
}
/** idbBatchPut: ONE readwrite transaction for all values; resolves on commit. */
export async function idbBatchPut(store: string, values: any[]): Promise<void> {
  const db = await openDb(); const txn = db.transaction(store, 'readwrite'); const os = txn.objectStore(store)
  for (const v of values) os.put(v)
  await txnDone(txn)
}
/** idbBatchDelete: ONE readwrite transaction for all keys; resolves on commit. */
export async function idbBatchDelete(store: string, keys: any[]): Promise<void> {
  const db = await openDb(); const txn = db.transaction(store, 'readwrite'); const os = txn.objectStore(store)
  for (const k of keys) os.delete(k)
  await txnDone(txn)
}

/**
 * Atomically upsert a document-owned page note. The document existence check and
 * note write/delete share one transaction, so a note save cannot race a document
 * deletion into recreating an orphan row.
 *
 * `undefined` means the document no longer exists (or the content was blank).
 * An existing orphan row is removed as part of the same transaction.
 */
export async function idbSaveDocumentNote(documentId: string, noteId: string, pageNumber: number, content: string, now: number): Promise<any | undefined> {
  const db = await openDb()
  const txn = db.transaction(['documents', 'documentNotes'], 'readwrite')
  const documents = txn.objectStore('documents')
  const notes = txn.objectStore('documentNotes')
  const documentReq = documents.get(documentId)
  const noteReq = notes.get(noteId)
  let documentRow: any = undefined
  let existing: any = undefined
  let documentReady = false
  let noteReady = false
  let result: any | undefined

  return new Promise<any | undefined>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const apply = () => {
      if (!documentReady || !noteReady || settled) return
      if (!documentRow || !content.trim()) {
        if (existing) notes.delete(existing.id)
        return
      }
      result = {
        id: existing?.id ?? noteId,
        documentId,
        pageNumber,
        content,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      notes.put(result)
    }
    documentReq.onsuccess = () => { documentRow = documentReq.result; documentReady = true; apply() }
    documentReq.onerror = () => fail(documentReq.error)
    noteReq.onsuccess = () => { existing = noteReq.result; noteReady = true; apply() }
    noteReq.onerror = () => fail(noteReq.error)
    txn.oncomplete = () => { if (!settled) { settled = true; resolve(result) } }
    txn.onerror = () => fail(txn.error)
    txn.onabort = () => fail(new Error('transaction aborted'))
  })
}

/**
 * Atomic read-modify-write on ONE readwrite transaction: get(key) -> updater(current)
 * -> put(next), all in the same transaction. No read/write split can happen, so
 * concurrent updates of DIFFERENT fields never lose each other (no stale snapshot).
 * - row missing -> the transaction aborts and this rejects (caller decides).
 * - updater throws -> the transaction aborts and this rejects.
 */
export async function idbUpdate(store: string, key: any, updater: (current: any) => any): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(store, 'readwrite')
  const os = txn.objectStore(store)
  const req = os.get(key)
  await new Promise<void>((resolve, reject) => {
    let done = false
    const fail = (e: unknown) => { if (!done) { done = true; try { txn.abort() } catch { /* already settled */ } reject(e) } }
    req.onsuccess = () => {
      const cur = req.result
      if (cur === undefined) { fail(new Error('row not found: ' + store + '/' + String(key))); return }
      let next: any
      try { next = updater(cur) } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); return }
      try { os.put(next) } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); return }
    }
    req.onerror = () => fail(req.error)
    txn.oncomplete = () => { if (!done) { done = true; resolve(undefined) } }
    txn.onerror = () => fail(txn.error)
    txn.onabort = () => fail(new Error('transaction aborted'))
  })
}
/**
 * Run a multi-store readwrite transaction atomically. `fn(txn)` issues all requests;
 * the returned promise resolves only when the transaction COMMITS and rejects on
 * error/abort. Lets callers compose atomic operations across stores (e.g. put a
 * conversation + put lastConversationId + delete a draft in ONE durable commit). */
export async function idbRunTxn(storeNames: string[], fn: (txn: IDBTransaction) => void): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(storeNames, 'readwrite')
  fn(txn)
  await txnDone(txn)
}

/** Atomically remove a Document and every page note owned by it. */
export async function idbDeleteDocumentAndNotes(documentId: string): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(['documents', 'documentNotes'], 'readwrite')
  txn.objectStore('documents').delete(documentId)
  const index = txn.objectStore('documentNotes').index('by_document')
  const cursorReq = index.openCursor(IDBKeyRange.only(documentId))
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) return
    txn.objectStore('documentNotes').delete(cursor.primaryKey)
    cursor.continue()
  }
  await txnDone(txn)
}

/** Clear EVERY store in one readwrite transaction (destructive: used by clear local data). */
export async function idbClearAll(): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(STORES, 'readwrite')
  for (const s of STORES) txn.objectStore(s).clear()
  await txnDone(txn)
}

export async function closeDb(): Promise<void> { if (dbPromise) { const db = await dbPromise; try { db.close() } catch { /* ignore */ } dbPromise = null } }
export async function idbReplaceAll(records: { settings: any[]; conversations: any[]; attachments: any[]; annotations: any[]; documents?: any[]; documentNotes?: any[]; conversationBranches?: any[]; artifacts?: any[]; prompts?: any[] }): Promise<void> {
  const db = await openDb()
  const txn = db.transaction(STORES, 'readwrite')
  const stores = STORES
  for (const s of stores) txn.objectStore(s).clear()
  const put = (store: string, vals: any[]) => { const os = txn.objectStore(store); for (const v of vals) os.put(v) }
  put('settings', records.settings)
  put('conversations', records.conversations)
  put('attachments', records.attachments)
  put('annotations', records.annotations)
  if (records.documents) put('documents', records.documents)
  if (records.documentNotes) put('documentNotes', records.documentNotes)
  if (records.conversationBranches) put('conversationBranches', records.conversationBranches)
  if (records.artifacts) put('artifacts', records.artifacts)
  if (records.prompts) put('prompts', records.prompts)
  await txnDone(txn)
}
