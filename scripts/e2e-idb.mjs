// Shared browser IndexedDB helper for release E2E.
// The database is opened without a version so the helper follows the app's
// current schema and does not create an artificial migration path in tests.
export async function openAppDb(page, { store, operation = 'getAll', key, value } = {}) {
  if (!store) throw new TypeError('openAppDb requires a store name')
  return page.evaluate(async ({ store, operation, key, value }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-education-reader')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const write = operation === 'put'
      const transaction = db.transaction(store, write ? 'readwrite' : 'readonly')
      const objectStore = transaction.objectStore(store)
      const completion = write
        ? new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve(undefined)
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
          })
        : null
      const request = operation === 'get'
        ? objectStore.get(key)
        : operation === 'put'
          ? objectStore.put(value)
          : objectStore.getAll()
      const result = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (completion) await completion
      return result
    } finally {
      db.close()
    }
  }, { store, operation, key, value })
}
