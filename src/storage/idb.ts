const DB_NAME = 'ai-education-reader'
const DB_VERSION = 3
const STORES = ['settings', 'conversations', 'attachments', 'annotations'] as const

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
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
    }
    req.onsuccess = () => resolve(req.result)
    // A rejected open must not stay cached forever: reset so a later call can retry.
    req.onerror = () => { dbPromise = null; reject(req.error) }
    // A blocked upgrade retried on next call rather than leaving a dangling pending open.
    req.onblocked = () => { dbPromise = null }
  })
  return dbPromise
}
function asPromise(req: IDBRequest<any>): Promise<any> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) }) }
function tx(db: IDBDatabase, name: string, mode: IDBTransactionMode) { return db.transaction(name, mode).objectStore(name) }
export async function idbGet(store: string, key: any): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').get(key)) }
export async function idbGetAll(store: string): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').getAll()) }
export async function idbGetAllKeys(store: string): Promise<any> { const db = await openDb(); return asPromise(tx(db, store, 'readonly').getAllKeys()) }
export async function idbPut(store: string, value: any): Promise<void> { const db = await openDb(); await asPromise(tx(db, store, 'readwrite').put(value)) }
export async function idbDelete(store: string, key: any): Promise<void> { const db = await openDb(); await asPromise(tx(db, store, 'readwrite').delete(key)) }
export async function idbGetAllByIndex(store: string, index: string, key: any): Promise<any> {
  const db = await openDb(); const os = tx(db, store, 'readonly'); return asPromise(os.index(index).getAll(key))
}
/** Walk every row of a store with a cursor (one row in flight, never the whole store in
 * memory). Used by the read-only storage diagnostics scan. */
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
export async function idbDeleteByIndex(store: string, index: string, key: any): Promise<void> {
  const db = await openDb(); const os = tx(db, store, 'readwrite')
  const keys = await asPromise(os.index(index).getAllKeys(key))
  for (const k of keys) await asPromise(os.delete(k))
}
export async function idbBatchPut(store: string, values: any[]): Promise<void> { const db = await openDb(); const os = tx(db, store, 'readwrite'); for (const v of values) await asPromise(os.put(v)) }
export async function idbBatchDelete(store: string, keys: any[]): Promise<void> { const db = await openDb(); const os = tx(db, store, 'readwrite'); for (const k of keys) await asPromise(os.delete(k)) }
/** Clear EVERY store in one readwrite transaction (destructive: used by "clear local data"). */
export async function idbClearAll(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(STORES, 'readwrite')
    for (const s of STORES) txn.objectStore(s).clear()
    txn.oncomplete = () => resolve(undefined)
    txn.onerror = () => reject(txn.error)
    txn.onabort = () => reject(txn.error)
  })
}

export async function closeDb(): Promise<void> { if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = null } }
export async function idbReplaceAll(records: { settings: any[]; conversations: any[]; attachments: any[]; annotations: any[] }): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(['settings', 'conversations', 'attachments', 'annotations'], 'readwrite')
    const stores = ['settings', 'conversations', 'attachments', 'annotations'] as const
    for (const s of stores) txn.objectStore(s).clear()
    const put = (store: string, vals: any[]) => { const os = txn.objectStore(store); for (const v of vals) os.put(v) }
    put('settings', records.settings)
    put('conversations', records.conversations)
    put('attachments', records.attachments)
    put('annotations', records.annotations)
    txn.oncomplete = () => resolve(undefined)
    txn.onerror = () => reject(txn.error)
    txn.onabort = () => reject(txn.error)
  })
}
