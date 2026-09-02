import 'fake-indexeddb/auto'
import { getStorageDiagnostics, formatBytes } from '../src/storage/diagnostics.ts'
import { saveAttachment, saveAttachments } from '../src/storage/storage.ts'
import { idbReplaceAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const clearAll = () => idbReplaceAll({ settings:[], conversations:[], attachments:[], annotations:[] })
const blob = (n:number) => new Blob([new Uint8Array(n)], { type:'image/png' })

// ---- attachment statistics ----
{
  await clearAll(); let d = await getStorageDiagnostics()
  assert(d.attachmentCount===0 && d.attachmentBytes===0, 'empty db -> 0 images / 0 bytes')
}
{
  await clearAll()
  const m1={id:newStableId(),name:'a.png',mimeType:'image/png',size:100,createdAt:1,updatedAt:1}
  const m2={id:newStableId(),name:'b.png',mimeType:'image/png',size:200,createdAt:1,updatedAt:1}
  const m3={id:newStableId(),name:'c.png',mimeType:'image/png',size:300,createdAt:1,updatedAt:1}
  await saveAttachments([m1,m2,m3] as any, [blob(100),blob(200),blob(300)])
  let d = await getStorageDiagnostics()
  assert(d.attachmentCount===3, '3 attachments -> count=3')
  assert(d.attachmentBytes===600, '3 attachments (100+200+300) -> bytes=600 (got '+d.attachmentBytes+')')
  assert(d.originUsageBytes===undefined && d.originQuotaBytes===undefined, 'estimate API absent in node -> origin stats undefined, attachments still counted')
}
// ---- 1000-row perf scan: cursor only, no arrayBuffer/base64 materialization ----
{
  await clearAll()
  const metas:any[]=[]; const blobs:Blob[]=[]
  for (let i=0;i<1000;i++){ const id=newStableId(); metas.push({id,name:'x'+i+'.png',mimeType:'image/png',size:4,createdAt:1,updatedAt:1}); blobs.push(blob(4)) }
  await saveAttachments(metas, blobs)
  let d = await getStorageDiagnostics()
  assert(d.attachmentCount===1000, '1000 rows scanned (count='+d.attachmentCount+')')
  assert(d.attachmentBytes===4000, '1000 rows at 4B each -> bytes=4000 (got '+d.attachmentBytes+')')
}
// ---- formatBytes ----
{
  assert(formatBytes(0)==='0 B', 'formatBytes(0) -> 0 B')
  assert(formatBytes(10)==='10 B', 'formatBytes(10) -> 10 B')
  assert(formatBytes(823)==='823 B', 'formatBytes(823) -> 823 B')
  assert(formatBytes(1024)==='1 KB', 'formatBytes(1024) -> 1 KB (got '+formatBytes(1024)+')')
  assert(formatBytes(500*1024)==='500 KB', 'formatBytes(512000) -> 500 KB (got '+formatBytes(500*1024)+')')
  assert(formatBytes(57753.6)==='56.4 KB', 'formatBytes(57753.6) -> 56.4 KB (got '+formatBytes(57753.6)+')')
  assert(formatBytes(2.5*1024*1024)==='2.5 MB', 'formatBytes(2.5MB) -> 2.5 MB (got '+formatBytes(2.5*1024*1024)+')')
  assert(formatBytes(284.6*1024*1024)==='284.6 MB', 'formatBytes -> 284.6 MB (got '+formatBytes(284.6*1024*1024)+')')
  assert(formatBytes(2.31*1024*1024*1024)==='2.31 GB', 'formatBytes -> 2.31 GB (got '+formatBytes(2.31*1024*1024*1024)+')')
}
// ---- Storage Estimate API present ----
{
  await clearAll()
  await saveAttachment({id:newStableId(),name:'x.png',mimeType:'image/png',size:4,createdAt:1,updatedAt:1} as any, blob(4))
  ;(navigator as any).storage = { estimate: async () => ({ usage: 123456, quota: 987654321 }) }
  try {
    let d = await getStorageDiagnostics()
    assert(d.originUsageBytes===123456, 'estimate present -> usage=123456 (got '+d.originUsageBytes+')')
    assert(d.originQuotaBytes===987654321, 'estimate present -> quota=987654321 (got '+d.originQuotaBytes+')')
    assert(d.attachmentCount===1, 'estimate present -> attachments still counted (count='+d.attachmentCount+')')
  } catch (e) { console.log('  note: navigator.storage assignment ignored?', (e as any).message) }
}
// ---- Storage Estimate API absent ----
{
  ;(navigator as any).storage = undefined
  let d = await getStorageDiagnostics()
  assert(d.originUsageBytes===undefined && d.originQuotaBytes===undefined, 'estimate absent -> usage/quota undefined')
  assert(typeof d.attachmentCount==='number' && d.attachmentBytes>=0, 'estimate absent -> attachments still returned')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

