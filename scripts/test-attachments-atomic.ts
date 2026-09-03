import 'fake-indexeddb/auto'
import { saveFiles, isSupportedImage, MAX_IMAGE_BYTES } from '../src/engine/attachment-service.ts'
import { saveAttachment, getAttachmentRow } from '../src/storage/storage.ts'
import { idbGetAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
async function mkFile(name: string, type: string, bytes: number[]): Promise<File> { return new File([new Uint8Array(bytes)], name, { type }) }
async function allIds(): Promise<string[]> { const rows = await idbGetAll('attachments'); return (rows || []).map((r:any)=>r.id) }

// 1) A batch that contains ONE invalid file must NOT persist the earlier valid files (no orphans).
{
  const before = (await allIds()).length
  const ok1 = await mkFile('ok1.png','image/png',[1,2,3])
  const ok2 = await mkFile('ok2.jpg','image/jpeg',[4,5,6])
  const bad = await mkFile('bad.pdf','application/pdf',[7,8,9])
  let kind = ''
  try { await saveFiles([ok1, ok2, bad]) } catch(e){ kind = (e as any).kind }
  assert(kind === 'unsupported-format', 'batch with a pdf -> unsupported-format thrown')
  const after = (await allIds()).length
  assert(after === before, 'no orphan/blobs persisted for a rejected batch (count unchanged '+before+' -> '+after+')')
}

// 2) A batch with a too-large file is also all-or-nothing.
{
  const before = (await allIds()).length
  const ok1 = await mkFile('ok.png','image/png',[1,2,3])
  const big = await mkFile('big.png','image/png',new Array(MAX_IMAGE_BYTES+1).fill(0))
  let kind = ''
  try { await saveFiles([ok1, big]) } catch(e){ kind = (e as any).kind }
  assert(kind === 'image-too-large', 'oversized file -> image-too-large thrown')
  assert((await allIds()).length === before, 'oversized batch leaves no orphan')
}

// 3) A fully-valid batch persists all, and each is readable.
{
  const f1 = await mkFile('a.png','image/png',[137,80,78,71])
  const f2 = await mkFile('b.jpg','image/jpeg',[255,216,255])
  const atts = await saveFiles([f1, f2])
  assert(atts.length === 2, 'valid batch -> 2 attachments returned')
  for (const a of atts) { const row = await getAttachmentRow(a.id); assert(!!row && row.meta && ((row.binary && row.binary.storage === 'idb' && row.binary.blob instanceof Blob) || (row.binary && row.binary.storage === 'opfs') || row.blob instanceof Blob), 'attachment '+a.id+' persisted with binary') }
  assert((await allIds()).length >= 2, 'attachment rows exist for valid batch')
}

// 4) isSupportedImage guards still applied individually.
{
  assert(isSupportedImage({type:'image/png',size:1}), 'png supported')
  assert(!isSupportedImage({type:'image/png',size:0}), 'empty file rejected')
  assert(!isSupportedImage({type:'application/pdf',size:100}), 'pdf rejected')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
