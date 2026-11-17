import {prepareEmbeddedImages, embeddedImagePayload} from '../src/web-images/embedded'
import {processGenuiSpec,isRenderableProcess} from '../node_modules/@changfenhuang/dsh-genui/src/client/guard.ts'
import 'fake-indexeddb/auto'
import {requestWithImageKeys, configuredImageKeys} from '../src/web-images/key-pool'
import {patchSettings, initSettings, getSettingsSnapshot} from '../src/engine/settings-store'
import {deleteSetting} from '../src/storage/storage'
import assert from 'node:assert/strict'
import {parseImageQueries, WEB_IMAGE_PROMPT, withWebImageCapabilities} from '../src/web-images/protocol'
import {requestFirstImage, searchFirstImage, clearImageSearchRuntime} from '../src/web-images/search'
import {appendGenUiGuidance} from '../src/prompts/prompt-compile-strategies'
import {FULL_GENUI_PROMPT} from '../src/genui/catalog-prompt'
assert.equal(parseImageQueries('{"type":"image","query":"神经元"}').length,1)
assert.equal(parseImageQueries('{"type":"image-group","items":[{"query":"动物细胞"},{"query":"植物细胞"}]}').length,2)
assert.throws(()=>parseImageQueries('{"type":"image-group","items":[{"query":"动物细胞"}]}'))
assert.throws(()=>parseImageQueries('{"type":"image","query":"x"}'))
const messages:any=[{role:'user',content:'hello'}]
appendGenUiGuidance(messages)
assert.ok(!messages[0].content.includes(WEB_IMAGE_PROMPT),'unconfigured model receives no image capability')
assert.ok(FULL_GENUI_PROMPT.includes('使用 genui 代码围栏'))
assert.ok(!FULL_GENUI_PROMPT.includes('"schema":"dsh-genui"'))
const original=globalThis.fetch
try {
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://api.firecrawl.dev/v2/search')
    assert.deepEqual(JSON.parse(init!.body as string),{query:'neuron diagram',sources:['images'],limit:3})
    return Response.json({success:true,data:{images:[{imageUrl:'https://images.example/a.png',url:'https://example.org/source',title:'Neuron'},{imageUrl:'https://images.example/b.png'}]},creditsUsed:2})
  }
  assert.equal((await requestFirstImage('neuron diagram','test')).imageUrl,'https://images.example/a.png')
  globalThis.fetch=async()=>Response.json({success:true,data:{images:[{imageUrl:'javascript:alert(1)',url:'https://example.org'}]}})
  await assert.rejects(requestFirstImage('neuron','test'))
  globalThis.fetch=async()=>new Response('',{status:401})
  await assert.rejects(requestFirstImage('neuron','test'),/Key/)
  await assert.rejects(requestFirstImage('neuron',''),/配置/)
}finally{globalThis.fetch=original}
console.log('PASS simplified GenUI protocol, capability gating, single-result search and URL validation')

const pool=['1','2','3','4'].map(key=>({name:key,key}))
const calls:string[]=[]
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key==='1')throw Object.assign(new Error('quota'),{status:402});return key})
assert.deepEqual(calls,['1','1','1','2'])
calls.length=0
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key!=='1')throw Object.assign(new Error('quota'),{status:402});return key})
assert.deepEqual(calls,['2','2','2','3','3','3','4','4','4','1'],'wraps back to first key')
calls.length=0
await assert.rejects(requestWithImageKeys(pool,async key=>{calls.push(key);throw Object.assign(new Error('quota'),{status:402})}))
assert.equal(calls.length,12,'one cycle is bounded')
calls.length=0
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key==='1')throw new Error('network');return key})
assert.deepEqual(calls,['1','2'],'network failure is not retried as quota')
assert.equal(configuredImageKeys({firecrawlKeys:[...pool,pool[0]]}).length,4)
await patchSettings({firecrawlKeys:pool})
await initSettings()
assert.deepEqual(getSettingsSnapshot().firecrawlKeys,pool)
const enabled:any=[{role:'user',content:'hello'}]
appendGenUiGuidance(enabled)
assert.ok(enabled[0].content.includes(WEB_IMAGE_PROMPT))
assert.ok(!enabled[0].content.includes('Bearer'))
await patchSettings({firecrawlKeys:[],firecrawlApiKey:''})
console.log('PASS 3 quota attempts, persisted rotation, wraparound, bounded failure, network classification and capability enablement')

const embedded = prepareEmbeddedImages({items:[{type:'card',title:'神经系统',items:[{type:'image',query:'人体神经系统 示意图'},{type:'text',content:'说明'}]}]})
assert.ok(isRenderableProcess(processGenuiSpec(embedded)))
assert.equal(JSON.parse(embeddedImagePayload(embedded.items[0].items[0].src)!).query,'人体神经系统 示意图')
console.log('PASS nested image nodes use safe host renderer inside native cards')

assert.ok(withWebImageCapabilities(FULL_GENUI_PROMPT).includes('image: query*:string'))
assert.ok(withWebImageCapabilities('自定义协议').includes('当前阅读器运行时能力'))

// Shared search ownership: one subscriber leaving must not cancel another.
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
let started=0,aborted=0
try {
 globalThis.fetch=async(_url,init)=>new Promise<Response>((resolve,reject)=>{
   started++
   const timer=setTimeout(()=>resolve(Response.json({success:true,data:{images:[{imageUrl:'https://images.example/lifecycle.png',url:'https://example.org/source'}]}})),250)
   init?.signal?.addEventListener('abort',()=>{aborted++;clearTimeout(timer);reject(init.signal!.reason)},{once:true})
 })
 const first=new AbortController(),second=new AbortController()
 const a=searchFirstImage('shared lifecycle',pool,first.signal)
 const rejected=assert.rejects(a,{name:'AbortError'})
 const b=searchFirstImage('shared lifecycle',pool,second.signal)
 await pause(40);first.abort();await rejected;await b
 assert.equal(started,1);assert.equal(aborted,0)
 await searchFirstImage('shared lifecycle',pool)
 assert.equal(started,1,'success is reused')
 const leaving=new AbortController()
 const c=searchFirstImage('cancel lifecycle',pool,leaving.signal)
 const canceled=assert.rejects(c,{name:'AbortError'})
 await pause(40);leaving.abort();await canceled;await pause(200)
 assert.equal(aborted,1,'last subscriber leaving cancels request')
 await searchFirstImage('cancel lifecycle',pool)
 assert.equal(started,3,'canceled query can be requested again')
 const clearing=searchFirstImage('clear lifecycle',pool)
 const cleared=assert.rejects(clearing,{name:'AbortError'})
 await pause(40);await clearImageSearchRuntime();await cleared
 assert.equal(aborted,2,'clearing data stops active work before clearing storage')
 const controller=new AbortController();controller.abort()
 let touched=false
 await assert.rejects(requestWithImageKeys(pool,async()=>{touched=true},controller.signal),{name:'AbortError'})
 assert.equal(touched,false,'canceled queued request never invokes provider')
 let emptyCalls=0
 globalThis.fetch=async()=>{emptyCalls++;return Response.json({success:true,data:{images:[]}})}
 await assert.rejects(searchFirstImage('no results lifecycle',pool),/没有图片/)
 assert.equal(emptyCalls,1,'empty result does not burn through other keys')
}finally{globalThis.fetch=original}
console.log('PASS shared ownership, cancellation, cache reuse, reentry and empty-result lifecycle')
