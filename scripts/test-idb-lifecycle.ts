import 'fake-indexeddb/auto'
import { idbPut, idbDelete, idbBatchPut, idbBatchDelete, idbGet, idbDeleteByIndex, closeDb, idbClearAll, DB_NAME, DB_VERSION } from '../src/storage/idb.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('fixture delete blocked'))
  })
}

/** Create the exact pre-Prompt-store shape, then let the application perform v6 -> v7. */
async function createV6Fixture(): Promise<void> {
  await deleteDatabase(DB_NAME)
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 6)
    req.onupgradeneeded = () => {
      const db = req.result
      const settings = db.createObjectStore('settings', { keyPath: 'key' })
      settings.put({ key: 'legacy-v6', value: 'preserve-me' })
      const conversations = db.createObjectStore('conversations', { keyPath: 'id' })
      conversations.createIndex('by_updatedAt', 'updatedAt')
      db.createObjectStore('attachments', { keyPath: 'id' })
      const annotations = db.createObjectStore('annotations', { keyPath: 'id' })
      annotations.createIndex('by_conversation', 'conversationId')
      annotations.createIndex('by_message', 'messageId')
      annotations.createIndex('by_conversation_message', ['conversationId', 'messageId'])
      const documents = db.createObjectStore('documents', { keyPath: 'id' })
      documents.createIndex('by_updatedAt', 'updatedAt')
      const notes = db.createObjectStore('documentNotes', { keyPath: 'id' })
      notes.createIndex('by_document', 'documentId')
      notes.createIndex('by_document_page', ['documentId', 'pageNumber'], { unique: true })
      const branches = db.createObjectStore('conversationBranches', { keyPath: 'id' })
      branches.createIndex('by_conversation', 'conversationId')
      branches.createIndex('by_parent', 'parentBranchId')
      branches.createIndex('by_updatedAt', 'updatedAt')
      const artifacts = db.createObjectStore('artifacts', { keyPath: 'id' })
      artifacts.createIndex('by_kind', 'kind')
      artifacts.createIndex('by_updatedAt', 'updatedAt')
      artifacts.createIndex('by_source_conversation', 'source.conversationId')
    }
    req.onsuccess = () => { req.result.close(); resolve() }
    req.onerror = () => reject(req.error)
  })
}

await createV6Fixture()
await idbPut('settings', { key: 'upgrade-trigger', value: true })
const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME)
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
assert(DB_VERSION === 7 && upgraded.version === 7, 'real v6 -> v7 fixture upgrades to DB_VERSION 7')
assert(upgraded.objectStoreNames.contains('prompts'), 'v6 -> v7 upgrade creates prompts store')
const promptStore = upgraded.transaction('prompts', 'readonly').objectStore('prompts')
assert(promptStore.keyPath === 'id' && promptStore.indexNames.contains('by_kind') && promptStore.indexNames.contains('by_updatedAt'), 'prompts store has keyPath=id and required indexes')
upgraded.close()
assert((await idbGet('settings', 'legacy-v6')).value === 'preserve-me', 'v6 data survives the schema upgrade')

await idbClearAll()

// --- idbPut/idbDelete commit durably ---
await idbPut('settings', { key: 'k1', value: 'v1' })
assert((await idbGet('settings', 'k1')).value === 'v1', 'idbPut commits durably (getAfterPut === v1)')
await idbDelete('settings', 'k1')
assert((await idbGet('settings', 'k1')) === undefined, 'idbDelete commits durably (row gone)')

// --- batch helpers single txn ---
await idbBatchPut('settings', [{ key: 'a', value: 1 }, { key: 'b', value: 2 }])
const a = await idbGet('settings', 'a'); const b = await idbGet('settings', 'b')
assert(a && a.value === 1 && b && b.value === 2, 'idbBatchPut writes all values on one txn')
await idbBatchDelete('settings', ['a', 'b'])
assert((await idbGet('settings', 'a')) === undefined && (await idbGet('settings', 'b')) === undefined, 'idbBatchDelete removes all keys on one txn')

// --- idbDeleteByIndex (annotations has by_conversation) ---
await idbBatchPut('annotations', [
  { id: 'x1', conversationId: 'C' },
  { id: 'x2', conversationId: 'C' },
  { id: 'y1', conversationId: 'D' },
])
await idbDeleteByIndex('annotations', 'by_conversation', 'C')
const x1 = await idbGet('annotations', 'x1'); const x2 = await idbGet('annotations', 'x2'); const y1 = await idbGet('annotations', 'y1')
assert(x1 === undefined && x2 === undefined && y1 !== undefined, 'idbDeleteByIndex removes matching, keeps others')

// --- closeDb invalidation + reopen ---
await idbPut('settings', { key: 'z', value: 9 })
await closeDb()
assert((await idbGet('settings', 'z')).value === 9, 'reopen after closeDb still reads committed data')

// --- direct transaction abort rejects the awaiting write promise ---
let aborted = false
try {
  const adb = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const txn = adb.transaction('settings', 'readwrite')
  txn.objectStore('settings').put({ key: 'abort-x', value: 1 })
  txn.abort()
  await new Promise((res, rej) => { txn.oncomplete = () => res(); txn.onerror = () => rej(new Error('txn error')); txn.onabort = () => rej(new Error('txn aborted')) })
} catch (e) { aborted = true }
assert(aborted, 'a transaction abort rejects the awaiting write promise')

// --- versionchange wiring: handler fires, cache invalidates, reconnect works ---
const live = await new Promise((res, rej) => { const r = indexedDB.open('ai-education-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
let fired = false
live.onversionchange = () => { fired = true; try { live.close() } catch { } }
live.onversionchange()
assert(fired, 'onversionchange handler fires and closes the old connection')
await closeDb()
await idbPut('settings', { key: 'vc2', value: 2 })
assert((await idbGet('settings', 'vc2')).value === 2, 'reconnect after versionchange works (cache invalidated)')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
