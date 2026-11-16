import assert from 'node:assert/strict'
import { nativeConversationOptions, citationFooter } from '../src/api/deepseek-native.ts'
import { DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { streamTextChat, buildApiMessages, type ApiChatMessage } from '../src/api/deepseek.ts'
import { uploadDeepSeekDocument, validateDocumentContext } from '../src/api/deepseek-documents.ts'
const settings={...DEFAULT_SETTINGS,model:'deepseek-flash',apiKey:'test',webSearchEnabled:true,userLocation:'杭州'}
const messages:ApiChatMessage[]=[{role:'user',content:'today'}]
const options=nativeConversationOptions(settings,messages,true,new Date(2026,10,16))
assert.equal(messages[0].role,'latest_reminder')
assert.equal(messages[0].content,'2026-11-16,星期一,杭州,Web,中文')
assert.deepEqual(options?.nativeTools,['deepseek_web_search','deepseek_read_url'])
assert.equal(options?.thinking,'enabled');assert.equal(options?.generateTitle,true)
assert.equal(nativeConversationOptions({...settings,apiBaseUrl:'https://teamorouter.com/v1'},[],true),undefined)
assert.equal(nativeConversationOptions({...settings,apiBaseUrl:'https://teamorouter.com/v1',nativeDeepSeekProxy:true},[],false)?.generateTitle,false)
const off:ApiChatMessage[]=[{role:'user',content:'a'}]
assert.deepEqual(nativeConversationOptions({...settings,userMetadataEnabled:false,autoTitleEnabled:false,readUrlEnabled:false,webSearchEnabled:false},off,true),{nativeTools:[],generateTitle:false})
assert.equal(off.length,1)
const original=globalThis.fetch
const calls=[{index:0,calls:[{id:'srvtool-1',signature:'encrypted-page',status:'completed'}]}]
const annotations=[{type:'url_citation',url_citation:{url:'https://example.com/page',title:'Source',start_index:0,end_index:2}}]
try {
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(init?.body as string)
  assert.equal(body.title.enabled,true);assert.equal(body.thinking.type,'enabled')
  assert.equal(body.tools[0].type,'deepseek_web_search')
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Answer'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{title:'Short title',annotations,server_tool_calls:calls},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
 }
 const result=await streamTextChat({apiKey:'test',baseUrl:settings.apiBaseUrl,model:settings.model,messages,...options,onDelta:()=>{}})
 assert.equal(result.title,'Short title');assert.deepEqual(result.serverToolCalls,calls);assert.deepEqual(result.annotations,annotations)
 assert.match(citationFooter(result.annotations),/https:\/\/example.com\/page/)
 assert.equal(citationFooter([{type:'url_citation',url_citation:{url:'javascript:alert(1)'}}]),'')
 globalThis.fetch=async(_url,init)=>{
  const body=init?.body as FormData
  assert.equal([...body.keys()][0],'purpose');assert.equal(body.get('purpose'),'rich_layout_recognition')
  return Response.json({id:'file-api-test',expires_at:Date.now()/1000+3600})
 }
 const doc=await uploadDeepSeekDocument(new File(['pdf'],'lesson.pdf'),{baseUrl:settings.apiBaseUrl,apiKey:'test',rich:true,signal:new AbortController().signal})
 validateDocumentContext([doc],settings.apiBaseUrl,settings.model)
 assert.throws(()=>validateDocumentContext(Array(21).fill(doc),settings.apiBaseUrl,settings.model),/20/)
 assert.throws(()=>validateDocumentContext([{...doc,expiresAt:0}],settings.apiBaseUrl,settings.model),/过期/)
 const context=await buildApiMessages([{id:'1',role:'user',content:'read',documents:[doc],images:[],createdAt:0,updatedAt:0},{id:'2',role:'assistant',content:'answer',serverToolCalls:calls,images:[],createdAt:0,updatedAt:0}],async()=>{throw Error('unexpected')})
 assert.deepEqual((context[0].content as any[])[0],{type:'file',file_id:doc.id});assert.deepEqual(context[1].server_tool_calls,calls)
} finally {globalThis.fetch=original}
console.log('PASS native metadata, tools, title stream, citations, document upload and multi-turn references')
