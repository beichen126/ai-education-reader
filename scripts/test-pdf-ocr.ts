import 'fake-indexeddb/auto'
import { prepareOcrPages } from '../src/pdf/pdf-ocr-pages'
import assert from 'node:assert/strict'
import { idbClearAll } from '../src/storage/idb'
import { createDocument, listDocumentRecords } from '../src/documents/document-service'
import { ensurePageOcr, readPageOcr } from '../src/documents/document-ocr'
import { recognizeDeepSeekPage } from '../src/api/deepseek-ocr'
import { patchSettings } from '../src/engine/settings-store'
import { saveConversation } from '../src/storage/storage'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft'
import { getDraft, resetDrafts } from '../src/engine/draft-store'
import { getAttachment, toModelAttachment } from '../src/engine/attachment-service'
import { buildApiMessages, countImageParts } from '../src/api/deepseek'
import { buildBackup } from '../src/export/backup-export'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import'
await idbClearAll(); resetDrafts()
await patchSettings({apiBaseUrl:'https://other.example/v1',apiKey:'other-secret',model:'text-model',apiProfiles:[{id:'ds',name:'OCR account',config:{apiBaseUrl:'https://api.deepseek.com',apiKey:'ds-secret',model:'deepseek-flash',visionCapability:'auto'}}]})
const doc=await createDocument({id:'pdf',mimeType:'application/pdf',fileSize:3,fileName:'ocr.pdf',sourceBlob:new Blob(['pdf'],{type:'application/pdf'}),pageCount:3})
let calls=0, mode='success'
globalThis.fetch=async (url, init)=>{
 assert.equal(url,'https://api.deepseek.com/v1/tools/ocr')
 assert.equal((init!.headers as any).Authorization,'Bearer ds-secret')
 assert.deepEqual([...((init!.body as FormData).keys())],['purpose','file'])
 assert.equal((init!.body as FormData).get('purpose'),'text_recognition')
 calls++
 if(mode==='failure')return Response.json({error:{message:'late error'}},{status:200})
 return Response.json({object:'ocr.result',page_count:1,pages:[{index:0,text:'<｜ref｜>Page text '+calls+'<｜/ref｜><｜box｜>[[1,2,3,4]]<｜/box｜>',finish_reason:'stop'}]})
}
let renders=0
const render=async()=>{renders++;return new Blob(['image'],{type:'image/jpeg'})}
const [a,b]=await Promise.all([ensurePageOcr(doc.id,1,render),ensurePageOcr(doc.id,1,render)])
assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(renders,1)
await ensurePageOcr(doc.id,1,render);assert.equal(calls,1)
await Promise.all([ensurePageOcr(doc.id,2,render),ensurePageOcr(doc.id,3,render)])
assert.equal(Object.keys((await listDocumentRecords())[0].meta.ocrPages!).length,3)
mode='failure';await assert.rejects(recognizeDeepSeekPage(await render(),'ds-secret'),/late error/);mode='success'
await saveConversation({id:'chat',title:'test',messages:[],createdAt:1,updatedAt:1})
const count=calls
const result=await addPdfContextToDraft('chat',{documentId:doc.id,fileName:'ocr.pdf',selection:{kind:'manual',ranges:[{startPage:1,endPage:1}],contextMode:'ocr'},pages:[{pageNumber:1,blob:await render(),width:1,height:1,mimeType:'image/jpeg'}]})
assert.equal(result.ok,true);assert.equal(calls,count)
const ids=getDraft('chat').imageIds
assert.equal((await getAttachment(ids[0]))?.ocr?.text,a.text)
const messages=await buildApiMessages([{id:'m',role:'user',content:'question',images:ids,createdAt:1,updatedAt:1}],toModelAttachment)
assert.equal(countImageParts(messages),0);assert.match(JSON.stringify(messages),/Page text 1/);assert.doesNotMatch(JSON.stringify(messages),/box｜/)
assert.equal(getDraft('chat').text,'')
const backup=await buildBackup();parseAndValidate(backup)
assert.equal(backup.documents[0].meta.ocrPages?.[1].text,a.text)
const malformed=structuredClone(backup);malformed.documents[0].meta.ocrPages![1].text=42 as any
assert.throws(()=>parseAndValidate(malformed),/ocrPages/)
await restoreBackup(backup)
assert.equal((await readPageOcr(doc.id,1))?.text,a.text)
await ensurePageOcr(doc.id,1,render);assert.equal(calls,count)
console.log('PASS PDF OCR official key isolation, in-flight dedup, persisted per-page cache, atomic text attachment, backup restore and HTTP 200 errors')

const prepared = await prepareOcrPages(doc.id, { ranges:[{startPage:1,endPage:3}], pageCount:3, renderPage:async()=>{throw new Error('Cached OCR must not render')} })
assert.equal(prepared.pages.length,3)
assert.ok(prepared.pages.every(p=>p.previewDeferred&&p.ocr&&p.blob.size<100))
await assert.rejects(prepareOcrPages(doc.id, { ranges:[{startPage:1,endPage:3}],pageCount:3,renderPage:async()=>{throw new Error('must not render')},isCancelled:()=>true }),/cancelled/)
console.log('PASS cached OCR pages ready without rendering, tiny deferred previews and cancellation')

const deferredCommit=await addPdfContextToDraft('chat',{documentId:doc.id,fileName:'ocr.pdf',selection:{kind:'manual',ranges:[{startPage:1,endPage:3}],contextMode:'ocr'},pages:prepared.pages})
assert.equal(deferredCommit.ok,true)
const deferredBackup=await buildBackup();parseAndValidate(deferredBackup)
assert.ok(deferredBackup.attachments.some(a=>a.meta.source?.previewDeferred&&a.meta.ocr))
console.log('PASS deferred OCR previews retain source ownership in portable backups')
