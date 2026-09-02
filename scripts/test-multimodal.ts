import 'fake-indexeddb/auto'
import { newStableId } from '../src/engine/types.ts'
import { saveAttachment, saveConversation, getAnnotationsByMessage } from '../src/storage/storage.ts'
import { buildApiMessages, buildRequestMessages, countImageParts } from '../src/api/deepseek.ts'
import { toDataUrl } from '../src/engine/attachment-service.ts'
import type { Message, Attachment, Conversation } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function mb(n:number){ return (n/1024/1024).toFixed(3)+' MiB' }

// Build N distinct attachments (each with a unique byte pattern so we can verify identity/order).
async function seedAttachments(n:number){
  const ids:string[]=[]
  const meta:Attachment[]=[]
  for(let i=0;i<n;i++){
    const id=newStableId()
    // 4 KiB each, byte 0 = i (index marker), rest a simple fill -> distinguishable
    const buf=new Uint8Array(4096); buf[0]=i; buf[1]=i>>>8; for(let j=2;j<buf.length;j++) buf[j]=(i*31+j)%256
    await saveAttachment({ id, name:'img'+i+'.png', mimeType:'image/png', size:buf.length, createdAt:1, updatedAt:1 }, new Blob([buf],{type:'image/png'}))
    ids.push(id); meta.push({ id, name:'img'+i+'.png', mimeType:'image/png', size:buf.length, createdAt:1, updatedAt:1 })
  }
  return { ids, meta }
}

// Count image_url parts across a message list.
function imageInfo(msgs:any[]){
  let totalImage=0; const perUser:{role:string;img:number;order:string[]}[]=[]
  for(const m of msgs){
    if(Array.isArray(m.content)){
      const imgs=m.content.filter((p:any)=>p.type==='image_url')
      totalImage+=imgs.length
      // extract the index marker from each data URL (first byte of raw)
      const order=imgs.map((p:any)=>{ const b64=p.image_url.url.slice(p.image_url.url.indexOf('base64,')+7); const buf=Buffer.from(b64,'base64'); return buf[0] })
      perUser.push({ role:m.role, img:imgs.length, order })
    }
  }
  return { totalImage, perUser }
}

console.log('=== deterministic 11-image multimodal pipeline ===')
const N=11
const { ids, meta } = await seedAttachments(N)
assert(ids.length===N, 'seeded '+N+' attachments')

// User message referencing all N in order.
const userMsg:Message = { id:'u1', role:'user', content:'请逐张读取图片编号。', images: ids, createdAt:1, updatedAt:1 }
// One historical user message with 3 images to exercise history re-send.
const { ids:histIds } = await seedAttachments(3)
const histMsg:Message = { id:'h1', role:'user', content:'前文图片', images: histIds, createdAt:1, updatedAt:1 }
const assistantMsg:Message = { id:'a1', role:'assistant', content:'前文助手回复', images:[], createdAt:1, updatedAt:1 }

const allMessages:Message[] = [histMsg, assistantMsg, userMsg]

// Wrap toDataUrl to count success/failure per id.
let toDataOk=0, toDataFail=0; const sizeTable:any[]=[]
const countingToDataUrl = async (id:string)=>{
  try { const url:string = await toDataUrl(id); toDataOk++
    const rawLen = url.length>0 && url.startsWith('data:') ? Math.round((url.length - url.indexOf(',') - 1)*0.75) : 0
    sizeTable.push({ id: id.slice(0,8), urlBytes: url.length, rawEst: rawLen })
    return url
  } catch(e){ toDataFail++; throw e }
}

