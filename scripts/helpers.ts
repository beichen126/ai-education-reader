
export async function openV2() {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('dsh-eink-client', 2); r.onupgradeneeded = () => { const d = r.result; if(!d.objectStoreNames.contains('settings')) d.createObjectStore('settings',{keyPath:'key'}); if(!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations',{keyPath:'id'}); if(!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments',{keyPath:'id'}) }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error) })
  db.close(); return db
}
export { }
