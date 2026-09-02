
import 'fake-indexeddb/auto'
import { saveFiles, getAttachment, toDataUrl, deleteAttachment, existsAttachment, isSupportedImage, MAX_IMAGE_BYTES } from '../src/engine/attachment-service.ts'
import { getAttachmentRow } from '../src/storage/storage.ts'
import { buildApiMessages, isVisionModel, type ApiChatMessage } from '../src/api/deepseek.ts'
import { newStableId, type Message } from '../src/engine/types.ts'
import { closeDb } from '../src/storage/idb.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const enc = new TextEncoder()

async function mkFile(name: string, type: string, bytes: number[]): Promise<File> {
  return new File([new Uint8Array(bytes)], name, { type })
}

// case 9: MIME support
assert(isSupportedImage({type:'image/jpeg',size:5}), 'jpeg supported')
assert(isSupportedImage({type:'image/png',size:5}), 'png supported')
assert(isSupportedImage({type:'image/webp',size:5}), 'webp supported')
assert(isSupportedImage({type:'image/gif',size:5}), 'gif supported')
assert(!isSupportedImage({type:'application/pdf',size:5}), 'pdf not supported')
assert(!isSupportedImage({type:'image/jpeg',size:0}), 'empty file not supported')

// case 1+3: save files -> stable ids
const f1 = await mkFile('a.png', 'image/png', [137,80,78,71])
const f2 = await mkFile('b.jpg', 'image/jpeg', [255,216,255])
const atts = await saveFiles([f1, f2])
assert(atts.length === 2, 'two files saved')
assert(typeof atts[0].id === 'string' && atts[0].id.length > 10, 'attachment id stable (uuid)')
assert(atts[0].mimeType === 'image/png' && atts[1].mimeType === 'image/jpeg', 'mime captured')
const idA = atts[0].id, idB = atts[1].id

// case 8: toDataUrl correct
const du = await toDataUrl(idA)
assert(du.startsWith('data:image/png;base64,'), 'data url prefix correct')

// case 2: persist + reopen -> blob readable
await closeDb()
const row = await getAttachmentRow(idA)
assert(!!row, 'attachment row persists after reopen')
const buf = await (row!.blob as Blob).arrayBuffer()
assert(buf.byteLength === 4, 'blob byte length restored after reopen')
assert((await getAttachment(idA))!.id === idA, 'metadata id stable after reopen')

// case 10+12: buildApiMessages with ordered images -> text + image_url
const m: Message = { id: newStableId(), role: 'user', content: '解释这张图', images: [idA, idB], createdAt: 1, updatedAt: 1 }
const api = await buildApiMessages([m], toDataUrl)
const content = api[0].content as any[]
assert(Array.isArray(content), 'image message content is an array')
assert(content[0].type === 'text' && content[0].text === '解释这张图', 'text part first')
assert(content.filter((p:any)=>p.type==='image_url').length === 2, 'text + 2 image_url parts (order preserved, labels interleaved)')
const imgParts = content.filter((p:any)=>p.type==='image_url'); assert(imgParts[0].image_url.url.startsWith('data:image/png;base64,'), 'first image uses its own data url')
assert(imgParts[1].image_url.url.startsWith('data:image/jpeg;base64,'), 'second image uses its own data url')
assert(content.filter((p:any)=>p.type==='text').some((p:any)=>p.text==='【图片 1/2】') && content.some((p:any)=>p.type==='text' && p.text==='【图片 2/2】'), 'identity labels 【图片 k/2】 present')

// case 11: plain text stays string
const m2: Message = { id: newStableId(), role: 'user', content: '纯文本', images: [], createdAt: 1, updatedAt: 1 }
const api2 = await buildApiMessages([m2], toDataUrl)
assert(typeof api2[0].content === 'string' && api2[0].content === '纯文本', 'plain text message content stays string (no regression)')

// case 13: historical image message reconstructed
const m3: Message = { id: newStableId(), role: 'user', content: '追问', images: [idA], createdAt: 1, updatedAt: 1 }
const api3 = await buildApiMessages([m3], toDataUrl)
assert((api3[0].content as any[]).filter((p:any)=>p.type==='image_url').length === 1 && (api3[0].content as any[]).some((p:any)=>p.type==='text' && p.text==='【图片 1/1】'), 'historical image re-resolved in later turn (1 image + 1 label)')

// case 14: missing attachment -> clear error
const missingId = newStableId()
let missingErr = ''
try { await buildApiMessages([{ id: newStableId(), role: 'user', content: 'x', images: [missingId], createdAt: 1, updatedAt: 1 }], toDataUrl) } catch(e){ missingErr = (e as any).kind }
assert(missingErr === 'missing-attachment', 'missing attachment -> clear error')

// case 6: delete one attachment, other unaffected
await deleteAttachment(idA)
assert(!(await existsAttachment(idA)), 'idA gone')
assert(await existsAttachment(idB), 'idB still present')

// vision model check
assert(isVisionModel('deepseek-v4-flash-vision-exp'), 'vision model recognized')
assert(!isVisionModel('deepseek-chat'), 'text model not vision')

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)