const apiMessages = await buildApiMessages(allMessages, countingToDataUrl)
assert(toDataOk===N+3 && toDataFail===0, 'toDataUrl success='+toDataOk+' failure='+toDataFail+' (expect all)')
const info = imageInfo(apiMessages)
assert(info.totalImage === N+3, 'buildApiMessages total image parts = '+(N+3)+' (current 11 + history 3)')
const current = info.perUser[info.perUser.length-1]
assert(current.img === N, 'current user message image parts = '+N)
// decode each seeded raw content's byte[0] = index marker, compare to content-part order
async function rawFirstByte(id:string){ const url=await toDataUrl(id); const b64=url.slice(url.indexOf('base64,')+7); return Buffer.from(b64,'base64')[0] }
const expectedOrder:string[]=[]; for(const id of ids) expectedOrder.push(String(await rawFirstByte(id)))
const exactOrder = current.order.join(',')
assert(exactOrder === expectedOrder.join(','), 'current message image order preserved in content parts (content order === upload order)')
assert(new Set(current.order).size===N, 'current message '+N+' unique image parts')
// identity labels: current message should interleave 【图片 k/N】 before each image.
const labelParts = (apiMessages[apiMessages.length-1] as any).content.filter((p:any)=>p.type==='text').map((p:any)=>p.text)
const imgCountInCurrent = (apiMessages[apiMessages.length-1] as any).content.filter((p:any)=>p.type==='image_url').length
const expectedLabels:string[]=[]; for(let k=1;k<=N;k++) expectedLabels.push('【图片 '+k+'/'+N+'】')
const labelsMatch = expectedLabels.every((x,i)=>labelParts.includes(x))
assert(imgCountInCurrent===N, 'current message image parts still '+N+' after labels')
assert(labelsMatch, 'current message has '+N+' 【图片 k/'+N+'】 identity labels')
assert(countImageParts(apiMessages)===N+3, 'countImageParts = '+N+' current + 3 history')
// invariant chain: expected images === encoded images (image count unchanged by system prepend)
const expected = allMessages.reduce((s:number,m:any)=>s+(m.images?m.images.length:0),0)
assert(expected === countImageParts(apiMessages), 'send invariant: expectedImages '+expected+' === encodedImages '+countImageParts(apiMessages))

// buildRequestMessages with system prompt must not change counts.
const reqMessages = buildRequestMessages(apiMessages, { customSystemPrompt:'你是助手', customSystemPromptEnabled:true })
const info2 = imageInfo(reqMessages)
assert(info2.totalImage === N+3 && reqMessages[0].role==='system', 'buildRequestMessages keeps '+info2.totalImage+' image parts, prepends system (no truncation)')
assert(info2.perUser.length === 2, 'system prepend does not alter the 2 user messages')

// final request body size.
const bodyObj = { model:'deepseek-vl', messages: reqMessages, stream:true }
const bodyStr = JSON.stringify(bodyObj)
const bodyBytes = Buffer.byteLength(bodyStr, 'utf8')
console.log('  final JSON request body = '+mb(bodyBytes)+' ('+bodyBytes+' bytes)')
const totalRaw = sizeTable.reduce((s,x)=>s+x.rawEst,0)
const totalUrl = sizeTable.reduce((s,x)=>s+x.urlBytes,0)
console.log('  attachments raw est total = '+mb(totalRaw))
console.log('  dataURL chars total      = '+mb(totalUrl))
assert(bodyBytes>0, 'body size computed')

// per-image diagnostic table (§10) — only id/mime/bytes, NO base64 content.
console.log('\n  per-image diagnostic (id / mime / raw est / dataURL chars)')
for(const row of sizeTable) console.log('    '+row.id+' / image/png / '+row.rawEst+' B / '+row.urlBytes+' B')

// missing attachment -> must throw (no silent skip).
let threw=false
try { await buildApiMessages([{ id:'u2', role:'user', content:'x', images:['nonexistent-id'], createdAt:1, updatedAt:1 } as any], toDataUrl) } catch(e){ threw=true }
assert(threw, 'missing attachment => buildApiMessages throws (no silent skip)')

console.log('\n=== chain summary ===')
console.log('Selected/Saved attachments: '+N)
console.log('Message.images: '+ids.length+'  (unique '+new Set(ids).size+')')
console.log('toDataUrl success: '+toDataOk+'  failure: '+toDataFail)
console.log('Current-message API images: '+info.totalImage+ ' -> current '+current.img+', history '+(info.totalImage-current.img))
console.log('Final JSON body: '+bodyBytes+' bytes ('+mb(bodyBytes)+')')
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)